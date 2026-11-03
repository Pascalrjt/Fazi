//! Durable on-disk op journal — exists for *recovery*, not undo.
//!
//! Per op under `<app-data>/ops-journal/`: a small JSON **header**
//! (`<op>.json`, the `OpJournalEntry` at intent time) written durably before
//! bytes move, plus an append-only **record log** (`<op>.log`, one compact
//! JSON record per line) carrying every later change: staging paths
//! added/removed, merge roots added/removed, items completed. Both are
//! deleted on completion. On startup the journal is scanned: header + log are
//! replayed, orphaned staging artifacts are deleted and interrupted ops are
//! reported to the user.
//!
//! Why a log: rewriting the whole entry (every source path plus the growing
//! `completed` list) with two fsyncs per promoted item made an N-item op cost
//! O(N²) journal bytes and 2N+ fsyncs. Each update is now one O(1) append.
//!
//! Durability rules (the crash-safety argument):
//! - The header (and the empty log beside it) are durable before the op
//!   starts: temp file + fsync + atomic rename + directory fsync.
//! - `stage` / `merge` records are fsynced before `write` returns. Callers
//!   only create a staging artifact (or begin per-entry merge staging) after
//!   that, so an artifact can never exist without a durable record naming it.
//! - `unstage` / `unmerge` / `done` records are appended WITHOUT fsync. They
//!   survive an app crash (the bytes are in the kernel's page cache once
//!   `write(2)` returns) and are only at risk on an OS crash, where losing
//!   one is harmless: a lost `unstage` makes recovery delete a staging path
//!   that was already promoted away (a no-op: staging names embed the op id,
//!   so nothing else lives there) or a throwaway copy; a lost `done`
//!   under-reports the "N of M done" count. They become durable with the next
//!   fsynced record anyway. The one exception is an old original stranded
//!   at a staging path after a failed Trash + failed rescue rename: that
//!   un-staging goes through `write_sync`.
//! - A torn last record (OS crash mid-append) fails to parse and is skipped.
//!   It can only be a record whose `write` never returned, i.e. one whose
//!   artifact the caller had not created yet.
//!
//! Compatibility: a header with no log (the previous one-JSON-per-op format)
//! recovers exactly as before.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::core::walker::{is_staging_name, remove_tree, remove_tree_best_effort};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpJournalEntry {
    pub op_id: String,
    pub kind: String,
    pub sources: Vec<String>,
    pub dest_dir: String,
    /// Explicit staging paths (fresh-copy tier).
    pub staging: Vec<String>,
    /// Roots that may contain per-entry staging artifacts (merge tier) —
    /// recovery scans these for `*.fazi-partial-<opid>` names.
    pub merge_roots: Vec<String>,
    /// Promoted top-level destination paths.
    pub completed: Vec<String>,
    pub total: usize,
    pub started_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterruptedOp {
    pub op_id: String,
    pub kind: String,
    pub dest_dir: String,
    pub completed: usize,
    pub total: usize,
    pub started_at_ms: u64,
}

/// One appended log record. Short tags keep each line small.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "t")]
enum Record {
    #[serde(rename = "s")]
    Stage { p: String },
    #[serde(rename = "u")]
    Unstage { p: String },
    #[serde(rename = "m")]
    Merge { p: String },
    #[serde(rename = "um")]
    Unmerge { p: String },
    #[serde(rename = "d")]
    Done { p: String },
}

#[derive(Serialize)]
struct HeaderOut<'a> {
    #[serde(flatten)]
    entry: &'a OpJournalEntry,
    /// Log bytes already folded into this header (replay starts here).
    #[serde(rename = "logOffset")]
    log_offset: u64,
}

#[derive(Deserialize)]
struct HeaderIn {
    #[serde(flatten)]
    entry: OpJournalEntry,
    #[serde(rename = "logOffset", default)]
    log_offset: u64,
}

/// What the journal has written for a live op (the diff baseline).
struct LiveOp {
    log: fs::File,
    kind: String,
    dest_dir: String,
    total: usize,
    started_at_ms: u64,
    sources_len: usize,
    staging: Vec<String>,
    merge_roots: Vec<String>,
    completed: usize,
}

