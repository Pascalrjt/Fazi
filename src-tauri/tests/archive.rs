//! End-to-end tests for the archive engine (compress via ditto, extract via
//! ditto/bsdtar). These drive `spawn_compress`/`spawn_extract` exactly as the
//! IPC layer does and assert the plan's contracts: all-or-nothing compress,
//! Finder-compatible zip layouts, per-archive extract with validation as the
//! promotion gate, honest progress, and clean staging on every exit path.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use fazi_lib::core::archive::{spawn_compress, spawn_extract};
use fazi_lib::core::journal::{Journal, OpJournalEntry};
use fazi_lib::core::op_queue::{Engine, OpEmitter, OpEvent};
use fazi_lib::core::undo::UndoStack;
use fazi_lib::core::walker::DirTrasher;

// ---------------------------------------------------------------------------
// Harness (mirrors tests/engine.rs)
// ---------------------------------------------------------------------------

struct Collector {
    events: Mutex<Vec<OpEvent>>,
    done: std::sync::Condvar,
}

#[derive(Clone)]
struct TestEmitter(Arc<Collector>);

impl OpEmitter for TestEmitter {
    fn emit(&self, e: OpEvent) {
        let mut events = self.0.events.lock().unwrap();
        let is_done = matches!(e, OpEvent::Done { .. });
        events.push(e);
        if is_done {
            self.0.done.notify_all();
        }
    }
}

impl TestEmitter {
    fn new() -> Self {
        TestEmitter(Arc::new(Collector {
            events: Mutex::new(Vec::new()),
            done: std::sync::Condvar::new(),
        }))
    }

    fn wait_done(&self, timeout: Duration) -> Vec<OpEvent> {
        let deadline = Instant::now() + timeout;
        let mut events = self.0.events.lock().unwrap();
        while !events.iter().any(|e| matches!(e, OpEvent::Done { .. })) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "op did not complete in time: {:?}", *events);
            let (guard, _) = self.0.done.wait_timeout(events, remaining).unwrap();
            events = guard;
        }
        events.clone()
    }
}

struct Env {
    root: PathBuf,
    engine: Arc<Engine>,
    trash_dir: PathBuf,
}

fn env(name: &str) -> Env {
    let root = std::env::temp_dir().join(format!("fazi-archive-e2e-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let trash_dir = root.join(".test-trash");
    let engine = Arc::new(Engine {
        trasher: Arc::new(DirTrasher(trash_dir.clone())),
        journal: Arc::new(Journal::new(root.join(".journal")).unwrap()),
        undo: Arc::new(Mutex::new(UndoStack::default())),
        ops: DashMap::new(),
        volume_locks: DashMap::new(),
        icon_token: Arc::new(|_, _| String::new()),
        verify_copy_contents: Arc::new(|src, dst, cancelled| {
            fazi_lib::core::verify::checksum_compare(src, dst, cancelled)
        }),
    });
    Env { root, engine, trash_dir }
}

fn done_of(events: &[OpEvent]) -> (&'static str, Vec<(String, String)>, Vec<String>, bool) {
    for e in events {
        if let OpEvent::Done { status, errors, produced, undoable, .. } = e {
            return (
                status,
                errors.iter().map(|e| (e.path.clone(), e.message.clone())).collect(),
                produced.clone(),
                *undoable,
            );
        }
    }
    panic!("no Done event: {:?}", events);
}

fn progress_entry_counts(events: &[OpEvent]) -> Vec<u64> {
    events
        .iter()
        .filter_map(|e| match e {
            OpEvent::Progress { entries_done, .. } => Some(*entries_done),
            _ => None,
        })
        .collect()
}

/// Assert no `.fazi-partial-` staging artifact anywhere under `root`.
fn assert_staging_free(root: &Path) {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                out.push(e.path());
                let p = e.path();
                if p.is_dir() && !p.is_symlink() {
                    walk(&p, out);
                }
            }
        }
    }
    let mut all = Vec::new();
    walk(root, &mut all);
    for p in all {
        let name = p.file_name().unwrap_or_default().to_string_lossy().into_owned();
        assert!(
            !name.contains(".fazi-partial-"),
            "staging artifact left behind: {}",
            p.display()
        );
    }
}

fn names_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// Independently list a zip's layout by extracting with plain ditto.
fn zip_layout(zip: &Path, scratch: &Path) -> Vec<String> {
    let out = scratch.join("zip-layout-probe");
    let _ = std::fs::remove_dir_all(&out);
    std::fs::create_dir_all(&out).unwrap();
    let status = Command::new("/usr/bin/ditto")
        .arg("-x")
        .arg("-k")
        .arg(zip)
        .arg(&out)
        .status()
        .unwrap();
    assert!(status.success(), "probe extraction failed for {}", zip.display());
    names_in(&out)
}

