//! The file-operations engine: per-item attempt ladders, staging + atomic
//! promote, durable journal, conflict rendezvous, progress streaming,
//! cancellation, undo recording.
//!
//! Responsiveness rules (plan): no blocking preflight — bytes start moving
//! immediately, total-size enumeration runs concurrently and the progress
//! denominator arrives when it lands.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use serde::Serialize;

use crate::core::copier;
use crate::core::entry::is_dataless;
use crate::core::journal::{Journal, OpJournalEntry};
use crate::core::undo::{UndoOp, UndoStack};
use crate::core::walker::{
    self, keep_both_name, staging_name, ConflictKind, DatalessPolicy, MergeCtx, Outcome,
    ReplaceOutcome, Resolution, Trasher, WalkSink, WarnSeverity,
};

// ---------------------------------------------------------------------------
// Wire types (lockstep with src/types/ipc.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSide {
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub mtime: Option<i64>,
    pub icon: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpError {
    pub path: String,
    pub message: String,
}

/// Non-fatal warning attached to a successful item (wire struct — severity
/// serializes lowercase via `walker::WarnSeverity`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpWarning {
    pub path: String,
    pub message: String,
    pub severity: WarnSeverity,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum OpEvent {
    #[serde(rename_all = "camelCase")]
    Started { op_id: String },
    #[serde(rename_all = "camelCase")]
    Enumerated { total_bytes: u64, total_entries: u64 },
    #[serde(rename_all = "camelCase")]
    Progress {
        bytes_done: u64,
        entries_done: u64,
        current_path: String,
        cloned: bool,
    },
    #[serde(rename_all = "camelCase")]
    Conflict {
        conflict_id: u64,
        kind: &'static str,
        source: ConflictSide,
        dest: ConflictSide,
        remaining: usize,
    },
    #[serde(rename_all = "camelCase")]
    ItemError { path: String, message: String },
    #[serde(rename_all = "camelCase")]
    Warning {
        path: String,
        message: String,
        severity: WarnSeverity,
    },
    #[serde(rename_all = "camelCase")]
    SkippedIcloud { paths: Vec<String> },
    #[serde(rename_all = "camelCase")]
    Done {
        status: &'static str,
        errors: Vec<OpError>,
        warnings: Vec<OpWarning>,
        skipped_icloud: Vec<String>,
        produced: Vec<String>,
        undoable: bool,
    },
}

/// Decouples the engine from tauri::ipc::Channel so tests can collect events.
pub trait OpEmitter: Send + Sync + 'static {
    fn emit(&self, e: OpEvent);
}

// ---------------------------------------------------------------------------
// Public op API
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpKind {
    Copy,
    Move,
}

/// Initial conflict policy from the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    Ask,
    KeepBoth,
    Replace,
    Skip,
}

impl Policy {
    pub fn from_wire(s: &str) -> Policy {
        match s {
            "keepBoth" => Policy::KeepBoth,
            "replace" => Policy::Replace,
            "skip" => Policy::Skip,
            _ => Policy::Ask,
        }
    }
}

pub struct OpArgs {
    pub op_id: String,
    pub kind: OpKind,
    pub sources: Vec<PathBuf>,
    pub dest_dir: PathBuf,
    pub policy: Policy,
}

/// Per-op handle: cancellation + the conflict-response rendezvous.
pub struct OpHandle {
    pub cancel: AtomicBool,
    pending: Mutex<HashMap<u64, SyncSender<(Resolution, bool)>>>,
}

impl OpHandle {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(OpHandle {
            cancel: AtomicBool::new(false),
            pending: Mutex::new(HashMap::new()),
        })
    }

    pub fn respond(&self, conflict_id: u64, resolution: Resolution, apply_to_all: bool) {
        if let Some(tx) = self.pending.lock().unwrap().remove(&conflict_id) {
            let _ = tx.send((resolution, apply_to_all));
        }
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        // Unblock any pending conflict wait.
        let mut pending = self.pending.lock().unwrap();
        for (_, tx) in pending.drain() {
            let _ = tx.send((Resolution::Cancel, false));
        }
    }
}