pub struct Journal {
    dir: PathBuf,
    live: Mutex<HashMap<String, LiveOp>>,
    /// Total header + record bytes written (benchmarks / diagnostics).
    bytes_written: AtomicU64,
    /// Number of fsync calls issued (benchmarks / diagnostics).
    syncs: AtomicU64,
}

impl Journal {
    pub fn new(dir: PathBuf) -> std::io::Result<Self> {
        fs::create_dir_all(&dir)?;
        Ok(Journal {
            dir,
            live: Mutex::new(HashMap::new()),
            bytes_written: AtomicU64::new(0),
            syncs: AtomicU64::new(0),
        })
    }

    pub fn bytes_written(&self) -> u64 {
        self.bytes_written.load(Ordering::Relaxed)
    }

    pub fn syncs(&self) -> u64 {
        self.syncs.load(Ordering::Relaxed)
    }

    fn safe_id(op_id: &str) -> String {
        // op ids are UUIDs we mint — still, never trust them as path segments.
        op_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect()
    }

    fn path_for(&self, op_id: &str) -> PathBuf {
        self.dir.join(format!("{}.json", Self::safe_id(op_id)))
    }

    fn log_path_for(&self, op_id: &str) -> PathBuf {
        self.dir.join(format!("{}.log", Self::safe_id(op_id)))
    }

    /// Persist `entry`'s current state.
    ///
    /// The first write for an op is the durable intent header. Later writes
    /// are diffed against what was last written and become O(1) appended
    /// records (see the module docs for which ones are fsynced). Contract for
    /// the cheap path: `sources`, `kind`, `dest_dir`, `total` and
    /// `started_at_ms` are fixed after the first write; `merge_roots` and
    /// `completed` only grow or shrink at the tail; `staging` is a small set
    /// that may change arbitrarily. Anything else falls back to a full
    /// durable header rewrite, which is always correct.
    pub fn write(&self, entry: &OpJournalEntry) -> std::io::Result<()> {
        self.write_inner(entry, false)
    }

    /// Like `write`, but every appended record is fsynced — for the rare
    /// updates whose loss on an OS crash would matter (e.g. un-staging a
    /// path that still holds a stranded original after a failed rescue).
    pub fn write_sync(&self, entry: &OpJournalEntry) -> std::io::Result<()> {
        self.write_inner(entry, true)
    }

    fn write_inner(&self, entry: &OpJournalEntry, force_sync: bool) -> std::io::Result<()> {
        let mut live = self.live.lock().unwrap();
        if let Some(op) = live.get_mut(&entry.op_id) {
            if let Some(records) = diff(op, entry) {
                if records.is_empty() {
                    return Ok(());
                }
                let needs_sync = force_sync
                    || records
                        .iter()
                        .any(|r| matches!(r, Record::Stage { .. } | Record::Merge { .. }));
                let mut buf = Vec::with_capacity(128 * records.len());
                for r in &records {
                    serde_json::to_writer(&mut buf, r)?;
                    buf.push(b'\n');
                }
                let res = op.log.write_all(&buf).and_then(|()| {
                    if needs_sync {
                        self.syncs.fetch_add(1, Ordering::Relaxed);
                        op.log.sync_data()
                    } else {
                        Ok(())
                    }
                });
                self.bytes_written.fetch_add(buf.len() as u64, Ordering::Relaxed);
                return match res {
                    Ok(()) => {
                        apply_state(op, entry);
                        Ok(())
                    }
                    Err(e) => {
                        // Unknown how much landed: the next write rewrites
                        // the header, whose log_offset re-anchors replay.
                        live.remove(&entry.op_id);
                        Err(e)
                    }
                };
            }
        }
        live.remove(&entry.op_id);
        let op = self.write_header(entry)?;
        live.insert(entry.op_id.clone(), op);
        Ok(())
    }