fn have_python() -> bool {
    Command::new("/usr/bin/python3")
        .arg("-c")
        .arg("1")
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn python_zip(script: &str) {
    let status = Command::new("/usr/bin/python3").arg("-c").arg(script).status().unwrap();
    assert!(status.success(), "python zip helper failed");
}

/// Make a normal zip from a directory's CONTENTS (entries at zip root).
fn ditto_zip_contents(dir: &Path, zip: &Path) {
    let status = Command::new("/usr/bin/ditto")
        .arg("-c")
        .arg("-k")
        .arg(dir)
        .arg(zip)
        .status()
        .unwrap();
    assert!(status.success());
}

const T: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------
// Compress
// ---------------------------------------------------------------------------

#[test]
fn single_file_compress_extract_round_trip() {
    let e = env("roundtrip");
    let src_dir = e.root.join("src");
    std::fs::create_dir_all(&src_dir).unwrap();
    std::fs::write(src_dir.join("Report.pdf"), b"pdf-bytes").unwrap();

    let emitter = TestEmitter::new();
    spawn_compress(
        e.engine.clone(),
        "op-c1".into(),
        vec![src_dir.join("Report.pdf")],
        src_dir.clone(),
        Arc::new(emitter.clone()),
    );
    let events = emitter.wait_done(T);
    let (status, errors, produced, undoable) = done_of(&events);
    assert_eq!(status, "success", "{:?}", errors);
    assert!(undoable);
    // Exact zip name next to the source.
    assert_eq!(produced, vec![src_dir.join("Report.pdf.zip").to_string_lossy().into_owned()]);
    assert!(src_dir.join("Report.pdf.zip").exists());
    // Journal clear, no staging leftovers.
    assert!(e.engine.journal.recover().is_empty());
    assert_staging_free(&e.root);
    // Undo top is a typed ProducedItems with the Compress label.
    assert_eq!(
        e.engine.undo.lock().unwrap().undo_top().unwrap().label(),
        "Compress of 1 Item"
    );
    assert_eq!(e.engine.undo.lock().unwrap().undo_top().unwrap().kind_wire(), "compress");

    // Extract into a fresh dir: single-entry promotion uses the INNER name.
    let out_dir = e.root.join("out");
    std::fs::create_dir_all(&out_dir).unwrap();
    let em2 = TestEmitter::new();
    spawn_extract(
        e.engine.clone(),
        "op-x1".into(),
        vec![src_dir.join("Report.pdf.zip")],
        out_dir.clone(),
        Arc::new(em2.clone()),
    );
    let events = em2.wait_done(T);
    let (status, errors, produced, undoable) = done_of(&events);
    assert_eq!(status, "success", "{:?}", errors);
    assert!(undoable);
    assert_eq!(produced, vec![out_dir.join("Report.pdf").to_string_lossy().into_owned()]);
    assert_eq!(std::fs::read(out_dir.join("Report.pdf")).unwrap(), b"pdf-bytes");
    assert!(e.engine.journal.recover().is_empty());
    assert_staging_free(&e.root);
    assert_eq!(
        e.engine.undo.lock().unwrap().undo_top().unwrap().label(),
        "Extract of 1 Item"
    );

    // ⌘Z after compress-equivalent: undoing the extract trashes the output.
    let out = e.engine.undo.lock().unwrap().undo(&DirTrasher(e.trash_dir.clone())).unwrap().unwrap();
    assert_eq!(out.label, "Extract of 1 Item");
    assert!(!out_dir.join("Report.pdf").exists());
    std::fs::remove_dir_all(&e.root).ok();
}

#[test]
fn zip_root_layouts_match_finder() {
    let e = env("layout");
    let work = e.root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    std::fs::write(work.join("file.txt"), b"f").unwrap();
    std::fs::create_dir_all(work.join("Folder/inner")).unwrap();
    std::fs::write(work.join("Folder/a.txt"), b"a").unwrap();
    std::fs::write(work.join("Folder/inner/b.txt"), b"b").unwrap();
    let dest = e.root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();

    // Single regular file → entry at zip root (no parent-dir prefix).
    let em = TestEmitter::new();
    spawn_compress(
        e.engine.clone(),
        "op-l1".into(),
        vec![work.join("file.txt")],
        dest.clone(),
        Arc::new(em.clone()),
    );
    let (status, errors, ..) = done_of(&em.wait_done(T));
    assert_eq!(status, "success", "{:?}", errors);
    assert_eq!(zip_layout(&dest.join("file.txt.zip"), &e.root), vec!["file.txt"]);

    // Single directory → one top-level dir entry (--keepParent applied).
    let em = TestEmitter::new();
    spawn_compress(
        e.engine.clone(),
        "op-l2".into(),
        vec![work.join("Folder")],
        dest.clone(),
        Arc::new(em.clone()),
    );
    let (status, errors, ..) = done_of(&em.wait_done(T));
    assert_eq!(status, "success", "{:?}", errors);
    let layout = zip_layout(&dest.join("Folder.zip"), &e.root);
    assert_eq!(layout, vec!["Folder"], "single dir must keep its parent entry");

    // Multi item → all entries at zip root (--keepParent omitted).
    let em = TestEmitter::new();
    spawn_compress(
        e.engine.clone(),
        "op-l3".into(),
        vec![work.join("file.txt"), work.join("Folder")],
        dest.clone(),
        Arc::new(em.clone()),
    );
    let (status, errors, produced, _) = done_of(&em.wait_done(T));
    assert_eq!(status, "success", "{:?}", errors);
    assert_eq!(produced, vec![dest.join("Archive.zip").to_string_lossy().into_owned()]);
    let layout = zip_layout(&dest.join("Archive.zip"), &e.root);
    assert_eq!(layout, vec!["Folder", "file.txt"]);
    assert_staging_free(&dest);
    std::fs::remove_dir_all(&e.root).ok();
}

#[test]
fn multi_item_duplicate_basenames_keep_both_inside_zip() {
    let e = env("dupnames");
    let a = e.root.join("a");
    let b = e.root.join("b");
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    std::fs::write(a.join("readme.txt"), b"from-a").unwrap();
    std::fs::write(b.join("readme.txt"), b"from-b").unwrap();
    let dest = e.root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();

    let em = TestEmitter::new();
    spawn_compress(
        e.engine.clone(),
        "op-dup".into(),
        vec![a.join("readme.txt"), b.join("readme.txt")],
        dest.clone(),
        Arc::new(em.clone()),
    );
    let (status, errors, ..) = done_of(&em.wait_done(T));
    assert_eq!(status, "success", "{:?}", errors);
    let layout = zip_layout(&dest.join("Archive.zip"), &e.root);
    assert_eq!(layout, vec!["readme 2.txt", "readme.txt"]);
    std::fs::remove_dir_all(&e.root).ok();
}

#[test]
fn all_or_nothing_despite_outcome_done() {
    use std::os::unix::fs::PermissionsExt;
    let e = env("allornothing");
    let src = e.root.join("src");
    // An unreadable nested DIRECTORY deterministically fails read_dir (a
    // chmod-000 file can still be clonefile'd on APFS).
    std::fs::create_dir_all(src.join("ok")).unwrap();
    std::fs::write(src.join("ok/a.txt"), b"a").unwrap();
    std::fs::create_dir_all(src.join("locked")).unwrap();
    std::fs::write(src.join("locked/secret.txt"), b"s").unwrap();
    std::fs::set_permissions(src.join("locked"), std::fs::Permissions::from_mode(0o000)).unwrap();
    let other = e.root.join("other.txt");
    std::fs::write(&other, b"o").unwrap();
    let dest = e.root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();

    let em = TestEmitter::new();
    // Multi-item so the staging copy (where the child error surfaces) runs.
    spawn_compress(
        e.engine.clone(),
        "op-aon".into(),
        vec![src.clone(), other.clone()],
        dest.clone(),
        Arc::new(em.clone()),
    );
    let events = em.wait_done(T);
    std::fs::set_permissions(src.join("locked"), std::fs::Permissions::from_mode(0o755)).unwrap();

    let (status, errors, produced, undoable) = done_of(&events);
    assert_eq!(status, "failed", "a silently incomplete zip is data loss");
    assert!(!errors.is_empty());
    assert!(produced.is_empty());
    assert!(!undoable);
    assert!(!dest.join("Archive.zip").exists(), "no zip may be produced");
    assert_staging_free(&e.root);
    assert!(e.engine.journal.recover().is_empty());
    std::fs::remove_dir_all(&e.root).ok();
}

#[test]
fn compress_dest_inside_source_fails_cleanly() {
    let e = env("destinside");
    let parent = e.root.join("parent");
    let child = parent.join("child");
    std::fs::create_dir_all(&child).unwrap();
    std::fs::write(parent.join("f.txt"), b"f").unwrap();

    let em = TestEmitter::new();
    spawn_compress(
        e.engine.clone(),
        "op-di".into(),
        vec![parent.clone()],
        child.clone(),
        Arc::new(em.clone()),
    );
    let (status, errors, produced, _) = done_of(&em.wait_done(T));
    assert_eq!(status, "failed");
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].0, parent.to_string_lossy());
    assert!(produced.is_empty());
    assert_staging_free(&e.root);
    assert!(names_in(&child).is_empty(), "nothing may be written into the destination");
    assert!(e.engine.journal.recover().is_empty());
    std::fs::remove_dir_all(&e.root).ok();
}

