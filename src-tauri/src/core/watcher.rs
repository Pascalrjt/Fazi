//! Directory watching: FSEvents via `notify` + debouncer (~150 ms batches).
//! Batches are mapped to name-level deltas relative to the watched dir; the
//! frontend re-stats upserted names and drops removed ones.

use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum WatchEvent {
    #[serde(rename_all = "camelCase")]
    Batch {
        upserted: Vec<String>,
        removed: Vec<String>,
        rescan: bool,
        /// The watched volume distinguishes `foo` from `Foo`: the frontend
        /// must not merge case variants into one row.
        case_sensitive: bool,
    },
    RootGone,
}

/// `NoCache`: the default file-id cache stats every entry of the watched
/// directory up front (on the main thread, via `watch_dir`) — ~0.5 s for a
/// 100k-entry folder on a fresh mount — only to pair rename events by file
/// id. `map_events` classifies by existence instead, so it needs no ids.
pub type DirDebouncer = Debouncer<RecommendedWatcher, NoCache>;

/// Start watching `root` (non-recursive). `send` receives debounced batches.
pub fn watch(
    root: PathBuf,
    send: impl Fn(WatchEvent) + Send + 'static,
) -> notify::Result<DirDebouncer> {
    // FSEvents reports canonical paths (/private/var/… for /var/…) — watch
    // and compare against the canonical root or deltas silently vanish.
    let root = std::fs::canonicalize(&root).unwrap_or(root);
    let watched = root.clone();
    // Fixed per volume: decide once, not per batch.
    let case_sensitive = is_case_sensitive(&root);
    let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
        Duration::from_millis(150),
        None,
        move |result: DebounceEventResult| match result {
            Ok(events) => {
                let changes = events.iter().flat_map(|e| {
                    let renamed = matches!(
                        e.kind,
                        notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
                    );
                    e.paths.iter().map(move |p| (p, renamed))
                });
                if let Some(batch) = map_changes(&watched, changes, case_sensitive, probe_child) {
                    send(batch);
                }
            }
            Err(_) => {
                // Watcher errors (queue overflow etc.): ask the UI to re-list.
                send(WatchEvent::Batch {
                    upserted: Vec::new(),
                    removed: Vec::new(),
                    rescan: true,
                    case_sensitive,
                });
            }
        },
        NoCache,
        notify::Config::default(),
    )?;
    debouncer.watch(&root, RecursiveMode::NonRecursive)?;
    Ok(debouncer)
}

/// What one changed direct child looks like on disk right now.
#[derive(Debug, PartialEq, Eq)]
pub enum Probe {
    /// The exact spelling exists.
    Exact,
    /// No entry by that name, under any spelling the filesystem resolves.
    Missing,
    /// Something resolves under that name but its stored spelling differs
    /// (stale-cased rename on APFS), or the probe failed: reconcile against
    /// the real dirent spellings.
    Unsure,
}

/// One syscall per changed path: `getattrlist(ATTR_CMN_NAME, NOFOLLOW)`
/// returns the name as stored in the directory, which lets us tell
/// `root/foo` (exact) apart from `root/Foo` resolved case-insensitively.
pub fn probe_child(path: &Path, name: &str) -> Probe {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return Probe::Unsure;
    };
    let mut req: libc::attrlist = unsafe { std::mem::zeroed() };
    req.bitmapcount = libc::ATTR_BIT_MAP_COUNT;
    req.commonattr = libc::ATTR_CMN_NAME;
    // u32 length + attrreference_t + up to 255 UTF-16 units as UTF-8 + NUL.
    let mut buf = [0u8; 4 + 8 + 1024];
    let rc = unsafe {
        libc::getattrlist(
            c.as_ptr(),
            (&mut req as *mut libc::attrlist).cast(),
            buf.as_mut_ptr().cast(),
            buf.len(),
            libc::FSOPT_NOFOLLOW,
        )
    };
    if rc != 0 {
        return match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::ENOENT) => Probe::Missing,
            _ => Probe::Unsure,
        };
    }
    let off = i32::from_ne_bytes([buf[4], buf[5], buf[6], buf[7]]);
    let len = u32::from_ne_bytes([buf[8], buf[9], buf[10], buf[11]]) as usize;
    let start = 4usize.saturating_add_signed(off as isize);
    let Some(stored) = buf.get(start..start + len.saturating_sub(1)) else {
        return Probe::Unsure;
    };
    if stored == name.as_bytes() {
        Probe::Exact
    } else {
        Probe::Unsure
    }
}