    /// Durable header write: temp file + fsync + atomic rename + directory
    /// fsync. The log file is created (if missing) BEFORE the rename so the
    /// one directory fsync covers both names.
    ///
    /// The directory fsync after the rename matters: without it, a crash can
    /// lose the rename itself, so a fail-fast caller's "write succeeded before
    /// mutation" would be a false promise.
    fn write_header(&self, entry: &OpJournalEntry) -> std::io::Result<LiveOp> {
        let final_path = self.path_for(&entry.op_id);
        let log_path = self.log_path_for(&entry.op_id);
        let log = fs::OpenOptions::new().create(true).append(true).open(&log_path)?;
        let log_len = log.metadata()?.len();
        let tmp = final_path.with_extension("json.tmp");
        let data = serde_json::to_vec(&HeaderOut { entry, log_offset: log_len })?;
        {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(&data)?;
            f.sync_all()?;
        }
        fs::rename(&tmp, &final_path)?;
        fs::File::open(&self.dir)?.sync_all()?;
        self.syncs.fetch_add(2, Ordering::Relaxed);
        self.bytes_written.fetch_add(data.len() as u64, Ordering::Relaxed);
        Ok(LiveOp {
            log,
            kind: entry.kind.clone(),
            dest_dir: entry.dest_dir.clone(),
            total: entry.total,
            started_at_ms: entry.started_at_ms,
            sources_len: entry.sources.len(),
            staging: entry.staging.clone(),
            merge_roots: entry.merge_roots.clone(),
            completed: entry.completed.len(),
        })
    }

    pub fn remove(&self, op_id: &str) {
        self.live.lock().unwrap().remove(op_id);
        // Header first: an orphan log without a header is simply deleted by
        // recovery.
        let _ = fs::remove_file(self.path_for(op_id));
        let _ = fs::remove_file(self.log_path_for(op_id));
    }

    /// The on-disk state of `op_id` (header + replayed log), exactly as
    /// recovery would see it right now.
    pub fn snapshot(&self, op_id: &str) -> Option<OpJournalEntry> {
        load_entry(&self.path_for(op_id))
    }

    /// Startup recovery: delete orphaned staging artifacts, report
    /// interrupted ops, clear the journal.
    pub fn recover(&self) -> Vec<InterruptedOp> {
        let mut report = Vec::new();
        let Ok(rd) = fs::read_dir(&self.dir) else {
            return report;
        };
        let files: Vec<PathBuf> = rd.flatten().map(|f| f.path()).collect();
        let is_header = |p: &Path| p.extension().and_then(|e| e.to_str()) == Some("json");
        let mut kept_logs: Vec<PathBuf> = Vec::new();
        for p in files.iter().filter(|p| is_header(p)) {
            let mut keep = false;
            if let Some(entry) = load_entry(p) {
                // 1. Remove explicit staging paths. One that can't be removed
                // keeps the record so the next launch retries — dropping it
                // would orphan the tree for good.
                let leftover: Vec<String> = entry
                    .staging
                    .iter()
                    .filter(|s| remove_tree(Path::new(s)).is_err())
                    .cloned()
                    .collect();
                // 2. Scan merge roots for per-entry staging names.
                for root in &entry.merge_roots {
                    remove_staging_recursive(Path::new(root), &entry.op_id);
                }
                self.live.lock().unwrap().remove(&entry.op_id);
                if !leftover.is_empty() {
                    let retry = OpJournalEntry { staging: leftover, ..entry.clone() };
                    keep = self.write(&retry).is_ok();
                    // Not a live op: just a record for the next launch.
                    self.live.lock().unwrap().remove(&entry.op_id);
                }
                report.push(InterruptedOp {
                    op_id: entry.op_id,
                    kind: entry.kind,
                    dest_dir: entry.dest_dir,
                    completed: entry.completed.len(),
                    total: entry.total,
                    started_at_ms: entry.started_at_ms,
                });
            }
            if keep {
                kept_logs.push(p.with_extension("log"));
                continue;
            }
            let _ = fs::remove_file(p);
            let _ = fs::remove_file(p.with_extension("log"));
        }
        // Whatever is left: orphan logs, temp headers, foreign files.
        for p in files.iter().filter(|p| !is_header(p) && !kept_logs.contains(p)) {
            let _ = fs::remove_file(p);
        }
        report
    }
}