#[test]
fn compress_nonexistent_source_fails_without_staging() {
    let e = env("missing");
    let dest = e.root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    let em = TestEmitter::new();
    spawn_compress(
        e.engine.clone(),
        "op-miss".into(),
        vec![e.root.join("nope.txt")],
        dest.clone(),
        Arc::new(em.clone()),
    );
    let (status, errors, produced, _) = done_of(&em.wait_done(T));
    assert_eq!(status, "failed");
    assert!(!errors.is_empty());
    assert!(produced.is_empty());
    assert!(names_in(&dest).is_empty());
    assert_staging_free(&e.root);
    assert!(e.engine.journal.recover().is_empty());
    std::fs::remove_dir_all(&e.root).ok();
}

#[test]
fn compress_journal_total_is_one_while_running() {
    let e = env("journaltotal");
    let a = e.root.join("a");
    let b = e.root.join("b");
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    // Enough staging work that the journal entry is comfortably observable.
    for i in 0..800 {
        std::fs::write(a.join(format!("f{:04}.dat", i)), vec![7u8; 2048]).unwrap();
    }
    std::fs::write(b.join("solo.txt"), b"s").unwrap();
    let dest = e.root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();

    let em = TestEmitter::new();
    spawn_compress(
        e.engine.clone(),
        "op-jt".into(),
        vec![a.clone(), b.join("solo.txt")],
        dest.clone(),
        Arc::new(em.clone()),
    );

    // The journal file exists from before staging until completion — observe
    // it mid-flight and check the interrupted-toast fields.
    let journal_dir = e.root.join(".journal");
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut observed: Option<OpJournalEntry> = None;
    while Instant::now() < deadline && observed.is_none() {
        if let Ok(rd) = std::fs::read_dir(&journal_dir) {
            for f in rd.flatten() {
                if f.path().extension().and_then(|x| x.to_str()) == Some("json") {
                    if let Ok(bytes) = std::fs::read(f.path()) {
                        if let Ok(entry) = serde_json::from_slice::<OpJournalEntry>(&bytes) {
                            observed = Some(entry);
                        }
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_micros(200));
    }
    let entry = observed.expect("journal entry never observed mid-op");
    assert_eq!(entry.kind, "compress");
    // All-or-nothing: ONE output artifact, never sources.len().
    assert_eq!(entry.total, 1);
    // Both the staging zip AND the staging contents dir are journaled.
    assert_eq!(entry.staging.len(), 2, "{:?}", entry.staging);

    let (status, errors, ..) = done_of(&em.wait_done(T));
    assert_eq!(status, "success", "{:?}", errors);
    std::fs::remove_dir_all(&e.root).ok();
}

#[test]
fn cancel_mid_compress_leaves_no_leftovers() {
    let e = env("cancel");
    let a = e.root.join("a");
    std::fs::create_dir_all(&a).unwrap();
    for i in 0..1500 {
        std::fs::write(a.join(format!("f{:04}.dat", i)), vec![3u8; 4096]).unwrap();
    }
    std::fs::write(e.root.join("solo.txt"), b"s").unwrap();
    let dest = e.root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();

    let em = TestEmitter::new();
    let handle = spawn_compress(
        e.engine.clone(),
        "op-cx".into(),
        vec![a.clone(), e.root.join("solo.txt")],
        dest.clone(),
        Arc::new(em.clone()),
    );
    std::thread::sleep(Duration::from_millis(30));
    handle.cancel();
    let (status, _, produced, _) = done_of(&em.wait_done(T));
    // Timing-tolerant: normally cancelled mid-staging; if the machine raced
    // the whole op to success that's not a leftover bug.
    assert!(status == "cancelled" || status == "success", "status {}", status);
    if status == "cancelled" {
        assert!(produced.is_empty());
        assert!(!dest.join("Archive.zip").exists());
    }
    assert_staging_free(&e.root);
    assert!(e.engine.journal.recover().is_empty());
    std::fs::remove_dir_all(&e.root).ok();
}

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

#[test]
fn extract_tar_gz_round_trip() {
    let e = env("targz");
    let work = e.root.join("work");
    std::fs::create_dir_all(work.join("Bundle/inner")).unwrap();
    std::fs::write(work.join("Bundle/a.txt"), b"alpha").unwrap();
    std::fs::write(work.join("Bundle/inner/b.txt"), b"beta").unwrap();
    let tarball = e.root.join("Bundle.tar.gz");
    let status = Command::new("/usr/bin/tar")
        .arg("-czf")
        .arg(&tarball)
        .arg("-C")
        .arg(&work)
        .arg("Bundle")
        .status()
        .unwrap();
    assert!(status.success());

    let dest = e.root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    let em = TestEmitter::new();
    spawn_extract(
        e.engine.clone(),
        "op-tgz".into(),
        vec![tarball.clone()],
        dest.clone(),
        Arc::new(em.clone()),
    );
    let (status, errors, produced, _) = done_of(&em.wait_done(T));
    assert_eq!(status, "success", "{:?}", errors);
    // Single-entry promotion: inner name "Bundle", not "Bundle/Bundle".
    assert_eq!(produced, vec![dest.join("Bundle").to_string_lossy().into_owned()]);
    assert_eq!(std::fs::read(dest.join("Bundle/a.txt")).unwrap(), b"alpha");
    assert_eq!(std::fs::read(dest.join("Bundle/inner/b.txt")).unwrap(), b"beta");
    assert_staging_free(&e.root);
    std::fs::remove_dir_all(&e.root).ok();
}

#[test]
fn extract_tar_with_dotdot_entry_is_a_failed_item_and_nothing_escapes() {
    let e = env("dotdot");
    let base = e.root.join("base");
    let sub = base.join("sub");
    std::fs::create_dir_all(&sub).unwrap();
    std::fs::write(base.join("escape.txt"), b"payload").unwrap();
    let evil = e.root.join("evil.tar");
    // -P stores the raw "../escape.txt" path; extraction without -P refuses.
    let status = Command::new("/usr/bin/tar")
        .arg("-P")
        .arg("-cf")
        .arg(&evil)
        .arg("../escape.txt")
        .current_dir(&sub)
        .status()
        .unwrap();
    assert!(status.success());

    let dest = e.root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    let em = TestEmitter::new();
    spawn_extract(
        e.engine.clone(),
        "op-dd".into(),
        vec![evil.clone()],
        dest.clone(),
        Arc::new(em.clone()),
    );
    let (status, errors, produced, _) = done_of(&em.wait_done(T));
    assert_eq!(status, "failed");
    assert_eq!(errors.len(), 1);
    // ItemError path is the ARCHIVE path (retry contract), message names the
    // tool status.
    assert_eq!(errors[0].0, evil.to_string_lossy());
    assert!(errors[0].1.contains("tar failed"), "{}", errors[0].1);
    assert!(produced.is_empty());
    // Nothing landed outside staging; dest untouched; no escape file appeared
    // next to dest.
    assert!(names_in(&dest).is_empty());
    assert!(!e.root.join("escape.txt").exists());
    assert_staging_free(&e.root);
    std::fs::remove_dir_all(&e.root).ok();
}

#[test]
fn extract_symlink_escape_rejected_by_validation() {
    let e = env("symlink");
    // The tar tool happily archives + extracts an absolute symlink — OUR
    // validation must be the gate that refuses promotion.
    let payload = e.root.join("payload");
    std::fs::create_dir_all(&payload).unwrap();
    std::fs::write(payload.join("innocent.txt"), b"x").unwrap();
    std::os::unix::fs::symlink("/etc/passwd", payload.join("evil-link")).unwrap();
    let evil = e.root.join("evil-link.tar");
    let status = Command::new("/usr/bin/tar")
        .arg("-cf")
        .arg(&evil)
        .arg("-C")
        .arg(&e.root)
        .arg("payload")
        .status()
        .unwrap();
    assert!(status.success());

    let dest = e.root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    let em = TestEmitter::new();
    spawn_extract(
        e.engine.clone(),
        "op-sl".into(),
        vec![evil.clone()],
        dest.clone(),
        Arc::new(em.clone()),
    );
    let (status, errors, produced, _) = done_of(&em.wait_done(T));
    assert_eq!(status, "failed", "tool exit 0 must not bypass validation");
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].0, evil.to_string_lossy());
    assert!(errors[0].1.contains("unsafe link"), "{}", errors[0].1);
    assert!(produced.is_empty());
    assert!(names_in(&dest).is_empty(), "nothing may be promoted");
    assert_staging_free(&e.root);
    std::fs::remove_dir_all(&e.root).ok();
}

#[test]
fn extract_crafted_zip_traversal_never_escapes() {
    if !have_python() {
        eprintln!("skipping: python3 unavailable");
        return;
    }
    let e = env("evilzip");
    let evil = e.root.join("evil.zip");
    python_zip(&format!(
        "import zipfile\nz = zipfile.ZipFile({:?}, 'w')\nz.writestr('../escape.txt', 'x')\nz.writestr('/tmp/abs-escape.txt', 'y')\nz.close()",
        evil.to_string_lossy()
    ));

    let dest = e.root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    let em = TestEmitter::new();
    spawn_extract(
        e.engine.clone(),
        "op-ez".into(),
        vec![evil.clone()],
        dest.clone(),
        Arc::new(em.clone()),
    );
    let (status, errors, ..) = done_of(&em.wait_done(T));
    // ditto may refuse (exit code or signal death) or sanitize the entries;
    // whichever way, the escape targets must not exist and any failure must
    // report a real status string (never a code().unwrap() panic — reaching
    // Done at all proves that).
    assert!(!e.root.join("escape.txt").exists(), "../ entry escaped staging");
    assert!(!Path::new("/tmp/abs-escape.txt").exists(), "absolute entry escaped");
    if status == "failed" {
        assert_eq!(errors[0].0, evil.to_string_lossy());
        assert!(errors[0].1.contains("ditto failed"), "{}", errors[0].1);
    }
    assert_staging_free(&e.root);
    std::fs::remove_dir_all(&e.root).ok();
}

#[test]
fn extract_garbage_zip_reports_ditto_stderr() {
    let e = env("garbage");
    let bad = e.root.join("bad.zip");
    std::fs::write(&bad, b"this is definitely not a zip file").unwrap();
    let dest = e.root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();

    let em = TestEmitter::new();
    spawn_extract(
        e.engine.clone(),
        "op-gz".into(),
        vec![bad.clone()],
        dest.clone(),
        Arc::new(em.clone()),
    );
    let (status, errors, produced, _) = done_of(&em.wait_done(T));
    assert_eq!(status, "failed");
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].0, bad.to_string_lossy());
    assert!(errors[0].1.contains("ditto failed"), "{}", errors[0].1);
    // ditto prints a diagnosis to stderr for garbage archives — the message
    // must carry more than the bare exit status.
    assert!(
        errors[0].1.len() > "ditto failed: exit status: 1".len(),
        "expected a stderr tail in {:?}",
        errors[0].1
    );
    assert!(produced.is_empty());
    assert!(names_in(&dest).is_empty());
    assert_staging_free(&e.root);
    std::fs::remove_dir_all(&e.root).ok();
}