/// Shared engine dependencies (built once at app setup).
pub struct Engine {
    pub trasher: Arc<dyn Trasher>,
    pub journal: Arc<Journal>,
    pub undo: Arc<Mutex<UndoStack>>,
    pub ops: DashMap<String, Arc<OpHandle>>,
    pub volume_locks: DashMap<u64, Arc<Mutex<()>>>,
    /// Registers an icon token for conflict-dialog sides (owner = op id).
    pub icon_token: Arc<dyn Fn(&str, &Path) -> String + Send + Sync>,
}

impl Engine {
    pub fn cancel_op(&self, op_id: &str) {
        if let Some(h) = self.ops.get(op_id) {
            h.cancel();
        }
    }

    pub fn respond_conflict(
        &self,
        op_id: &str,
        conflict_id: u64,
        resolution: Resolution,
        apply_to_all: bool,
    ) {
        if let Some(h) = self.ops.get(op_id) {
            h.respond(conflict_id, resolution, apply_to_all);
        }
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// The op sink: WalkSink wired to events + conflict rendezvous
// ---------------------------------------------------------------------------

struct OpSink {
    emitter: Arc<dyn OpEmitter>,
    handle: Arc<OpHandle>,
    op_id: String,
    icon_token: Arc<dyn Fn(&str, &Path) -> String + Send + Sync>,
    bytes: u64,
    entries: u64,
    last_emit: Instant,
    any_clone: bool,
    errors: Vec<OpError>,
    warnings: Vec<OpWarning>,
    skipped: Vec<PathBuf>,
    op_policy: Policy,
    file_policy: Option<Resolution>,
    dir_policy: Option<Resolution>,
    conflict_seq: u64,
    remaining_hint: usize,
}

impl OpSink {
    fn new(
        emitter: Arc<dyn OpEmitter>,
        handle: Arc<OpHandle>,
        op_id: String,
        icon_token: Arc<dyn Fn(&str, &Path) -> String + Send + Sync>,
        op_policy: Policy,
        remaining_hint: usize,
    ) -> Self {
        OpSink {
            emitter,
            handle,
            op_id,
            icon_token,
            bytes: 0,
            entries: 0,
            last_emit: Instant::now(),
            any_clone: false,
            errors: Vec::new(),
            warnings: Vec::new(),
            skipped: Vec::new(),
            op_policy,
            file_policy: None,
            dir_policy: None,
            conflict_seq: 0,
            remaining_hint,
        }
    }

    fn emit_progress(&mut self, current: &Path, force: bool) {
        if force || self.last_emit.elapsed() >= Duration::from_millis(80) {
            self.last_emit = Instant::now();
            self.emitter.emit(OpEvent::Progress {
                bytes_done: self.bytes,
                entries_done: self.entries,
                current_path: current.to_string_lossy().into_owned(),
                cloned: self.any_clone,
            });
        }
    }

    fn side(&self, p: &Path) -> ConflictSide {
        let meta = p.symlink_metadata().ok();
        use std::os::unix::fs::MetadataExt;
        ConflictSide {
            path: p.to_string_lossy().into_owned(),
            is_dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            size: meta.as_ref().and_then(|m| if m.is_dir() { None } else { Some(m.len()) }),
            mtime: meta.as_ref().map(|m| m.mtime() * 1000),
            icon: (self.icon_token)(&self.op_id, p),
        }
    }

    /// Ask the user (blocking, cancellation-aware).
    fn ask(&mut self, kind: ConflictKind, src: &Path, dst: &Path) -> (Resolution, bool) {
        self.conflict_seq += 1;
        let id = self.conflict_seq;
        let (tx, rx): (SyncSender<(Resolution, bool)>, Receiver<(Resolution, bool)>) =
            std::sync::mpsc::sync_channel(1);
        self.handle.pending.lock().unwrap().insert(id, tx);
        self.emitter.emit(OpEvent::Conflict {
            conflict_id: id,
            kind: kind.wire(),
            source: self.side(src),
            dest: self.side(dst),
            remaining: self.remaining_hint,
        });
        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(answer) => return answer,
                Err(RecvTimeoutError::Timeout) => {
                    if self.handle.cancel.load(Ordering::SeqCst) {
                        return (Resolution::Cancel, false);
                    }
                }
                Err(RecvTimeoutError::Disconnected) => return (Resolution::Cancel, false),
            }
        }
    }
}

impl WalkSink for OpSink {
    fn cancelled(&self) -> bool {
        self.handle.cancel.load(Ordering::SeqCst)
    }