/// Records turning `op`'s last-written state into `entry`, or None when the
/// change is outside the append contract (caller rewrites the header).
fn diff(op: &LiveOp, entry: &OpJournalEntry) -> Option<Vec<Record>> {
    if entry.kind != op.kind
        || entry.dest_dir != op.dest_dir
        || entry.total != op.total
        || entry.started_at_ms != op.started_at_ms
        || entry.sources.len() != op.sources_len
    {
        return None;
    }
    let mut out = Vec::new();
    // Staging: small set, full diff — removals first.
    for s in &op.staging {
        if !entry.staging.contains(s) {
            out.push(Record::Unstage { p: s.clone() });
        }
    }
    for s in &entry.staging {
        if !op.staging.contains(s) {
            out.push(Record::Stage { p: s.clone() });
        }
    }
    // Merge roots: tail push / tail pop only. The prefix compare is cheap in
    // practice (merge roots are one per merged top-level item).
    let (old_n, new_n) = (op.merge_roots.len(), entry.merge_roots.len());
    if new_n >= old_n {
        if entry.merge_roots[..old_n] != op.merge_roots[..] {
            return None;
        }
        for m in &entry.merge_roots[old_n..] {
            out.push(Record::Merge { p: m.clone() });
        }
    } else {
        if op.merge_roots[..new_n] != entry.merge_roots[..] {
            return None;
        }
        for m in op.merge_roots[new_n..].iter().rev() {
            out.push(Record::Unmerge { p: m.clone() });
        }
    }
    // Completed: append-only, tracked by count (never re-compared, so a
    // 10k-item op doesn't re-scan its own history per item).
    if entry.completed.len() < op.completed {
        return None;
    }
    for c in &entry.completed[op.completed..] {
        out.push(Record::Done { p: c.clone() });
    }
    Some(out)
}

fn apply_state(op: &mut LiveOp, entry: &OpJournalEntry) {
    if op.staging != entry.staging {
        op.staging = entry.staging.clone();
    }
    if op.merge_roots.len() != entry.merge_roots.len() {
        op.merge_roots = entry.merge_roots.clone();
    }
    op.completed = entry.completed.len();
}

/// Header + log replay. None when the header is unreadable/corrupt.
fn load_entry(header: &Path) -> Option<OpJournalEntry> {
    let bytes = fs::read(header).ok()?;
    let HeaderIn { mut entry, log_offset } = serde_json::from_slice::<HeaderIn>(&bytes).ok()?;
    let Ok(log) = fs::read(header.with_extension("log")) else {
        return Some(entry); // previous format, or nothing appended yet
    };
    let start = usize::try_from(log_offset).unwrap_or(usize::MAX).min(log.len());
    for line in log[start..].split(|b| *b == b'\n') {
        if line.is_empty() {
            continue;
        }
        // A torn (partially written) record fails to parse — skip it.
        let Ok(rec) = serde_json::from_slice::<Record>(line) else {
            continue;
        };
        match rec {
            Record::Stage { p } => entry.staging.push(p),
            Record::Unstage { p } => entry.staging.retain(|s| *s != p),
            Record::Merge { p } => entry.merge_roots.push(p),
            Record::Unmerge { p } => {
                if let Some(i) = entry.merge_roots.iter().rposition(|m| *m == p) {
                    entry.merge_roots.remove(i);
                }
            }
            Record::Done { p } => entry.completed.push(p),
        }
    }
    Some(entry)
}