/// Real dirent spellings of the root, read only when a probe is unsure.
struct Spellings {
    exact: std::collections::HashSet<String>,
    /// Lower-cased name → every spelling present (several on case-sensitive
    /// volumes: `foo` and `FOO` may coexist).
    case_folded: std::collections::HashMap<String, Vec<String>>,
}

thread_local! {
    static SNAPSHOT_FALLBACKS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Full read_dir fallbacks `map_events` took on the calling thread
/// (tests/benchmarks).
pub fn snapshot_fallbacks() -> usize {
    SNAPSHOT_FALLBACKS.with(|c| c.get())
}

fn read_names(root: &Path) -> std::io::Result<Vec<String>> {
    Ok(std::fs::read_dir(root)?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect())
}

fn snapshot(
    root: &Path,
    read_names: &impl Fn(&Path) -> std::io::Result<Vec<String>>,
) -> std::io::Result<Spellings> {
    SNAPSHOT_FALLBACKS.with(|c| c.set(c.get() + 1));
    let actual_names = read_names(root)?;
    let mut case_folded = std::collections::HashMap::new();
    for actual in &actual_names {
        case_folded.entry(actual.to_lowercase()).or_insert_with(Vec::new).push(actual.clone());
    }
    Ok(Spellings { exact: actual_names.into_iter().collect(), case_folded })
}

/// Whether names on `root`'s volume are case-sensitive (pathconf; APFS and
/// HFS+ default to insensitive). Unknown → assume sensitive, which only
/// costs an occasional directory read on renames.
pub fn is_case_sensitive(root: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(root.as_os_str().as_bytes()) else {
        return true;
    };
    unsafe { libc::pathconf(c.as_ptr(), libc::_PC_CASE_SENSITIVE) != 0 }
}

/// [`map_changes`] for paths without event flags: every path is treated as
/// possibly renamed, and the volume's case sensitivity is probed.
pub fn map_events<'a>(
    root: &Path,
    paths: impl Iterator<Item = &'a PathBuf>,
) -> Option<WatchEvent> {
    map_changes(root, paths.map(|p| (p, true)), is_case_sensitive(root), probe_child)
}

/// Classify affected paths by what's true *now*: existing paths in the root
/// are upserts, missing ones are removals. Robust across rename semantics.
///
/// `changes` pairs each event path with whether its event was a rename.
///
/// Cost scales with the batch, not the directory: event paths are filtered
/// to direct children first and probed one syscall each; the root is read
/// (once, lazily) only when a probe can't settle the exact spelling — or, on
/// case-sensitive volumes, when a renamed path is missing: a case-only
/// rename foo → Foo may surface only the stale `foo`, which probes as gone
/// there, so the dirents are consulted for its new spelling.
pub fn map_changes<'a>(
    root: &Path,
    changes: impl Iterator<Item = (&'a PathBuf, bool)>,
    case_sensitive: bool,
    probe: impl Fn(&Path, &str) -> Probe,
) -> Option<WatchEvent> {
    map_changes_with(root, changes, case_sensitive, probe, read_names)
}