#[test]
fn extract_empty_and_metadata_only_archives_fail() {
    if !have_python() {
        eprintln!("skipping: python3 unavailable");
        return;
    }
    let e = env("emptyzip");
    // ditto refuses to CREATE a zero-entry zip, so the empty fixture comes
    // from python (a bare end-of-central-directory record).
    let empty = e.root.join("empty.zip");
    python_zip(&format!(
        "import zipfile\nzipfile.ZipFile({:?}, 'w').close()",
        empty.to_string_lossy()
    ));
    // Metadata-only fixture built with ditto itself (plain-named __MACOSX
    // content — crafted `._*` AppleDouble junk would crash --sequesterRsrc
    // with a different error and dodge the zero-payload path).
    let meta_src = e.root.join("meta-src");
    std::fs::create_dir_all(meta_src.join("__MACOSX")).unwrap();
    std::fs::write(meta_src.join("__MACOSX/marker.txt"), b"m").unwrap();
    std::fs::write(meta_src.join(".DS_Store"), b"ds").unwrap();
    let meta_only = e.root.join("meta.zip");
    ditto_zip_contents(&meta_src, &meta_only);

    let dest = e.root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();

    // Empty zip: ditto rejects the archive outright (bad pkzip signature) —
    // either failure message is a valid "failed item, not a no-op".
    let em = TestEmitter::new();
    spawn_extract(
        e.engine.clone(),
        "op-e1".into(),
        vec![empty.clone()],
        dest.clone(),
        Arc::new(em.clone()),
    );
    let (status, errors, produced, _) = done_of(&em.wait_done(T));
    assert_eq!(status, "failed", "empty zip must be a failed item, not a no-op");
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].0, empty.to_string_lossy());
    assert!(
        errors[0].1.contains("no extractable content") || errors[0].1.contains("ditto failed"),
        "{}",
        errors[0].1
    );
    assert!(produced.is_empty());
    assert!(names_in(&dest).is_empty(), "no empty folder may be promoted");

    // Metadata-only zip: extraction succeeds at the tool level, then the
    // zero-payload rule fails the item.
    let em = TestEmitter::new();
    spawn_extract(
        e.engine.clone(),
        "op-e2".into(),
        vec![meta_only.clone()],
        dest.clone(),
        Arc::new(em.clone()),
    );
    let (status, errors, produced, _) = done_of(&em.wait_done(T));
    assert_eq!(status, "failed", "metadata-only zip must be a failed item");
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].0, meta_only.to_string_lossy());
    assert!(errors[0].1.contains("no extractable content"), "{}", errors[0].1);
    assert!(produced.is_empty());
    assert!(names_in(&dest).is_empty(), "no empty folder may be promoted");

    assert_staging_free(&e.root);
    std::fs::remove_dir_all(&e.root).ok();
}