fn remove_staging_recursive(root: &Path, op_id: &str) {
    let Ok(rd) = fs::read_dir(root) else {
        return;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let p = e.path();
        if is_staging_name(&name, op_id) {
            remove_tree_best_effort(&p);
        } else if p.is_dir() && !p.is_symlink() {
            remove_staging_recursive(&p, op_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::walker::staging_name;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fazi-journal-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn entry(op_id: &str, dest: &Path) -> OpJournalEntry {
        OpJournalEntry {
            op_id: op_id.into(),
            kind: "copy".into(),
            sources: vec!["/src/a".into(), "/src/b".into(), "/src/c".into()],
            dest_dir: dest.to_string_lossy().into_owned(),
            staging: vec![],
            merge_roots: vec![],
            completed: vec![],
            total: 3,
            started_at_ms: 7,
        }
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn recovery_removes_staging_and_reports() {
        let d = tmp("recover");
        let journal = Journal::new(d.join("journal")).unwrap();

        // Simulate a crash: staging artifacts on disk + journal entry, no cleanup.
        let dest = d.join("dest");
        fs::create_dir_all(dest.join("merged-into")).unwrap();
        let staged_top = dest.join(staging_name("BigFolder", "op-abc"));
        fs::create_dir_all(&staged_top).unwrap();
        fs::write(staged_top.join("partial.bin"), b"half").unwrap();
        let staged_entry = dest.join("merged-into").join(staging_name("file.txt", "op-abc"));
        fs::write(&staged_entry, b"half").unwrap();
        let promoted = dest.join("Done.txt");
        fs::write(&promoted, b"complete").unwrap();

        journal
            .write(&OpJournalEntry {
                op_id: "op-abc".into(),
                kind: "copy".into(),
                sources: vec!["/src/BigFolder".into()],
                dest_dir: dest.to_string_lossy().into_owned(),
                staging: vec![staged_top.to_string_lossy().into_owned()],
                merge_roots: vec![dest.to_string_lossy().into_owned()],
                completed: vec![promoted.to_string_lossy().into_owned()],
                total: 3,
                started_at_ms: 0,
            })
            .unwrap();

        let report = journal.recover();
        assert_eq!(report.len(), 1);
        assert_eq!(report[0].completed, 1);
        assert_eq!(report[0].total, 3);
        // Staging gone, promoted item untouched.
        assert!(!staged_top.exists());
        assert!(!staged_entry.exists());
        assert_eq!(fs::read(&promoted).unwrap(), b"complete");
        // Journal cleared: second recovery reports nothing.
        assert!(journal.recover().is_empty());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn completed_op_leaves_no_journal() {
        let d = tmp("complete");
        let journal = Journal::new(d.join("journal")).unwrap();
        let entry = OpJournalEntry {
            op_id: "op-xyz".into(),
            kind: "move".into(),
            sources: vec![],
            dest_dir: "/tmp".into(),
            staging: vec![],
            merge_roots: vec![],
            completed: vec![],
            total: 0,
            started_at_ms: 0,
        };
        journal.write(&entry).unwrap();
        journal.remove("op-xyz");
        assert!(journal.recover().is_empty());
        assert_eq!(fs::read_dir(d.join("journal")).unwrap().count(), 0, "no files left");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn updates_append_records_and_replay_on_recovery() {
        let d = tmp("append");
        let journal = Journal::new(d.join("journal")).unwrap();
        let dest = d.join("dest");
        fs::create_dir_all(&dest).unwrap();
        let mut e = entry("op-app", &dest);
        journal.write(&e).unwrap();
        let header_len = fs::metadata(journal.path_for("op-app")).unwrap().len();

        // Item 1 staged + promoted; item 2 staged (crash mid-copy); a merge root.
        let st1 = dest.join(staging_name("a", "op-app"));
        e.staging.push(s(&st1));
        journal.write(&e).unwrap();
        e.staging.clear();
        e.completed.push(s(&dest.join("a")));
        journal.write(&e).unwrap();
        let st2 = dest.join(staging_name("b", "op-app"));
        e.staging.push(s(&st2));
        journal.write(&e).unwrap();
        fs::create_dir_all(&st2).unwrap();
        fs::write(st2.join("half"), b"x").unwrap();
        let mroot = dest.join("merged");
        fs::create_dir_all(&mroot).unwrap();
        let mstage = mroot.join(staging_name("f", "op-app"));
        fs::write(&mstage, b"half").unwrap();
        e.merge_roots.push(s(&mroot));
        journal.write(&e).unwrap();

        // The header was never rewritten — updates are appended records.
        assert_eq!(fs::metadata(journal.path_for("op-app")).unwrap().len(), header_len);
        let snap = journal.snapshot("op-app").unwrap();
        assert_eq!(snap.staging, vec![s(&st2)]);
        assert_eq!(snap.completed, vec![s(&dest.join("a"))]);
        assert_eq!(snap.merge_roots, vec![s(&mroot)]);

        // Simulated crash: a fresh Journal instance recovers from disk.
        let fresh = Journal::new(d.join("journal")).unwrap();
        let report = fresh.recover();
        assert_eq!(report.len(), 1);
        assert_eq!(report[0].completed, 1);
        assert_eq!(report[0].total, 3);
        assert!(!st2.exists(), "staged artifact removed");
        assert!(!mstage.exists(), "merge-root staging removed");
        assert_eq!(fs::read_dir(d.join("journal")).unwrap().count(), 0);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn torn_last_record_is_ignored() {
        let d = tmp("torn");
        let journal = Journal::new(d.join("journal")).unwrap();
        let dest = d.join("dest");
        fs::create_dir_all(&dest).unwrap();
        let mut e = entry("op-torn", &dest);
        journal.write(&e).unwrap();
        let st = dest.join(staging_name("a", "op-torn"));
        e.staging.push(s(&st));
        journal.write(&e).unwrap();
        fs::create_dir_all(&st).unwrap();
        // OS crash mid-append: half a record, no newline.
        {
            let mut f = fs::OpenOptions::new()
                .append(true)
                .open(journal.log_path_for("op-torn"))
                .unwrap();
            f.write_all(br#"{"t":"u","p":"/tm"#).unwrap();
        }
        let snap = journal.snapshot("op-torn").unwrap();
        assert_eq!(snap.staging, vec![s(&st)], "torn record skipped, earlier ones kept");
        let report = Journal::new(d.join("journal")).unwrap().recover();
        assert_eq!(report.len(), 1);
        assert!(!st.exists());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn legacy_single_json_entry_still_recovers() {
        let d = tmp("legacy");
        let jdir = d.join("journal");
        let journal = Journal::new(jdir.clone()).unwrap();
        let dest = d.join("dest");
        fs::create_dir_all(&dest).unwrap();
        let st = dest.join(staging_name("big", "op-old"));
        fs::create_dir_all(&st).unwrap();
        let mut e = entry("op-old", &dest);
        e.staging.push(s(&st));
        e.completed.push("/x".into());
        // Previous on-disk format: pretty JSON, no logOffset, no log file.
        fs::write(jdir.join("op-old.json"), serde_json::to_vec_pretty(&e).unwrap()).unwrap();
        fs::write(jdir.join("stray.json.tmp"), b"junk").unwrap();
        let report = journal.recover();
        assert_eq!(report.len(), 1);
        assert_eq!(report[0].completed, 1);
        assert!(!st.exists());
        assert_eq!(fs::read_dir(&jdir).unwrap().count(), 0);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn non_append_change_rewrites_header_and_replay_stays_exact() {
        let d = tmp("rewrite");
        let journal = Journal::new(d.join("journal")).unwrap();
        let dest = d.join("dest");
        fs::create_dir_all(&dest).unwrap();
        let mut e = entry("op-rw", &dest);
        journal.write(&e).unwrap();
        e.merge_roots.push("/m1".into());
        e.merge_roots.push("/m2".into());
        journal.write(&e).unwrap();
        // Out-of-contract change (middle removal) → header rewrite.
        e.merge_roots.remove(0);
        e.staging.push("/st".into());
        journal.write(&e).unwrap();
        e.completed.push("/done".into());
        journal.write(&e).unwrap();
        let snap = journal.snapshot("op-rw").unwrap();
        assert_eq!(snap.merge_roots, vec!["/m2".to_string()]);
        assert_eq!(snap.staging, vec!["/st".to_string()]);
        assert_eq!(snap.completed, vec!["/done".to_string()]);
        journal.remove("op-rw");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn per_item_updates_are_o1_and_skip_fsync() {
        let d = tmp("o1");
        let journal = Journal::new(d.join("journal")).unwrap();
        let mut e = entry("op-o1", &d);
        e.sources = (0..1000).map(|i| format!("/src/some/long/path/item-{i:05}")).collect();
        e.total = 1000;
        journal.write(&e).unwrap();
        let (b0, s0) = (journal.bytes_written(), journal.syncs());
        for i in 0..1000 {
            e.completed.push(format!("/dest/item-{i:05}"));
            journal.write(&e).unwrap();
        }
        let per_item = (journal.bytes_written() - b0) / 1000;
        assert!(per_item < 64, "per-item journal bytes {per_item}");
        assert_eq!(journal.syncs(), s0, "completion records are not fsynced");
        e.staging.push("/dest/.x.fazi-partial-op-o1".into());
        journal.write(&e).unwrap();
        assert_eq!(journal.syncs(), s0 + 1, "staging records are fsynced");
        journal.remove("op-o1");
        fs::remove_dir_all(&d).ok();
    }
}