/// [`map_changes`] with the directory listing injected (tests can present
/// case-variant siblings a case-insensitive test volume can't hold).
fn map_changes_with<'a>(
    root: &Path,
    changes: impl Iterator<Item = (&'a PathBuf, bool)>,
    case_sensitive: bool,
    probe: impl Fn(&Path, &str) -> Probe,
    read_names: impl Fn(&Path) -> std::io::Result<Vec<String>>,
) -> Option<WatchEvent> {
    let mut root_gone = false;
    let mut seen = std::collections::HashSet::new();
    let mut names: Vec<(&'a PathBuf, String, bool)> = Vec::new();
    // Rename flags of one path may arrive on another event of the batch.
    let mut renamed_names = std::collections::HashSet::new();
    for (p, renamed) in changes {
        if p == root {
            if p.symlink_metadata().is_err() {
                root_gone = true;
            }
            continue;
        }
        if p.parent() != Some(root) {
            continue; // non-recursive watch can still surface deeper paths
        }
        let Some(name) = p.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        if renamed {
            renamed_names.insert(name.clone());
        }
        if seen.insert(name.clone()) {
            names.push((p, name, false));
        }
    }
    for (_, name, renamed) in names.iter_mut() {
        *renamed = renamed_names.contains(name.as_str());
    }
    if root_gone {
        return Some(WatchEvent::RootGone);
    }
    if names.is_empty() {
        return None;
    }

    let mut upserted = Vec::new();
    let mut removed = Vec::new();
    let mut spellings: Option<Spellings> = None;
    let mut checked_root = false;
    for (p, name, renamed) in names {
        let reconcile = match probe(p, &name) {
            Probe::Exact => {
                upserted.push(name);
                continue;
            }
            Probe::Missing => {
                // Children vanishing can mean the root itself went away.
                if !checked_root {
                    checked_root = true;
                    if root.symlink_metadata().is_err() {
                        return Some(WatchEvent::RootGone);
                    }
                }
                if !(renamed && case_sensitive) {
                    // Fast path: on case-insensitive volumes a stale-cased
                    // name resolves (Unsure), so Missing is final.
                    removed.push(name);
                    continue;
                }
                false
            }
            // APFS commonly resolves a stale-cased path after foo -> Foo,
            // so only the parent's actual dirent spellings can tell
            // whether that exact entry still exists.
            Probe::Unsure => true,
        };
        if spellings.is_none() {
            match snapshot(root, &read_names) {
                Ok(s) => spellings = Some(s),
                Err(_) if root.symlink_metadata().is_err() => {
                    return Some(WatchEvent::RootGone);
                }
                Err(_) if !reconcile => {
                    // Only a best-effort case lookup failed: the probe
                    // already settled the removal.
                    removed.push(name);
                    continue;
                }
                Err(_) => {
                    return Some(WatchEvent::Batch {
                        upserted: Vec::new(),
                        removed: Vec::new(),
                        rescan: true,
                        case_sensitive,
                    });
                }
            }
        }
        let s = spellings.as_ref().expect("snapshot taken");
        if reconcile && s.exact.contains(name.as_str()) {
            upserted.push(name);
        } else {
            // A stale-cased rename event may be the only path FSEvents
            // gives us. Reconcile it to the actual spelling so
            // external case-only renames still produce the row.
            // Which variant is the renamed one is unknowable when several
            // exist: upsert them all (each re-stat is idempotent), so none
            // is lost.
            for actual in s.case_folded.get(&name.to_lowercase()).into_iter().flatten() {
                if actual != &name && seen.insert(actual.clone()) {
                    upserted.push(actual.clone());
                }
            }
            removed.push(name);
        }
    }

    if upserted.is_empty() && removed.is_empty() {
        return None;
    }
    Some(WatchEvent::Batch { upserted, removed, rescan: false, case_sensitive })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn stale_case_event_uses_exact_dirent_spelling() {
        let root = std::env::temp_dir().join(format!(
            "fazi-watch-case-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("Foo"), b"x").unwrap();
        let stale = root.join("foo");

        let event = map_events(&root, std::iter::once(&stale)).unwrap();
        match event {
            WatchEvent::Batch { upserted, removed, rescan, .. } => {
                assert!(!rescan);
                assert_eq!(removed, vec!["foo"]);
                assert_eq!(upserted, vec!["Foo"]);
            }
            other => panic!("unexpected event: {other:?}"),
        }
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn case_sensitive_stale_only_rename_reconciles_to_the_new_spelling() {
        let root = tmp_root("case-sens");
        std::fs::write(root.join("Foo"), b"x").unwrap();
        std::fs::write(root.join("bar"), b"x").unwrap();
        let stale = root.join("foo");
        let gone = root.join("gone.txt");
        // A case-sensitive volume reports the stale spelling as ENOENT.
        let probe = |p: &Path, name: &str| {
            if name == "foo" { Probe::Missing } else { probe_child(p, name) }
        };

        let before = snapshot_fallbacks();
        let event = map_changes(&root, [(&stale, true)].into_iter(), true, probe).unwrap();
        assert_eq!(snapshot_fallbacks(), before + 1);
        match event {
            WatchEvent::Batch { upserted, removed, rescan, .. } => {
                assert!(!rescan);
                assert_eq!(removed, vec!["foo"]);
                assert_eq!(upserted, vec!["Foo"]);
            }
            other => panic!("unexpected event: {other:?}"),
        }

        // Fast paths: plain deletes, and renames on case-insensitive
        // volumes, never read the directory.
        let before = snapshot_fallbacks();
        for (renamed, sensitive) in [(false, true), (true, false)] {
            let event =
                map_changes(&root, [(&gone, renamed)].into_iter(), sensitive, probe).unwrap();
            match event {
                WatchEvent::Batch { upserted, removed, .. } => {
                    assert!(upserted.is_empty());
                    assert_eq!(removed, vec!["gone.txt"]);
                }
                other => panic!("unexpected event: {other:?}"),
            }
        }
        assert_eq!(snapshot_fallbacks(), before);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ambiguous_case_variants_are_all_upserted() {
        let root = tmp_root("case-variants");
        let stale = root.join("foo");
        // Case-sensitive volume holding FOO and (after foo -> Foo) Foo.
        let listing = |_: &Path| Ok(vec!["FOO".to_string(), "Foo".to_string(), "bar".to_string()]);
        let event = map_changes_with(
            &root,
            [(&stale, true)].into_iter(),
            true,
            |_: &Path, _: &str| Probe::Missing,
            listing,
        )
        .unwrap();
        match event {
            WatchEvent::Batch { mut upserted, removed, rescan, case_sensitive } => {
                assert!(!rescan);
                assert!(case_sensitive);
                assert_eq!(removed, vec!["foo"]);
                upserted.sort();
                assert_eq!(upserted, vec!["FOO", "Foo"], "the renamed variant is never lost");
            }
            other => panic!("unexpected event: {other:?}"),
        }
        std::fs::remove_dir_all(&root).ok();
    }

    fn tmp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("fazi-watch-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // FSEvents-style canonical root (/private/var/… for /var/…).
        std::fs::canonicalize(&root).unwrap()
    }

    #[test]
    fn probe_distinguishes_exact_missing_and_stale_case() {
        let root = tmp_root("probe");
        std::fs::write(root.join("Foo"), b"x").unwrap();
        assert_eq!(probe_child(&root.join("Foo"), "Foo"), Probe::Exact);
        assert_eq!(probe_child(&root.join("nope"), "nope"), Probe::Missing);
        // Case-insensitive volumes resolve "foo" to "Foo"; case-sensitive
        // ones report it missing. Either way it is never "exact".
        assert_ne!(probe_child(&root.join("foo"), "foo"), Probe::Exact);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn plain_batches_filter_first_and_never_read_the_whole_dir() {
        let root = tmp_root("filter");
        for i in 0..200 {
            std::fs::write(root.join(format!("f{i}")), b"x").unwrap();
        }
        let sub = root.join("sub");
        std::fs::create_dir(&sub).unwrap();
        let mut paths: Vec<PathBuf> = (0..5).map(|i| root.join(format!("f{i}"))).collect();
        paths.push(root.join("gone.txt"));
        paths.push(sub.join("deep.txt")); // deeper path: ignored
        paths.push(root.join("f0")); // duplicate: ignored
        let before = snapshot_fallbacks();
        let event = map_changes(&root, paths.iter().map(|p| (p, true)), false, probe_child).unwrap();
        let after = snapshot_fallbacks();
        match event {
            WatchEvent::Batch { upserted, removed, rescan, .. } => {
                assert!(!rescan);
                assert_eq!(upserted, vec!["f0", "f1", "f2", "f3", "f4"]);
                assert_eq!(removed, vec!["gone.txt"]);
            }
            other => panic!("unexpected event: {other:?}"),
        }
        assert_eq!(after, before, "exact names need no read_dir");
        // Only deeper paths → nothing to report, no syscalls on the root.
        assert!(map_events(&root, std::iter::once(&sub.join("x"))).is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn vanished_root_is_reported() {
        let root = tmp_root("gone");
        std::fs::write(root.join("a"), b"x").unwrap();
        let child = root.join("a");
        std::fs::remove_dir_all(&root).unwrap();
        assert!(matches!(map_events(&root, std::iter::once(&child)), Some(WatchEvent::RootGone)));
        assert!(matches!(map_events(&root, std::iter::once(&root)), Some(WatchEvent::RootGone)));
    }

    #[test]
    #[ignore = "FSEvents delivery is flaky in sandboxed environments; run with cargo test -- --ignored"]
    fn renames_arrive_as_remove_plus_upsert_without_a_file_id_cache() {
        let root = std::env::temp_dir().join(format!("fazi-watch-rn-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("before.txt"), b"x").unwrap();
        std::thread::sleep(Duration::from_millis(300)); // let the create settle

        let (tx, rx) = mpsc::channel();
        let _guard = watch(root.clone(), move |e| {
            let _ = tx.send(e);
        })
        .unwrap();
        std::fs::rename(root.join("before.txt"), root.join("after.txt")).unwrap();

        // The two sides may land in one batch or two.
        let (mut removed, mut upserted) = (Vec::new(), Vec::new());
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !(removed.contains(&"before.txt".to_string())
            && upserted.contains(&"after.txt".to_string()))
        {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match rx.recv_timeout(left).expect("rename not reported") {
                WatchEvent::Batch { upserted: u, removed: r, .. } => {
                    upserted.extend(u);
                    removed.extend(r);
                }
                other => panic!("unexpected: {:?}", other),
            }
        }
        assert!(!upserted.contains(&"before.txt".to_string()));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    #[ignore = "FSEvents delivery is flaky in sandboxed environments; run with cargo test -- --ignored"]
    fn batches_arrive_for_create_and_remove() {
        let root = std::env::temp_dir().join(format!("fazi-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let (tx, rx) = mpsc::channel();
        let _guard = watch(root.clone(), move |e| {
            let _ = tx.send(e);
        })
        .unwrap();

        std::fs::write(root.join("created.txt"), b"x").unwrap();

        // Generous timeout — FSEvents latency + debounce.
        let evt = rx.recv_timeout(Duration::from_secs(10)).expect("no watch event");
        match evt {
            WatchEvent::Batch { upserted, .. } => {
                assert!(upserted.contains(&"created.txt".to_string()), "{:?}", upserted);
            }
            other => panic!("unexpected: {:?}", other),
        }

        std::fs::remove_file(root.join("created.txt")).unwrap();
        let evt = rx.recv_timeout(Duration::from_secs(10)).expect("no removal event");
        match evt {
            WatchEvent::Batch { removed, .. } => {
                assert!(removed.contains(&"created.txt".to_string()), "{:?}", removed);
            }
            other => panic!("unexpected: {:?}", other),
        }

        std::fs::remove_dir_all(&root).ok();
    }
}