#[test]
fn extract_single_payload_plus_macosx_promotes_clean() {
    let e = env("onemeta");
    let src = e.root.join("one-src");
    std::fs::create_dir_all(src.join("__MACOSX")).unwrap();
    std::fs::write(src.join("readme.txt"), b"hello").unwrap();
    std::fs::write(src.join("__MACOSX/marker.txt"), b"m").unwrap();
    std::fs::write(src.join(".DS_Store"), b"ds").unwrap();
    let zip = e.root.join("One.zip");
    ditto_zip_contents(&src, &zip);
    let dest = e.root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();

    let em = TestEmitter::new();
    spawn_extract(e.engine.clone(), "op-om".into(), vec![zip], dest.clone(), Arc::new(em.clone()));
    let (status, errors, produced, _) = done_of(&em.wait_done(T));
    assert_eq!(status, "success", "{:?}", errors);
    // Metadata ignored for the count → single-entry promotion of readme.txt.
    assert_eq!(produced, vec![dest.join("readme.txt").to_string_lossy().into_owned()]);
    assert_eq!(std::fs::read(dest.join("readme.txt")).unwrap(), b"hello");
    assert!(!dest.join("__MACOSX").exists());
    assert!(!dest.join(".DS_Store").exists());
    assert_staging_free(&e.root);
    std::fs::remove_dir_all(&e.root).ok();
}