    fn progress(&mut self, bytes_delta: u64, entries_delta: u64, current: &Path, cloned: bool) {
        self.bytes += bytes_delta;
        self.entries += entries_delta;
        if cloned {
            self.any_clone = true;
        }
        self.emit_progress(current, false);
    }

    fn item_error(&mut self, path: &Path, err: &io::Error) {
        let e = OpError {
            path: path.to_string_lossy().into_owned(),
            message: err.to_string(),
        };
        self.emitter.emit(OpEvent::ItemError {
            path: e.path.clone(),
            message: e.message.clone(),
        });
        self.errors.push(e);
    }

    fn item_warning(&mut self, path: &Path, message: &str, severity: WarnSeverity) {
        let w = OpWarning {
            path: path.to_string_lossy().into_owned(),
            message: message.to_string(),
            severity,
        };
        self.emitter.emit(OpEvent::Warning {
            path: w.path.clone(),
            message: w.message.clone(),
            severity: w.severity,
        });
        self.warnings.push(w);
    }

    fn skipped_dataless(&mut self, path: &Path) {
        self.skipped.push(path.to_path_buf());
    }

    fn resolve(&mut self, kind: ConflictKind, src: &Path, dst: &Path) -> Resolution {
        // fileDir/dirFile: always an explicit per-item ask — never apply-to-all.
        let per_item_only = matches!(kind, ConflictKind::FileDir | ConflictKind::DirFile);

        if !per_item_only {
            // Op-level policy from the caller.
            match self.op_policy {
                Policy::KeepBoth => return Resolution::KeepBoth,
                Policy::Replace => return Resolution::Replace,
                Policy::Skip => return Resolution::Skip,
                Policy::Ask => {}
            }
            // Cached apply-to-all answer.
            let cached = match kind {
                ConflictKind::FileFile => self.file_policy,
                ConflictKind::DirDir => self.dir_policy,
                _ => None,
            };
            if let Some(r) = cached {
                return r;
            }
        }

        let (resolution, apply_all) = self.ask(kind, src, dst);
        if apply_all && !per_item_only {
            match kind {
                ConflictKind::FileFile => self.file_policy = Some(resolution),
                ConflictKind::DirDir => self.dir_policy = Some(resolution),
                _ => {}
            }
        }
        resolution
    }
}

// ---------------------------------------------------------------------------
// Enumeration (concurrent, never blocks the byte path)
// ---------------------------------------------------------------------------

pub(crate) fn enumerate(sources: &[PathBuf], cancel: &AtomicBool) -> (u64, u64) {
    let mut bytes = 0u64;
    let mut entries = 0u64;
    for s in sources {
        walk_count(s, cancel, &mut bytes, &mut entries);
    }
    (bytes, entries)
}

fn walk_count(p: &Path, cancel: &AtomicBool, bytes: &mut u64, entries: &mut u64) {
    if cancel.load(Ordering::Relaxed) {
        return;
    }
    let Ok(meta) = p.symlink_metadata() else {
        return;
    };
    *entries += 1;
    if meta.file_type().is_dir() {
        if let Ok(rd) = std::fs::read_dir(p) {
            for e in rd.flatten() {
                walk_count(&e.path(), cancel, bytes, entries);
            }
        }
    } else if meta.file_type().is_file() {
        *bytes += meta.len();
    }
}

// ---------------------------------------------------------------------------
// The op itself
// ---------------------------------------------------------------------------

pub fn spawn_op(engine: Arc<Engine>, args: OpArgs, emitter: Arc<dyn OpEmitter>) -> Arc<OpHandle> {
    let handle = OpHandle::new();
    engine.ops.insert(args.op_id.clone(), handle.clone());
    let h = handle.clone();
    std::thread::spawn(move || {
        run_op_thread(engine, args, emitter, h);
    });
    handle
}

/// Duplicate = keep-both copy into each source's own parent dir.
pub fn spawn_duplicate(
    engine: Arc<Engine>,
    op_id: String,
    paths: Vec<PathBuf>,
    emitter: Arc<dyn OpEmitter>,
) -> Arc<OpHandle> {
    let handle = OpHandle::new();
    engine.ops.insert(op_id.clone(), handle.clone());
    let h = handle.clone();
    std::thread::spawn(move || {
        run_duplicate_thread(engine, op_id, paths, emitter, h);
    });
    handle
}

