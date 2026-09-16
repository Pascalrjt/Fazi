//! Opt-in Downloads retention. Only direct, regular, local files are eligible.
//! State is persisted before cleanup; file identity and timestamps are rechecked
//! immediately before moving to the system Trash. No permanent deletion.
use crate::core::{entry::is_dataless, op_queue::Engine, undo::UndoOp};
use serde::{Deserialize, Serialize};
use std::os::macos::fs::MetadataExt as MacMetadataExt;
use std::{
    collections::HashMap,
    fs,
    io::{self, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

pub const DAY: i64 = 86_400_000;
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub enabled: bool,
    pub retention_days: u32,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            retention_days: 30,
        }
    }
}
impl Config {
    fn validate(&self) -> io::Result<()> {
        if !(1..=3650).contains(&self.retention_days) {
            return Err(io::Error::other(
                "Retention must be between 1 and 3650 days",
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tracked {
    first_seen: i64,
    added: Option<i64>,
    keep: bool,
    extended_until: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub id: String,
    pub original: PathBuf,
    pub trashed: Option<PathBuf>,
    pub at: i64,
    pub restored: bool,
    pub identity: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Data {
    config: Config,
    files: HashMap<String, Tracked>,
    history: Vec<History>,
    last_run: Option<i64>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub path: PathBuf,
    pub name: String,
    pub identity: String,
    pub size: u64,
    pub modified: i64,
    pub added: i64,
    pub deadline: Option<i64>,
    pub keep: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub config: Config,
    pub root: PathBuf,
    pub items: Vec<Item>,
    pub history: Vec<History>,
    pub last_run: Option<i64>,
    pub error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub token: String,
    pub snapshot: Snapshot,
}
struct Pending {
    token: String,
    config: Config,
    expires: i64,
}
pub struct Cleanup {
    root: PathBuf,
    state_path: PathBuf,
    data: Data,
    pending: Option<Pending>,
    error: Option<String>,
    run_error: Option<String>,
}

fn identity(meta: &fs::Metadata) -> String {
    format!(
        "{}:{}:{}:{}",
        meta.dev(),
        meta.ino(),
        meta.st_birthtime(),
        meta.st_birthtime_nsec()
    )
}
fn modified(meta: &fs::Metadata) -> i64 {
    meta.mtime() * 1000 + meta.mtime_nsec() / 1_000_000
}
fn incomplete(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.starts_with('.')
        || [".crdownload", ".download", ".part", ".partial", ".tmp"]
            .iter()
            .any(|s| n.ends_with(s))
        || n.contains(".fazi-partial-")
}
pub fn deadline(added: i64, modified: i64, days: u32, extended: Option<i64>) -> i64 {
    (added.max(modified) + i64::from(days) * DAY).max(extended.unwrap_or(0))
}

/// getattrlist packs values at four-byte alignment. Request only date-added,
/// and decode with unaligned reads (birthtime is deliberately never a fallback).
fn date_added(path: &Path) -> Option<i64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut attrs: libc::attrlist = unsafe { std::mem::zeroed() };
    attrs.bitmapcount = 5;
    attrs.commonattr = libc::ATTR_CMN_ADDEDTIME;
    let mut buf = [0u8; 32];
    let rc = unsafe {
        libc::getattrlist(
            c.as_ptr(),
            (&mut attrs as *mut libc::attrlist).cast(),
            buf.as_mut_ptr().cast(),
            buf.len(),
            libc::FSOPT_NOFOLLOW as _,
        )
    };
    if rc != 0 || u32::from_ne_bytes(buf[..4].try_into().ok()?) < 20 {
        return None;
    }
    let secs = i64::from_ne_bytes(buf[4..12].try_into().ok()?);
    let ns = i64::from_ne_bytes(buf[12..20].try_into().ok()?);
    (secs > 0 && (0..1_000_000_000).contains(&ns)).then_some(secs * 1000 + ns / 1_000_000)
}

impl Cleanup {
    pub fn load(root: PathBuf, state_path: PathBuf) -> Self {
        let (data, error) = match fs::read(&state_path) {
            Ok(b) => match serde_json::from_slice::<Data>(&b) {
                Ok(d) => (d, None),
                Err(e) => (
                    Data::default(),
                    Some(format!(
                        "Cleanup is paused: could not read saved state: {e}"
                    )),
                ),
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => (Data::default(), None),
            Err(e) => (Data::default(), Some(format!("Cleanup is paused: {e}"))),
        };
        Self {
            root,
            state_path,
            data,
            pending: None,
            error,
            run_error: None,
        }
    }
    fn save(&self) -> io::Result<()> {
        let parent = self
            .state_path
            .parent()
            .ok_or_else(|| io::Error::other("Missing state directory"))?;
        fs::create_dir_all(parent)?;
        let tmp = self.state_path.with_extension("json.tmp");
        let mut f = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(&serde_json::to_vec(&self.data)?)?;
        f.sync_all()?;
        fs::rename(tmp, &self.state_path)?;
        fs::File::open(parent)?.sync_all()
    }
    fn scan(&mut self, config: &Config, now: i64) -> io::Result<Vec<Item>> {
        let root_meta = fs::symlink_metadata(&self.root)?;
        if !root_meta.is_dir() || root_meta.file_type().is_symlink() {
            return Err(io::Error::other(
                "Downloads must be a local folder, not a symbolic link",
            ));
        }
        let mut items = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if incomplete(&name) {
                continue;
            }
            let meta = match fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e),
            };
            if !meta.is_file() || meta.file_type().is_symlink() || is_dataless(&meta) {
                continue;
            }
            let id = identity(&meta);
            let observed_added = date_added(&path);
            let tracked = self
                .data
                .files
                .entry(id.clone())
                .or_insert_with(|| Tracked {
                    first_seen: now,
                    added: observed_added,
                    ..Tracked::default()
                });
            // Moving out and back starts a fresh residence; exceptions follow identity.
            if let Some(added) = observed_added {
                tracked.added = Some(tracked.added.unwrap_or(tracked.first_seen).max(added));
            }
            let added = tracked.added.unwrap_or(tracked.first_seen);
            items.push(Item {
                path,
                name,
                identity: id,
                size: meta.len(),
                modified: modified(&meta),
                added,
                deadline: (!tracked.keep).then(|| {
                    deadline(
                        added,
                        modified(&meta),
                        config.retention_days,
                        tracked.extended_until,
                    )
                }),
                keep: tracked.keep,
            });
        }
        items.sort_by(|a, b| {
            a.deadline
                .unwrap_or(i64::MAX)
                .cmp(&b.deadline.unwrap_or(i64::MAX))
                .then(a.name.cmp(&b.name))
        });
        Ok(items)
    }
    pub fn snapshot(&mut self) -> io::Result<Snapshot> {
        if let Some(error) = &self.error {
            return Err(io::Error::other(error.clone()));
        }
        let config = self.data.config.clone();
        let items = self.scan(&config, now_ms())?;
        self.save()?;
        Ok(Snapshot {
            config,
            root: self.root.clone(),
            items,
            history: self.data.history.iter().rev().cloned().collect(),
            last_run: self.data.last_run,
            error: self.run_error.clone(),
        })
    }
    pub fn preview(&mut self, config: Config) -> io::Result<Preview> {
        config.validate()?;
        let mut snapshot = self.snapshot()?;
        snapshot.items = self.scan(&config, now_ms())?;
        snapshot.config = config.clone();
        let token = uuid::Uuid::new_v4().to_string();
        self.pending = Some(Pending {
            token: token.clone(),
            config,
            expires: now_ms() + 10 * 60_000,
        });
        Ok(Preview { token, snapshot })
    }
    pub fn apply(&mut self, token: &str) -> io::Result<Snapshot> {
        let p = self
            .pending
            .take()
            .ok_or_else(|| io::Error::other("Review the cleanup settings before applying"))?;
        if p.token != token || now_ms() > p.expires {
            return Err(io::Error::other(
                "Preview expired. Review the settings again",
            ));
        }
        let old = self.data.clone();
        self.data.config = p.config;
        // Apply never trashes immediately. A full day gives newly eligible files
        // a visible pending state and time to Keep or extend them.
        self.data.last_run = Some(now_ms());
        if let Err(e) = self.save() {
            self.data = old;
            return Err(e);
        }
        self.snapshot()
    }
    pub fn disable(&mut self) -> io::Result<Snapshot> {
        let old = self.data.config.clone();
        self.data.config.enabled = false;
        self.pending = None;
        if let Err(e) = self.save() {
            self.data.config = old;
            return Err(e);
        }
        self.snapshot()
    }
    pub fn item_action(
        &mut self,
        path: &Path,
        id: &str,
        action: &str,
        days: u32,
    ) -> io::Result<Snapshot> {
        let snapshot = self.snapshot()?;
        let item = snapshot
            .items
            .iter()
            .find(|i| i.path == path && i.identity == id)
            .ok_or_else(|| {
                io::Error::other("File changed or left Downloads. Refresh and try again")
            })?;
        let old = self.data.clone();
        let tracked = self.data.files.get_mut(id).unwrap();
        match action {
            "keep" => tracked.keep = true,
            "resume" => {
                tracked.keep = false;
                tracked.extended_until =
                    Some(now_ms() + i64::from(self.data.config.retention_days) * DAY);
            }
            "extend" if (1..=3650).contains(&days) => {
                tracked.keep = false;
                tracked.extended_until =
                    Some(item.deadline.unwrap_or(now_ms()).max(now_ms()) + i64::from(days) * DAY);
            }
            _ => {
                return Err(io::Error::other(
                    "Unknown cleanup action or invalid extension",
                ))
            }
        }
        if let Err(e) = self.save() {
            self.data = old;
            return Err(e);
        }
        self.snapshot()
    }
    pub fn run(&mut self, engine: &Engine, now: i64) -> io::Result<()> {
        self.run_with(engine, now, &file_is_closed)
    }
    fn run_with(
        &mut self,
        engine: &Engine,
        now: i64,
        is_closed: &dyn Fn(&Path) -> bool,
    ) -> io::Result<()> {
        if self.error.is_some()
            || !self.data.config.enabled
            || self.pending.as_ref().is_some_and(|p| p.expires >= now)
            || !engine.ops.is_empty()
        {
            return Ok(());
        }
        if self.data.last_run.is_some_and(|last| now < last + DAY) {
            return Ok(());
        }
        self.data.config.validate()?;
        let config = self.data.config.clone();
        let items = self.scan(&config, now)?;
        self.save()?;
        let mut pairs = Vec::new();
        for item in items {
            if item.keep || item.deadline.is_none_or(|d| d > now) {
                continue;
            }
            if !engine.ops.is_empty() {
                break;
            }
            let meta = match fs::symlink_metadata(&item.path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if !meta.is_file()
                || meta.file_type().is_symlink()
                || identity(&meta) != item.identity
                || modified(&meta) != item.modified
                || meta.len() != item.size
                || is_dataless(&meta)
            {
                continue;
            }
            // A process with an open descriptor may still be downloading or editing.
            // Failure to determine open files is a reason to postpone cleanup.
            if !is_closed(&item.path) {
                continue;
            }
            let recheck = fs::symlink_metadata(&item.path)?;
            if identity(&recheck) != item.identity
                || modified(&recheck) != item.modified
                || recheck.len() != item.size
            {
                continue;
            }
            let root_meta = fs::symlink_metadata(&self.root)?;
            if !root_meta.is_dir()
                || root_meta.file_type().is_symlink()
                || date_added(&item.path).is_some_and(|added| added > item.added)
            {
                continue;
            }
            let h = History {
                id: uuid::Uuid::new_v4().to_string(),
                original: item.path.clone(),
                trashed: None,
                at: now,
                restored: false,
                identity: item.identity.clone(),
            };
            self.data.history.push(h);
            self.save()?; // durable intent
            match engine.trasher.trash(&item.path) {
                Ok(trashed) => {
                    self.data.history.last_mut().unwrap().trashed = Some(trashed.clone());
                    pairs.push((item.path.clone(), trashed));
                    // Restoring through Finder/Undo gets a fresh retention period too.
                    if let Some(t) = self.data.files.get_mut(&item.identity) {
                        t.extended_until = Some(now + i64::from(config.retention_days) * DAY);
                    }
                    self.save()?;
                }
                Err(e) => {
                    self.data.history.pop();
                    self.save()?;
                    return Err(e);
                }
            }
        }
        if !pairs.is_empty() {
            let touched = pairs
                .iter()
                .flat_map(|(a, b)| [a.clone(), b.clone()])
                .collect::<Vec<_>>();
            engine.push_undo(UndoOp::Trash { pairs });
            (engine.invalidate_fuzzy)(&touched);
        }
        self.data.last_run = Some(now);
        self.save()
    }
    pub fn restore(&mut self, id: &str, engine: &Engine) -> io::Result<Snapshot> {
        self.restore_from_trash_dirs(id, engine, &crate::macos::trash::user_trash_dirs())
    }
    fn restore_from_trash_dirs(
        &mut self,
        id: &str,
        engine: &Engine,
        trash_dirs: &[PathBuf],
    ) -> io::Result<Snapshot> {
        let h = self
            .data
            .history
            .iter()
            .find(|h| h.id == id && !h.restored)
            .cloned()
            .ok_or_else(|| io::Error::other("History entry unavailable"))?;
        let trashed = h.trashed.as_ref().ok_or_else(|| {
            io::Error::other("Use Finder’s Put Back to recover this interrupted cleanup")
        })?;
        if h.original.parent() != Some(self.root.as_path())
            || !trash_dirs
                .iter()
                .any(|d| trashed.parent() == Some(d.as_path()))
        {
            return Err(io::Error::other(
                "Restore path is outside Downloads or Trash",
            ));
        }
        let meta = fs::symlink_metadata(trashed)?;
        if identity(&meta) != h.identity {
            return Err(io::Error::other("The item in Trash has changed"));
        }
        let root_meta = fs::symlink_metadata(&self.root)?;
        if !root_meta.is_dir() || root_meta.file_type().is_symlink() {
            return Err(io::Error::other("Downloads is unavailable"));
        }
        // RENAME_EXCL prevents overwriting an existing download, including a symlink.
        use std::os::unix::ffi::OsStrExt;
        let from = std::ffi::CString::new(trashed.as_os_str().as_bytes())?;
        let to = std::ffi::CString::new(h.original.as_os_str().as_bytes())?;
        if unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let tracked = self.data.files.entry(h.identity).or_default();
        tracked.keep = true;
        self.data
            .history
            .iter_mut()
            .find(|x| x.id == id)
            .unwrap()
            .restored = true;
        self.save()?;
        engine.purge_undo_records_under(std::slice::from_ref(trashed));
        (engine.invalidate_fuzzy)(&[h.original, trashed.clone()]);
        self.snapshot()
    }
}
fn file_is_closed(path: &Path) -> bool {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    // Bound the subprocess: an unresponsive filesystem must not block settings.
    let Ok(mut child) = Command::new("/usr/sbin/lsof")
        .args(["-t", "--"])
        .arg(path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    else {
        return false;
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child.wait_with_output().is_ok_and(|o| {
                    o.status.code() == Some(1) && o.stdout.is_empty() && o.stderr.is_empty()
                })
            }
            Ok(None) if started.elapsed() < Duration::from_secs(2) => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

pub fn start_worker(cleanup: Arc<Mutex<Cleanup>>, engine: Arc<Engine>) {
    std::thread::spawn(move || loop {
        // Let launch finish before the catch-up scan. This also keeps changes
        // responsive while a preview is being reviewed.
        std::thread::sleep(std::time::Duration::from_secs(60));
        if let Ok(mut cleanup) = cleanup.lock() {
            if let Err(e) = cleanup.run(&engine, now_ms()) {
                cleanup.run_error = Some(format!("Cleanup postponed: {e}"));
            } else {
                cleanup.run_error = None;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{journal::Journal, undo::UndoStack, walker::Trasher};
    use dashmap::DashMap;
    struct Fixture {
        base: PathBuf,
        service: Cleanup,
        engine: Engine,
    }
    struct FakeTrash(PathBuf);
    impl Trasher for FakeTrash {
        fn trash(&self, path: &Path) -> io::Result<PathBuf> {
            let to = self.0.join(path.file_name().unwrap());
            fs::rename(path, &to)?;
            Ok(to)
        }
    }
    impl Fixture {
        fn new() -> Self {
            let base =
                std::env::temp_dir().join(format!("fazi-cleanup-test-{}", uuid::Uuid::new_v4()));
            let root = base.join("Downloads");
            fs::create_dir_all(&root).unwrap();
            fs::create_dir(base.join("Trash")).unwrap();
            let service = Cleanup::load(root, base.join("state.json"));
            let engine = Engine {
                trasher: Arc::new(FakeTrash(base.join("Trash"))),
                journal: Arc::new(Journal::new(base.join("journal")).unwrap()),
                undo: Arc::new(Mutex::new(UndoStack::default())),
                ops: DashMap::new(),
                volume_locks: DashMap::new(),
                icon_token: Arc::new(|_, _| String::new()),
                verify_copy_contents: Arc::new(crate::core::verify::checksum_compare),
                invalidate_fuzzy: Arc::new(|_| {}),
                undo_changed: Arc::new(|_| {}),
            };
            Self {
                base,
                service,
                engine,
            }
        }
        fn file(&self, name: &str) -> PathBuf {
            let p = self.service.root.join(name);
            fs::write(&p, b"fixture").unwrap();
            p
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }
    #[test]
    fn retention_uses_later_added_or_modified_and_extension() {
        assert_eq!(deadline(10 * DAY, DAY, 30, None), 40 * DAY);
        assert_eq!(deadline(DAY, 20 * DAY, 30, None), 50 * DAY);
        assert_eq!(deadline(DAY, 20 * DAY, 30, Some(70 * DAY)), 70 * DAY);
    }
    #[test]
    fn defaults_off_and_scope_excludes_folders_links_and_partial_downloads() {
        let mut f = Fixture::new();
        f.file("report.pdf");
        f.file("video.crdownload");
        f.file(".hidden");
        f.file("copy.fazi-partial-123");
        fs::create_dir(f.service.root.join("folder")).unwrap();
        fs::write(f.service.root.join("folder/inside.txt"), b"keep").unwrap();
        std::os::unix::fs::symlink(
            f.service.root.join("report.pdf"),
            f.service.root.join("link"),
        )
        .unwrap();
        let s = f.service.snapshot().unwrap();
        assert!(!s.config.enabled);
        assert_eq!(s.items.len(), 1);
        assert_eq!(s.items[0].name, "report.pdf");
        f.service
            .run_with(&f.engine, now_ms() + 90 * DAY, &|_| true)
            .unwrap();
        assert!(f.service.root.join("report.pdf").exists());
    }
    #[test]
    fn first_seen_and_native_added_are_recent_and_persisted() {
        let mut f = Fixture::new();
        let path = f.file("old.txt");
        let times = [libc::timespec {
            tv_sec: 1,
            tv_nsec: 0,
        }; 2];
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        unsafe {
            libc::utimensat(libc::AT_FDCWD, c.as_ptr(), times.as_ptr(), 0);
        }
        let start = now_ms();
        let s = f.service.snapshot().unwrap();
        let item = &s.items[0];
        assert!(item.modified < DAY);
        assert!(item.added >= start - 10_000);
        assert!(item.deadline.unwrap() >= start + 30 * DAY - 10_000);
        let mut reload = Cleanup::load(f.service.root.clone(), f.service.state_path.clone());
        assert_eq!(reload.snapshot().unwrap().items[0].added, item.added);
    }
    #[test]
    fn preview_is_required_and_apply_defers_cleanup_for_a_day() {
        let mut f = Fixture::new();
        f.file("a.txt");
        assert!(f.service.apply("invalid").is_err());
        assert!(f
            .service
            .preview(Config {
                enabled: true,
                retention_days: 0
            })
            .is_err());
        let p = f
            .service
            .preview(Config {
                enabled: true,
                retention_days: 1,
            })
            .unwrap();
        assert!(!f.service.data.config.enabled);
        let s = f.service.apply(&p.token).unwrap();
        assert!(s.config.enabled);
        assert!(s.last_run.unwrap() <= now_ms());
        f.service.run_with(&f.engine, now_ms(), &|_| true).unwrap();
        assert!(f.service.root.join("a.txt").exists());
    }
    #[test]
    fn keep_extend_and_identity_survive_rename_and_restart() {
        let mut f = Fixture::new();
        let path = f.file("a.txt");
        let s = f.service.snapshot().unwrap();
        let item = &s.items[0];
        f.service
            .item_action(&path, &item.identity, "keep", 7)
            .unwrap();
        let new = f.service.root.join("renamed.txt");
        fs::rename(&path, &new).unwrap();
        let mut reload = Cleanup::load(f.service.root.clone(), f.service.state_path.clone());
        let s = reload.snapshot().unwrap();
        assert!(s.items[0].keep);
        let s = reload
            .item_action(&new, &item.identity, "resume", 7)
            .unwrap();
        assert!(!s.items[0].keep);
        let previous = s.items[0].deadline.unwrap();
        let s = reload
            .item_action(&new, &item.identity, "extend", 7)
            .unwrap();
        assert_eq!(s.items[0].deadline.unwrap(), previous + 7 * DAY);
        assert!(reload
            .item_action(&new, "stale identity", "keep", 7)
            .is_err());
    }
    #[test]
    fn cleanup_moves_only_due_unkept_closed_files_and_records_history() {
        let mut f = Fixture::new();
        f.file("due.txt");
        let keep = f.file("kept.txt");
        let open = f.file("open.txt");
        let s = f.service.snapshot().unwrap();
        let item = s.items.iter().find(|i| i.path == keep).unwrap();
        f.service
            .item_action(&keep, &item.identity, "keep", 7)
            .unwrap();
        f.service.data.config.enabled = true;
        f.service
            .run_with(&f.engine, now_ms() + 31 * DAY, &|p| p != open)
            .unwrap();
        assert!(!f.service.root.join("due.txt").exists());
        assert!(keep.exists());
        assert!(open.exists());
        assert!(f.base.join("Trash/due.txt").exists());
        assert_eq!(f.service.data.history.len(), 1);
        assert!(f.service.data.history[0].trashed.is_some());
        let reload = Cleanup::load(f.service.root.clone(), f.service.state_path.clone());
        assert_eq!(reload.data.history.len(), 1);
    }
    #[test]
    fn edits_during_preflight_and_active_operations_postpone_cleanup() {
        let mut f = Fixture::new();
        let path = f.file("a.txt");
        f.service.data.config.enabled = true;
        f.engine
            .ops
            .insert("test".into(), crate::core::op_queue::OpHandle::new());
        f.service
            .run_with(&f.engine, now_ms() + 31 * DAY, &|_| true)
            .unwrap();
        assert!(path.exists());
        f.engine.ops.clear();
        f.service
            .run_with(&f.engine, now_ms() + 31 * DAY, &|p| {
                fs::write(p, b"edited during preflight").unwrap();
                true
            })
            .unwrap();
        assert!(path.exists());
        assert!(f.service.data.history.is_empty());
    }
    #[test]
    fn restore_preserves_existing_download_then_restores_and_keeps() {
        let mut f = Fixture::new();
        let path = f.file("a.txt");
        f.service.data.config.enabled = true;
        f.service
            .run_with(&f.engine, now_ms() + 31 * DAY, &|_| true)
            .unwrap();
        let id = f.service.data.history[0].id.clone();
        let trash_dirs = [f.base.join("Trash")];
        fs::write(&path, b"new download").unwrap();
        assert!(f
            .service
            .restore_from_trash_dirs(&id, &f.engine, &trash_dirs)
            .is_err());
        assert_eq!(fs::read(&path).unwrap(), b"new download");
        fs::remove_file(&path).unwrap();
        let s = f
            .service
            .restore_from_trash_dirs(&id, &f.engine, &trash_dirs)
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"fixture");
        assert!(s.items[0].keep);
        assert!(s.history[0].restored);
    }
    #[test]
    fn lsof_distinguishes_open_and_closed_files() {
        let f = Fixture::new();
        let path = f.file("open.txt");
        let open = fs::File::open(&path).unwrap();
        assert!(!file_is_closed(&path));
        drop(open);
        assert!(file_is_closed(&path));
    }
    #[test]
    fn newly_available_added_metadata_preserves_first_seen_grace() {
        let mut f = Fixture::new();
        f.file("a.txt");
        let snapshot = f.service.snapshot().unwrap();
        let grace = now_ms() + DAY;
        let tracked = f
            .service
            .data
            .files
            .get_mut(&snapshot.items[0].identity)
            .unwrap();
        tracked.added = None;
        tracked.first_seen = grace;
        assert_eq!(f.service.snapshot().unwrap().items[0].added, grace);
    }
    #[test]
    fn failed_state_write_prevents_cleanup() {
        let mut f = Fixture::new();
        let path = f.file("a.txt");
        f.service.data.config.enabled = true;
        fs::create_dir(&f.service.state_path).unwrap();
        assert!(f
            .service
            .run_with(&f.engine, now_ms() + 31 * DAY, &|_| true)
            .is_err());
        assert!(path.exists());
        assert!(f.service.data.history.is_empty());
    }
    #[test]
    fn active_preview_pauses_an_overdue_cleanup() {
        let mut f = Fixture::new();
        let path = f.file("a.txt");
        f.service.data.config.enabled = true;
        f.service
            .preview(Config {
                enabled: true,
                retention_days: 7,
            })
            .unwrap();
        let future = now_ms() + 31 * DAY;
        f.service.pending.as_mut().unwrap().expires = future + DAY;
        f.service.run_with(&f.engine, future, &|_| true).unwrap();
        assert!(path.exists());
        f.service.pending.as_mut().unwrap().expires = future - 1;
        f.service.run_with(&f.engine, future, &|_| true).unwrap();
        assert!(!path.exists());
    }
    #[test]
    fn corrupt_state_fails_closed() {
        let f = Fixture::new();
        fs::write(&f.service.state_path, b"corrupt").unwrap();
        let mut reload = Cleanup::load(f.service.root.clone(), f.service.state_path.clone());
        assert!(reload.snapshot().is_err());
        assert!(!reload.data.config.enabled);
        assert_eq!(fs::read(&reload.state_path).unwrap(), b"corrupt");
    }
    #[test]
    fn symlink_downloads_root_fails_closed() {
        let mut f = Fixture::new();
        let outside = f.base.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::remove_dir(&f.service.root).unwrap();
        std::os::unix::fs::symlink(&outside, &f.service.root).unwrap();
        assert!(f.service.snapshot().is_err());
    }
}