#[test]
fn extract_multi_entry_strips_metadata_from_promoted_folder() {
    let e = env("multistrip");
    let src = e.root.join("stuff-src");
    std::fs::create_dir_all(src.join("Photos")).unwrap();
    std::fs::create_dir_all(src.join("docs")).unwrap();
    std::fs::create_dir_all(src.join("__MACOSX")).unwrap();
    std::fs::write(src.join("Photos/pic.jpg"), b"p").unwrap();
    std::fs::write(src.join("docs/doc.txt"), b"d").unwrap();
    std::fs::write(src.join("__MACOSX/marker.txt"), b"m").unwrap();
    std::fs::write(src.join(".DS_Store"), b"ds").unwrap();
    let zip = e.root.join("Stuff.zip");
    ditto_zip_contents(&src, &zip);
    let dest = e.root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();

    let em = TestEmitter::new();
    spawn_extract(e.engine.clone(), "op-ms".into(), vec![zip], dest.clone(), Arc::new(em.clone()));
    let (status, errors, produced, _) = done_of(&em.wait_done(T));
    assert_eq!(status, "success", "{:?}", errors);
    // Multi-entry → folder named after the archive stem.
    assert_eq!(produced, vec![dest.join("Stuff").to_string_lossy().into_owned()]);
    let names = names_in(&dest.join("Stuff"));
    assert_eq!(names, vec!["Photos", "docs"], "no __MACOSX, no root .DS_Store");
    assert_staging_free(&e.root);
    std::fs::remove_dir_all(&e.root).ok();
}