fn run_op_thread(
    engine: Arc<Engine>,
    args: OpArgs,
    emitter: Arc<dyn OpEmitter>,
    handle: Arc<OpHandle>,
) {
    emitter.emit(OpEvent::Started { op_id: args.op_id.clone() });

    // Serialize ops targeting the same destination volume; parallel otherwise.
    let dev = copier::device_of(&args.dest_dir).unwrap_or(0);
    let lock = engine
        .volume_locks
        .entry(dev)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone();
    let _volume_guard = lock.lock().unwrap();

    // Journal intent before any bytes move. Fail-fast: without a durable
    // journal there is no crash protection, so the op must not proceed.
    let mut journal_entry = OpJournalEntry {
        op_id: args.op_id.clone(),
        kind: match args.kind {
            OpKind::Copy => "copy".into(),
            OpKind::Move => "move".into(),
        },
        sources: args.sources.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
        dest_dir: args.dest_dir.to_string_lossy().into_owned(),
        staging: Vec::new(),
        merge_roots: Vec::new(),
        completed: Vec::new(),
        total: args.sources.len(),
        started_at_ms: now_ms(),
    };
    if let Err(e) = engine.journal.write(&journal_entry) {
        engine.ops.remove(&args.op_id);
        emitter.emit(OpEvent::Done {
            status: "failed",
            errors: vec![OpError {
                path: String::new(),
                message: format!("couldn't write the crash-safety journal: {}", e),
            }],
            warnings: Vec::new(),
            skipped_icloud: Vec::new(),
            produced: Vec::new(),
            undoable: false,
        });
        return;
    }

    // Concurrent enumeration: the progress bar acquires a denominator later.
    // Spawned only after the intent write succeeded, so a fail-fast return
    // above can never be followed by a stray Enumerated event.
    {
        let sources = args.sources.clone();
        let cancel_handle = handle.clone();
        let em = emitter.clone();
        std::thread::spawn(move || {
            let (b, e) = enumerate(&sources, &cancel_handle.cancel);
            if !cancel_handle.cancel.load(Ordering::SeqCst) {
                em.emit(OpEvent::Enumerated { total_bytes: b, total_entries: e });
            }
        });
    }

    let mut sink = OpSink::new(
        emitter.clone(),
        handle.clone(),
        args.op_id.clone(),
        engine.icon_token.clone(),
        args.policy,
        args.sources.len(),
    );

    // Cheap conflict pre-scan: top-level destination names only (one readdir).
    let mut dest_names: HashMap<String, String> = HashMap::new();
    if let Ok(rd) = std::fs::read_dir(&args.dest_dir) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            dest_names.insert(n.to_lowercase(), n);
        }
    }

    let tol_ms = walker::mtime_tolerance_ms(&args.dest_dir);
    let mut produced: Vec<PathBuf> = Vec::new();
    let mut move_pairs: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut any_replace = false;
    let mut cancelled = false;

    for (idx, source) in args.sources.iter().enumerate() {
        sink.remaining_hint = args.sources.len() - idx - 1;
        if sink.cancelled() {
            cancelled = true;
            break;
        }
        let Some(name_os) = source.file_name() else {
            sink.item_error(source, &io::Error::new(io::ErrorKind::InvalidInput, "invalid source"));
            continue;
        };
        let name = name_os.to_string_lossy().into_owned();

        let smeta = match source.symlink_metadata() {
            Ok(m) => m,
            Err(e) => {
                sink.item_error(source, &e);
                continue;
            }
        };
        let src_is_dir = smeta.file_type().is_dir();

        // Guards: dest inside source, and no-op same-dir moves.
        if src_is_dir && args.dest_dir.starts_with(source) {
            sink.item_error(
                source,
                &io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "can't move a folder into itself",
                ),
            );
            continue;
        }
        if args.kind == OpKind::Move && source.parent() == Some(args.dest_dir.as_path()) {
            continue; // already there
        }
        if smeta.file_type().is_file() && is_dataless(&smeta) {
            sink.skipped_dataless(source);
            continue;
        }

        // Conflict?
        let existing = dest_names.get(&name.to_lowercase()).cloned();
        let mut final_name = name.clone();
        let mut resolution: Option<Resolution> = None;
        if let Some(actual) = &existing {
            let dpath = args.dest_dir.join(actual);
            let dst_is_dir = dpath.symlink_metadata().map(|m| m.is_dir()).unwrap_or(false);
            let kind = match (src_is_dir, dst_is_dir) {
                (false, false) => ConflictKind::FileFile,
                (true, true) => ConflictKind::DirDir,
                (false, true) => ConflictKind::FileDir,
                (true, false) => ConflictKind::DirFile,
            };
            let r = sink.resolve(kind, source, &dpath);
            match r {
                Resolution::Cancel => {
                    cancelled = true;
                    break;
                }
                Resolution::Skip => continue,
                Resolution::KeepBoth => {
                    final_name = keep_both_name(&args.dest_dir, &name);
                    resolution = None; // proceeds as a fresh transfer
                }
                Resolution::Replace | Resolution::Merge => resolution = Some(r),
            }
        }

        let dest = args.dest_dir.join(&final_name);
        let item_result: Result<Option<PathBuf>, ()> = match resolution {
            Some(Resolution::Merge) => {
                // Per-entry staging tier; journal records the merge root.
                // Fail-fast: an unrecorded merge root would leave per-entry
                // staging invisible to recovery.
                journal_entry.merge_roots.push(dest.to_string_lossy().into_owned());
                if let Err(e) = engine.journal.write(&journal_entry) {
                    journal_entry.merge_roots.pop();
                    sink.item_error(
                        source,
                        &io::Error::new(
                            e.kind(),
                            format!("couldn't write the crash-safety journal: {}", e),
                        ),
                    );
                    continue;
                }
                let ctx = MergeCtx {
                    op_id: &args.op_id,
                    trasher: engine.trasher.as_ref(),
                    moving: args.kind == OpKind::Move,
                    tol_ms,
                };
                match walker::merge_into(source, &dest, &ctx, &mut sink) {
                    Ok(Outcome::Done) => Ok(Some(dest.clone())),
                    Ok(Outcome::Cancelled) => {
                        cancelled = true;
                        Err(())
                    }
                    Err(e) => {
                        sink.item_error(source, &e);
                        Err(())
                    }
                }
            }
            Some(Resolution::Replace) => {
                any_replace = true;
                match replace_item(&engine, &args, source, &dest, &mut journal_entry, tol_ms, &mut sink) {
                    Ok(true) => Ok(Some(dest.clone())),
                    Ok(false) => {
                        cancelled = true;
                        Err(())
                    }
                    Err(e) => {
                        sink.item_error(source, &e);
                        Err(())
                    }
                }
            }
            _ => {
                // Fresh transfer (no conflict, or Keep Both name).
                match transfer_toplevel(&engine, &args, source, &dest, &mut journal_entry, tol_ms, &mut sink) {
                    Ok(true) => Ok(Some(dest.clone())),
                    Ok(false) => {
                        cancelled = true;
                        Err(())
                    }
                    Err(e) => {
                        sink.item_error(source, &e);
                        Err(())
                    }
                }
            }
        };

        if let Ok(Some(dest_path)) = item_result {
            dest_names.insert(final_name.to_lowercase(), final_name.clone());
            journal_entry.completed.push(dest_path.to_string_lossy().into_owned());
            let _ = engine.journal.write(&journal_entry);
            produced.push(dest_path.clone());
            if args.kind == OpKind::Move && resolution.is_none() {
                move_pairs.push((source.clone(), dest_path));
            }
        }
        if cancelled {
            break;
        }
    }

    // Undo journal records only the items that actually succeeded.
    // Replace and merge outcomes are excluded (documented as not undoable).
    let undoable = if args.kind == OpKind::Move {
        !move_pairs.is_empty()
    } else {
        !produced.is_empty() && !any_replace
    };
    if undoable {
        let op = match args.kind {
            OpKind::Move => UndoOp::Move { pairs: move_pairs },
            OpKind::Copy => UndoOp::Copy { produced: produced.clone() },
        };
        engine.undo.lock().unwrap().push(op);
    }

    engine.journal.remove(&args.op_id);
    engine.ops.remove(&args.op_id);

    let skipped: Vec<String> = sink
        .skipped
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let status = if cancelled {
        "cancelled"
    } else if sink.errors.is_empty() && skipped.is_empty() {
        "success"
    } else if produced.is_empty() && !sink.errors.is_empty() {
        "failed"
    } else {
        "partial"
    };
    if !skipped.is_empty() {
        emitter.emit(OpEvent::SkippedIcloud { paths: skipped.clone() });
    }
    emitter.emit(OpEvent::Done {
        status,
        errors: sink.errors.clone(),
        warnings: sink.warnings.clone(),
        skipped_icloud: skipped,
        produced: produced.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
        undoable,
    });
}