#[test]
fn extract_naming_collisions_keep_both() {
    if !have_python() {
        eprintln!("skipping: python3 unavailable");
        return;
    }
    let e = env("collide");
    let dest = e.root.join("dest");
    std::fs::create_dir_all(dest.join("Stuff")).unwrap(); // collides (folder)
    std::fs::write(dest.join("readme.txt"), b"existing").unwrap(); // collides (file)

    let multi = e.root.join("Stuff.zip");
    python_zip(&format!(
        "import zipfile\nz = zipfile.ZipFile({:?}, 'w')\nz.writestr('a/x.txt', 'x')\nz.writestr('b/y.txt', 'y')\nz.close()",
        multi.to_string_lossy()
    ));
    let single = e.root.join("Single.zip");
    python_zip(&format!(
        "import zipfile\nz = zipfile.ZipFile({:?}, 'w')\nz.writestr('readme.txt', 'fresh')\nz.close()",
        single.to_string_lossy()
    ));

    let em = TestEmitter::new();
    spawn_extract(
        e.engine.clone(),
        "op-nc".into(),
        vec![multi, single],
        dest.clone(),
        Arc::new(em.clone()),
    );
    let (status, errors, produced, _) = done_of(&em.wait_done(T));
    assert_eq!(status, "success", "{:?}", errors);
    // Folder collision → "Stuff 2"; single-FILE collision must be
    // extension-preserving: "readme 2.txt", never "readme.txt 2".
    assert_eq!(
        produced,
        vec![
            dest.join("Stuff 2").to_string_lossy().into_owned(),
            dest.join("readme 2.txt").to_string_lossy().into_owned(),
        ]
    );
    assert_eq!(std::fs::read(dest.join("readme.txt")).unwrap(), b"existing");
    assert_eq!(std::fs::read(dest.join("readme 2.txt")).unwrap(), b"fresh");
    assert!(dest.join("Stuff 2/a/x.txt").exists());
    assert_staging_free(&e.root);
    std::fs::remove_dir_all(&e.root).ok();
}