/// Fresh transfer of one top-level item to a non-existing `dest`.
/// Returns Ok(false) on cancellation.
fn transfer_toplevel(
    engine: &Engine,
    args: &OpArgs,
    source: &Path,
    dest: &Path,
    journal_entry: &mut OpJournalEntry,
    tol_ms: i64,
    sink: &mut OpSink,
) -> io::Result<bool> {
    if args.kind == OpKind::Move {
        // Rung 1: atomic rename. Genuinely instant — the headline win.
        match copier::rename(source, dest) {
            Ok(()) => {
                sink.progress(0, 1, source, true);
                sink.emit_progress(source, true);
                return Ok(true);
            }
            Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
                // fall through to staged copy + verify + delete
            }
            Err(e) => return Err(e),
        }
    }

    // Staged copy (fresh-copy tier): hidden staging name, one atomic promote.
    let stage = args
        .dest_dir
        .join(staging_name(&dest.file_name().unwrap_or_default().to_string_lossy(), &args.op_id));
    walker::remove_tree_best_effort(&stage);
    // Fail-fast: an unrecorded staging path would be invisible to recovery.
    journal_entry.staging.push(stage.to_string_lossy().into_owned());
    if let Err(e) = engine.journal.write(journal_entry) {
        pop_staging(journal_entry, &stage);
        return Err(io::Error::new(
            e.kind(),
            format!("couldn't write the crash-safety journal: {}", e),
        ));
    }

    let outcome = walker::copy_fresh(source, &stage, sink, DatalessPolicy::Skip)?;
    if outcome == Outcome::Cancelled {
        walker::remove_tree_best_effort(&stage);
        pop_staging(journal_entry, &stage);
        let _ = engine.journal.write(journal_entry);
        return Ok(false);
    }

    if args.kind == OpKind::Move {
        // Verify before deleting the source — that item is deleted only after
        // *it* verifies; a crash mid-move never loses data.
        let skipped: HashSet<PathBuf> = sink.skipped.iter().cloned().collect();
        let report = walker::verify_tree(source, &stage, &skipped, tol_ms)?;
        if !report.mismatches.is_empty() {
            walker::remove_tree_best_effort(&stage);
            pop_staging(journal_entry, &stage);
            let _ = engine.journal.write(journal_entry);
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("verification failed: {}", report.mismatches.join("; ")),
            ));
        }
    }

    match copier::rename_excl(&stage, dest) {
        Ok(()) => {}
        Err(e) => {
            walker::remove_tree_best_effort(&stage);
            pop_staging(journal_entry, &stage);
            let _ = engine.journal.write(journal_entry);
            return Err(e);
        }
    }
    pop_staging(journal_entry, &stage);

    if args.kind == OpKind::Move {
        walker::remove_tree_best_effort(source);
    }
    Ok(true)
}

/// Replace transaction.
///
/// Move-kind, same volume: direct swap of source and dest — the source is
/// never staged, so a staging path never holds the only copy of data and
/// recovery's "delete all staging" stays universally correct.
///
/// Copy-kind (and cross-volume move): stage fully next to the destination,
/// swap atomically (or trash-promote-restore on non-swap filesystems), old
/// original → Trash. The stage only ever holds a throwaway copy.
fn replace_item(
    engine: &Engine,
    args: &OpArgs,
    source: &Path,
    dest: &Path,
    journal_entry: &mut OpJournalEntry,
    tol_ms: i64,
    sink: &mut OpSink,
) -> io::Result<bool> {
    if args.kind == OpKind::Move {
        // Direct swap — no staging, no journal write needed.
        match walker::replace_with_staged(source, dest, engine.trasher.as_ref()) {
            Ok(ReplaceOutcome::Replaced { .. }) => return Ok(true),
            Ok(ReplaceOutcome::TrashFailed { leftover, error }) => {
                // Leftover old original sits at the SOURCE path — never a
                // staging name, safe from recovery. Warn, never delete it.
                sink.item_warning(
                    &leftover,
                    &format!(
                        "Replaced \"{}\", but the previous version couldn't be moved to the Trash ({}). It was left at \"{}\".",
                        dest.display(),
                        error,
                        leftover.display()
                    ),
                    WarnSeverity::Warning,
                );
                return Ok(true);
            }
            Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
                // Cross-volume: fall through to the staged copy path.
            }
            Err(e) => return Err(e),
        }
    }

    let stage = args
        .dest_dir
        .join(staging_name(&dest.file_name().unwrap_or_default().to_string_lossy(), &args.op_id));
    walker::remove_tree_best_effort(&stage);
    // Fail-fast: an unrecorded staging path would be invisible to recovery.
    journal_entry.staging.push(stage.to_string_lossy().into_owned());
    if let Err(e) = engine.journal.write(journal_entry) {
        pop_staging(journal_entry, &stage);
        return Err(io::Error::new(
            e.kind(),
            format!("couldn't write the crash-safety journal: {}", e),
        ));
    }

    let outcome = walker::copy_fresh(source, &stage, sink, DatalessPolicy::Skip)?;
    if outcome == Outcome::Cancelled {
        walker::remove_tree_best_effort(&stage);
        pop_staging(journal_entry, &stage);
        let _ = engine.journal.write(journal_entry);
        return Ok(false);
    }
    if args.kind == OpKind::Move {
        let skipped: HashSet<PathBuf> = sink.skipped.iter().cloned().collect();
        let report = walker::verify_tree(source, &stage, &skipped, tol_ms)?;
        if !report.mismatches.is_empty() {
            walker::remove_tree_best_effort(&stage);
            pop_staging(journal_entry, &stage);
            let _ = engine.journal.write(journal_entry);
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("verification failed: {}", report.mismatches.join("; ")),
            ));
        }
    }

    match walker::replace_with_staged(&stage, dest, engine.trasher.as_ref()) {
        Ok(ReplaceOutcome::Replaced { .. }) => {
            pop_staging(journal_entry, &stage);
            if args.kind == OpKind::Move {
                walker::remove_tree_best_effort(source);
            }
            Ok(true)
        }
        Ok(ReplaceOutcome::TrashFailed { leftover, error }) => {
            // The leftover old original sits at the stage path, which is
            // recorded in `journal_entry.staging` — a crash before the pop
            // lands would make recovery delete it. Required order:
            // (1) rename out of staging, (2) pop + best-effort journal write,
            // (3) remove source if move, (4) warn.
            let name = dest.file_name().unwrap_or_default().to_string_lossy().into_owned();
            let rescue = walker::rescue_leftover(&leftover, &args.op_id, &name);
            pop_staging(journal_entry, &stage);
            let _ = engine.journal.write(journal_entry);
            if args.kind == OpKind::Move {
                walker::remove_tree_best_effort(source);
            }
            match rescue {
                Ok(final_path) => sink.item_warning(
                    &final_path,
                    &format!(
                        "Replaced \"{}\", but the previous version couldn't be moved to the Trash ({}). It was left at \"{}\".",
                        dest.display(),
                        error,
                        final_path.display()
                    ),
                    WarnSeverity::Warning,
                ),
                Err(rename_err) => sink.item_warning(
                    &leftover,
                    &format!(
                        "Replaced \"{}\", but the previous version couldn't be moved to the Trash ({}) or renamed to a safe name ({}). It remains at \"{}\" and may be removed if the app crashes before this operation's record clears — rescue it manually.",
                        dest.display(),
                        error,
                        rename_err,
                        leftover.display()
                    ),
                    WarnSeverity::Critical,
                ),
            }
            Ok(true)
        }
        Err(e) => {
            // Only ever a throwaway copy now — the source was never renamed
            // into staging.
            walker::remove_tree_best_effort(&stage);
            pop_staging(journal_entry, &stage);
            let _ = engine.journal.write(journal_entry);
            Err(e)
        }
    }
}