#[test]
fn extract_multi_archive_identical_basenames() {
    let e = env("samebase");
    let a = e.root.join("a");
    let b = e.root.join("b");
    std::fs::create_dir_all(a.join("payload")).unwrap();
    std::fs::create_dir_all(b.join("payload")).unwrap();
    std::fs::write(a.join("payload/from-a.txt"), b"a").unwrap();
    std::fs::write(b.join("payload/from-b.txt"), b"b").unwrap();
    ditto_zip_contents(&a.join("payload"), &a.join("Foo.zip"));
    ditto_zip_contents(&b.join("payload"), &b.join("Foo.zip"));

    let dest = e.root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    let em = TestEmitter::new();
    spawn_extract(
        e.engine.clone(),
        "op-sb".into(),
        vec![a.join("Foo.zip"), b.join("Foo.zip")],
        dest.clone(),
        Arc::new(em.clone()),
    );
    let (status, errors, produced, _) = done_of(&em.wait_done(T));
    assert_eq!(status, "success", "{:?}", errors);
    assert_eq!(produced.len(), 2, "both same-named archives must promote");
    // Each zip had one payload file → single-entry promotion of each, with a
    // keep-both name for the second where they collide — here the inner names
    // differ, so both land untouched.
    assert!(dest.join("from-a.txt").exists());
    assert!(dest.join("from-b.txt").exists());
    assert_staging_free(&e.root);
    std::fs::remove_dir_all(&e.root).ok();
}

#[test]
fn extract_progress_advances_past_mid_batch_failure() {
    let e = env("progress");
    let work = e.root.join("work");
    std::fs::create_dir_all(work.join("one")).unwrap();
    std::fs::create_dir_all(work.join("three")).unwrap();
    std::fs::write(work.join("one/a.txt"), b"1").unwrap();
    std::fs::write(work.join("three/c.txt"), b"3").unwrap();
    ditto_zip_contents(&work.join("one"), &e.root.join("one.zip"));
    ditto_zip_contents(&work.join("three"), &e.root.join("three.zip"));
    let bad = e.root.join("two.zip");
    std::fs::write(&bad, b"garbage, not a zip").unwrap();

    let dest = e.root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    let em = TestEmitter::new();
    spawn_extract(
        e.engine.clone(),
        "op-pp".into(),
        vec![e.root.join("one.zip"), bad.clone(), e.root.join("three.zip")],
        dest.clone(),
        Arc::new(em.clone()),
    );
    let events = em.wait_done(T);
    let (status, errors, produced, undoable) = done_of(&events);
    assert_eq!(status, "partial");
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].0, bad.to_string_lossy());
    assert_eq!(produced.len(), 2);
    assert!(undoable);

    // Enumerated announces the archive count up front.
    assert!(events.iter().any(|e| matches!(
        e,
        OpEvent::Enumerated { total_entries: 3, .. }
    )));
    // The absolute processed count reaches 3 and includes 2 — the failed
    // archive still advances the bar instead of stalling at 1.
    let counts = progress_entry_counts(&events);
    assert!(counts.contains(&2), "counts {:?}", counts);
    assert_eq!(*counts.iter().max().unwrap(), 3, "counts {:?}", counts);
    // Undo covers only the successes.
    assert_eq!(
        e.engine.undo.lock().unwrap().undo_top().unwrap().label(),
        "Extract of 2 Items"
    );
    assert_staging_free(&e.root);
    std::fs::remove_dir_all(&e.root).ok();
}

#[test]
fn journal_recovery_deletes_fake_staged_zip() {
    let e = env("recover");
    let dest = e.root.join("dest");
    std::fs::create_dir_all(&dest).unwrap();
    // Simulate a crash mid-compress: a staged zip + contents dir on disk,
    // journal entry still present.
    let staged_zip = dest.join(".Archive.zip.fazi-partial-op-dead");
    let staged_contents = dest.join(".Archive.zip.contents.fazi-partial-op-dead");
    std::fs::write(&staged_zip, b"half a zip").unwrap();
    std::fs::create_dir_all(&staged_contents).unwrap();
    std::fs::write(staged_contents.join("f.txt"), b"staged").unwrap();
    e.engine
        .journal
        .write(&OpJournalEntry {
            op_id: "op-dead".into(),
            kind: "compress".into(),
            sources: vec!["/somewhere/f.txt".into()],
            dest_dir: dest.to_string_lossy().into_owned(),
            staging: vec![
                staged_zip.to_string_lossy().into_owned(),
                staged_contents.to_string_lossy().into_owned(),
            ],
            merge_roots: vec![],
            completed: vec![],
            total: 1,
            started_at_ms: 0,
        })
        .unwrap();

    let report = e.engine.journal.recover();
    assert_eq!(report.len(), 1);
    assert_eq!(report[0].kind, "compress");
    assert_eq!(report[0].total, 1, "toast must read \"0 of 1 item\"");
    assert_eq!(report[0].completed, 0);
    assert!(!staged_zip.exists());
    assert!(!staged_contents.exists());
    std::fs::remove_dir_all(&e.root).ok();
}