fn pop_staging(journal_entry: &mut OpJournalEntry, stage: &Path) {
    let s = stage.to_string_lossy();
    journal_entry.staging.retain(|p| p != s.as_ref());
}

fn run_duplicate_thread(
    engine: Arc<Engine>,
    op_id: String,
    paths: Vec<PathBuf>,
    emitter: Arc<dyn OpEmitter>,
    handle: Arc<OpHandle>,
) {
    emitter.emit(OpEvent::Started { op_id: op_id.clone() });

    // Journal intent before any bytes move. Fail-fast: without a durable
    // journal there is no crash protection, so the op must not proceed.
    let mut journal_entry = OpJournalEntry {
        op_id: op_id.clone(),
        kind: "duplicate".into(),
        sources: paths.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
        dest_dir: String::new(),
        staging: Vec::new(),
        merge_roots: Vec::new(),
        completed: Vec::new(),
        total: paths.len(),
        started_at_ms: now_ms(),
    };
    if let Err(e) = engine.journal.write(&journal_entry) {
        engine.ops.remove(&op_id);
        emitter.emit(OpEvent::Done {
            status: "failed",
            errors: vec![OpError {
                path: String::new(),
                message: format!("couldn't write the crash-safety journal: {}", e),
            }],
            warnings: Vec::new(),
            skipped_icloud: Vec::new(),
            produced: Vec::new(),
            undoable: false,
        });
        return;
    }

    // Spawned only after the intent write succeeded (see run_op_thread).
    {
        let sources = paths.clone();
        let cancel_handle = handle.clone();
        let em = emitter.clone();
        std::thread::spawn(move || {
            let (b, e) = enumerate(&sources, &cancel_handle.cancel);
            if !cancel_handle.cancel.load(Ordering::SeqCst) {
                em.emit(OpEvent::Enumerated { total_bytes: b, total_entries: e });
            }
        });
    }

    let mut sink = OpSink::new(
        emitter.clone(),
        handle.clone(),
        op_id.clone(),
        engine.icon_token.clone(),
        Policy::KeepBoth,
        paths.len(),
    );

    let mut produced = Vec::new();
    let mut cancelled = false;
    for source in &paths {
        if sink.cancelled() {
            cancelled = true;
            break;
        }
        let Some(parent) = source.parent() else {
            continue;
        };
        let Some(name) = source.file_name() else {
            continue;
        };
        let dup = walker::duplicate_name(parent, &name.to_string_lossy());
        let dest = parent.join(&dup);
        let stage = parent.join(staging_name(&dup, &op_id));
        walker::remove_tree_best_effort(&stage);
        // Fail-fast: an unrecorded staging path would be invisible to recovery.
        journal_entry.staging.push(stage.to_string_lossy().into_owned());
        if let Err(e) = engine.journal.write(&journal_entry) {
            pop_staging(&mut journal_entry, &stage);
            sink.item_error(
                source,
                &io::Error::new(
                    e.kind(),
                    format!("couldn't write the crash-safety journal: {}", e),
                ),
            );
            continue;
        }

        match walker::copy_fresh(source, &stage, &mut sink, DatalessPolicy::Skip) {
            Ok(Outcome::Done) => match copier::rename_excl(&stage, &dest) {
                Ok(()) => {
                    pop_staging(&mut journal_entry, &stage);
                    journal_entry.completed.push(dest.to_string_lossy().into_owned());
                    let _ = engine.journal.write(&journal_entry);
                    produced.push(dest);
                }
                Err(e) => {
                    walker::remove_tree_best_effort(&stage);
                    pop_staging(&mut journal_entry, &stage);
                    sink.item_error(source, &e);
                }
            },
            Ok(Outcome::Cancelled) => {
                walker::remove_tree_best_effort(&stage);
                pop_staging(&mut journal_entry, &stage);
                cancelled = true;
                break;
            }
            Err(e) => {
                walker::remove_tree_best_effort(&stage);
                pop_staging(&mut journal_entry, &stage);
                sink.item_error(source, &e);
            }
        }
    }

    if !produced.is_empty() {
        engine.undo.lock().unwrap().push(UndoOp::Copy { produced: produced.clone() });
    }
    engine.journal.remove(&op_id);
    engine.ops.remove(&op_id);

    let status = if cancelled {
        "cancelled"
    } else if sink.errors.is_empty() {
        "success"
    } else if produced.is_empty() {
        "failed"
    } else {
        "partial"
    };
    emitter.emit(OpEvent::Done {
        status,
        errors: sink.errors.clone(),
        warnings: sink.warnings.clone(),
        skipped_icloud: Vec::new(),
        produced: produced.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
        undoable: !produced.is_empty(),
    });
}
