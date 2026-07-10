//! Archive engine: compress (Finder-compatible zip via `/usr/bin/ditto`) and
//! extract (zip via ditto, tar family via `/usr/bin/tar`), built on the same
//! rails as copy/duplicate — hidden staging names, durable journal, atomic
//! `rename_excl` promote, cancellation, undo.
//!
//! Contracts (see plan):
//! - Compress is all-or-nothing: one output artifact, journal `total: 1`; any
//!   staging failure aborts the whole op and produces no zip.
//! - Extract is per-archive: each archive succeeds or fails independently;
//!   `ItemError.path` is ALWAYS the archive path (retry re-extracts archives,
//!   never internal staging paths).
//! - Post-extract validation is the promotion gate — promotion never runs
//!   without `validate_staging` passing, even when ditto/tar exit 0.

use std::collections::VecDeque;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::core::copier;
use crate::core::journal::OpJournalEntry;
use crate::core::op_queue::{enumerate, now_ms, Engine, OpEmitter, OpError, OpEvent, OpHandle};
use crate::core::undo::{ProducedKind, UndoOp};
use crate::core::walker::{
    self, keep_both_name, staging_name, ConflictKind, Outcome, Resolution, WalkSink,
};

const DITTO: &str = "/usr/bin/ditto";
const BSDTAR: &str = "/usr/bin/tar";
/// Bounded stderr tail kept for error messages.
const STDERR_TAIL_BYTES: usize = 4096;

// ---------------------------------------------------------------------------
// Naming helpers
// ---------------------------------------------------------------------------

/// Strip a known archive suffix (ASCII-case-insensitive tail compare — never
/// lowercases the whole name, and never splits inside a multibyte char).
pub fn archive_stem(name: &str) -> &str {
    // Longest suffixes first so ".tar.gz" wins over a hypothetical ".gz".
    const SUFFIXES: &[&str] = &[".tar.bz2", ".tar.gz", ".tar.xz", ".tgz", ".tar", ".zip"];
    for suffix in SUFFIXES {
        if name.len() > suffix.len() {
            let split = name.len() - suffix.len();
            if name.is_char_boundary(split) && name[split..].eq_ignore_ascii_case(suffix) {
                return &name[..split];
            }
        }
    }
    name
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveKind {
    Zip,
    Tar,
}

/// Which tool extracts this file, if any. Lone `.gz` is deliberately not
/// extractable (matches the scoped feature set).
pub fn archive_kind(name: &str) -> Option<ArchiveKind> {
    let ends = |suffix: &str| {
        name.len() > suffix.len() && {
            let split = name.len() - suffix.len();
            name.is_char_boundary(split) && name[split..].eq_ignore_ascii_case(suffix)
        }
    };
    if ends(".zip") {
        Some(ArchiveKind::Zip)
    } else if ends(".tar") || ends(".tgz") || ends(".tar.gz") || ends(".tar.bz2") || ends(".tar.xz")
    {
        Some(ArchiveKind::Tar)
    } else {
        None
    }
}

/// Per-archive staging dir name. `staging_name` alone collides when a batch
/// extracts two archives with the same basename — the batch index keeps the
/// names unique (and still matching `is_staging_name` for recovery).
pub fn staging_name_for_archive(archive: &Path, index: usize, op_id: &str) -> String {
    let name = archive
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    format!(".{}.{}.fazi-partial-{}", name, index, op_id)
}

/// Root-level metadata names that are never payload.
fn is_ignored_root_name(name: &str) -> bool {
    name == "__MACOSX" || name == ".DS_Store"
}

// ---------------------------------------------------------------------------
// Subprocess plumbing
// ---------------------------------------------------------------------------

/// Run a child to completion with a single owner of its lifecycle: one loop
/// does `try_wait` → (on cancel) `kill` + `wait` — no watchdog thread racing
/// the wait. stderr drains in a dedicated reader (a child blocked on a full
/// pipe never exits); the reader is joined only after the child is reaped, so
/// EOF is guaranteed. Returns the exit status and a bounded stderr tail.
fn run_child_cancellable(cmd: &mut Command, handle: &OpHandle) -> io::Result<(ExitStatus, String)> {
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;

    let stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut tail: VecDeque<u8> = VecDeque::with_capacity(STDERR_TAIL_BYTES);
        if let Some(mut pipe) = stderr {
            let mut buf = [0u8; 1024];
            loop {
                match pipe.read(&mut buf) {
                    // EOF or read error both end the drain (defensive: the
                    // reader must always terminate once the pipe closes).
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        for &b in &buf[..n] {
                            if tail.len() >= STDERR_TAIL_BYTES {
                                tail.pop_front();
                            }
                            tail.push_back(b);
                        }
                    }
                }
            }
        }
        let bytes: Vec<u8> = tail.into_iter().collect();
        String::from_utf8_lossy(&bytes).trim().to_string()
    });

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if handle.cancel.load(Ordering::SeqCst) {
                    let _ = child.kill();
                    // Same thread reaps — no second waiter anywhere.
                    match child.wait() {
                        Ok(status) => break status,
                        Err(e) => {
                            let _ = reader.join();
                            return Err(e);
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err(e);
            }
        }
    };
    // Child reaped → its stderr write end is closed → reader hits EOF.
    let tail = reader.join().unwrap_or_default();
    Ok((status, tail))
}

/// User-facing failure message for a subprocess: `status.to_string()` covers
/// both exit codes and signal deaths (`code()` is None on signals — never
/// unwrap it), plus the stderr tail when non-empty.
fn child_failure_message(tool: &str, status: &ExitStatus, stderr_tail: &str) -> String {
    if stderr_tail.is_empty() {
        format!("{} failed: {}", tool, status)
    } else {
        format!("{} failed: {}: {}", tool, status, stderr_tail)
    }
}

// ---------------------------------------------------------------------------
// The archive sink (staging-copy progress + fail-fast error collection)
// ---------------------------------------------------------------------------

/// WalkSink for the compress staging copy. Progress rides a monotonic byte
/// ratchet shared with the ditto poll thread; the first item error flips
/// `aborted` so `copy_fresh` stops between entries (fail fast) instead of
/// copying a huge tree only for the all-or-nothing check to discard it.
struct ArchiveSink {
    emitter: Arc<dyn OpEmitter>,
    handle: Arc<OpHandle>,
    ratchet: Arc<AtomicU64>,
    entries: u64,
    last_emit: Instant,
    errors: Vec<OpError>,
    /// Set on the first item error — an error abort, distinct from user cancel.
    aborted: bool,
}

impl ArchiveSink {
    fn new(emitter: Arc<dyn OpEmitter>, handle: Arc<OpHandle>, ratchet: Arc<AtomicU64>) -> Self {
        ArchiveSink {
            emitter,
            handle,
            ratchet,
            entries: 0,
            last_emit: Instant::now(),
            errors: Vec::new(),
            aborted: false,
        }
    }

    fn emit_progress(&mut self, current: &Path, force: bool) {
        if force || self.last_emit.elapsed() >= Duration::from_millis(80) {
            self.last_emit = Instant::now();
            self.emitter.emit(OpEvent::Progress {
                bytes_done: self.ratchet.load(Ordering::SeqCst),
                entries_done: self.entries,
                current_path: current.to_string_lossy().into_owned(),
                cloned: false,
            });
        }
    }
}

impl WalkSink for ArchiveSink {
    fn cancelled(&self) -> bool {
        self.handle.cancel.load(Ordering::SeqCst) || self.aborted
    }

    fn progress(&mut self, bytes_delta: u64, entries_delta: u64, current: &Path, _cloned: bool) {
        self.ratchet.fetch_add(bytes_delta, Ordering::SeqCst);
        self.entries += entries_delta;
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
        // Fail fast: an incomplete zip is data loss, so stop staging now.
        self.aborted = true;
    }

    fn resolve(&mut self, _: ConflictKind, _: &Path, _: &Path) -> Resolution {
        // Staging dirs are fresh — conflicts are impossible.
        Resolution::Skip
    }
}

// ---------------------------------------------------------------------------
// Shared run-thread helpers
// ---------------------------------------------------------------------------

fn journal_write_fail_fast(
    engine: &Engine,
    entry: &OpJournalEntry,
    op_id: &str,
    emitter: &Arc<dyn OpEmitter>,
) -> bool {
    if let Err(e) = engine.journal.write(entry) {
        engine.ops.remove(op_id);
        emitter.emit(OpEvent::Done {
            status: "failed",
            errors: vec![OpError {
                path: String::new(),
                message: format!("couldn't write the crash-safety journal: {}", e),
            }],
            warnings: Vec::new(),
            produced: Vec::new(),
            undoable: false,
        });
        return false;
    }
    true
}

fn pop_staging(journal_entry: &mut OpJournalEntry, stage: &Path) {
    let s = stage.to_string_lossy();
    journal_entry.staging.retain(|p| p != s.as_ref());
}

/// Promote `stage_item` into `dest_dir` under `base`, uniquifying with
/// `unique` and retrying the keep-both computation once on an EEXIST race.
fn promote_unique(
    stage_item: &Path,
    dest_dir: &Path,
    base: &str,
    unique: &dyn Fn(&Path, &str) -> String,
) -> io::Result<PathBuf> {
    let mut name = if walker::exists_ci(dest_dir, base) {
        unique(dest_dir, base)
    } else {
        base.to_string()
    };
    for attempt in 0..2 {
        let dest = dest_dir.join(&name);
        match copier::rename_excl(stage_item, &dest) {
            Ok(()) => return Ok(dest),
            Err(e) if e.raw_os_error() == Some(libc::EEXIST) && attempt == 0 => {
                // Race: something claimed the name after the check.
                name = unique(dest_dir, base);
            }
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::from_raw_os_error(libc::EEXIST))
}

// ---------------------------------------------------------------------------
// Compress
// ---------------------------------------------------------------------------

pub fn spawn_compress(
    engine: Arc<Engine>,
    op_id: String,
    sources: Vec<PathBuf>,
    dest_dir: PathBuf,
    emitter: Arc<dyn OpEmitter>,
) -> Arc<OpHandle> {
    let handle = OpHandle::new();
    engine.ops.insert(op_id.clone(), handle.clone());
    let h = handle.clone();
    std::thread::spawn(move || {
        run_compress_thread(engine, op_id, sources, dest_dir, emitter, h);
    });
    handle
}

fn run_compress_thread(
    engine: Arc<Engine>,
    op_id: String,
    sources: Vec<PathBuf>,
    dest_dir: PathBuf,
    emitter: Arc<dyn OpEmitter>,
    handle: Arc<OpHandle>,
) {
    emitter.emit(OpEvent::Started { op_id: op_id.clone() });

    let fail = |errors: Vec<OpError>| {
        engine.ops.remove(&op_id);
        emitter.emit(OpEvent::Done {
            status: "failed",
            errors,
            warnings: Vec::new(),
            produced: Vec::new(),
            undoable: false,
        });
    };

    // Read-only guards before any journal or staging work.
    if sources.is_empty() {
        fail(vec![OpError { path: String::new(), message: "nothing to compress".into() }]);
        return;
    }
    let mut guard_errors: Vec<OpError> = Vec::new();
    let mut single_source_is_dir = false;
    for source in &sources {
        let meta = match source.symlink_metadata() {
            Ok(m) => m,
            Err(e) => {
                guard_errors.push(OpError {
                    path: source.to_string_lossy().into_owned(),
                    message: e.to_string(),
                });
                break;
            }
        };
        let is_dir = meta.file_type().is_dir();
        if sources.len() == 1 {
            single_source_is_dir = is_dir;
        }
        // dest inside a selected folder would self-include the staging zip.
        if is_dir && dest_dir.starts_with(source) {
            guard_errors.push(OpError {
                path: source.to_string_lossy().into_owned(),
                message: "can't create an archive inside the folder being compressed".into(),
            });
            break;
        }
        if !is_dir && dest_dir.as_path() == source.as_path() {
            guard_errors.push(OpError {
                path: source.to_string_lossy().into_owned(),
                message: "invalid destination".into(),
            });
            break;
        }
    }
    if !guard_errors.is_empty() {
        // All-or-nothing: a single bad source fails the whole op.
        for e in &guard_errors {
            emitter.emit(OpEvent::ItemError { path: e.path.clone(), message: e.message.clone() });
        }
        fail(guard_errors);
        return;
    }

    // Serialize ops targeting the same destination volume; parallel otherwise.
    let dev = copier::device_of(&dest_dir).unwrap_or(0);
    let lock = engine
        .volume_locks
        .entry(dev)
        .or_insert_with(|| Arc::new(std::sync::Mutex::new(())))
        .clone();
    let _volume_guard = lock.lock().unwrap();

    // Zip name: 1 item → "<name>.zip", N items → "Archive.zip"; keep-both.
    let base_zip_name = if sources.len() == 1 {
        format!("{}.zip", sources[0].file_name().unwrap_or_default().to_string_lossy())
    } else {
        "Archive.zip".to_string()
    };
    let zip_name = if walker::exists_ci(&dest_dir, &base_zip_name) {
        keep_both_name(&dest_dir, &base_zip_name)
    } else {
        base_zip_name.clone()
    };
    let stage_zip = dest_dir.join(staging_name(&zip_name, &op_id));
    let multi = sources.len() > 1;
    let stage_contents =
        dest_dir.join(staging_name(&format!("{}.contents", zip_name), &op_id));
    walker::remove_tree_best_effort(&stage_zip);
    if multi {
        walker::remove_tree_best_effort(&stage_contents);
    }

    // Journal EVERY staging path before anything is written to it — including
    // the contents dir, so a crash during pre-archive staging is recovered.
    let mut journal_entry = OpJournalEntry {
        op_id: op_id.clone(),
        kind: "compress".into(),
        sources: sources.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
        dest_dir: dest_dir.to_string_lossy().into_owned(),
        staging: {
            let mut s = vec![stage_zip.to_string_lossy().into_owned()];
            if multi {
                s.push(stage_contents.to_string_lossy().into_owned());
            }
            s
        },
        merge_roots: Vec::new(),
        completed: Vec::new(),
        // All-or-nothing: ONE output artifact — never sources.len(), which
        // would lie in the interrupted-op toast.
        total: 1,
        started_at_ms: now_ms(),
    };
    if !journal_write_fail_fast(&engine, &journal_entry, &op_id, &emitter) {
        return;
    }

    // Concurrent enumeration — never blocks archive creation.
    {
        let sources = sources.clone();
        let cancel_handle = handle.clone();
        let em = emitter.clone();
        std::thread::spawn(move || {
            let (b, e) = enumerate(&sources, &cancel_handle.cancel);
            if !cancel_handle.cancel.load(Ordering::SeqCst) {
                em.emit(OpEvent::Enumerated { total_bytes: b, total_entries: e });
            }
        });
    }

    let ratchet = Arc::new(AtomicU64::new(0));
    let mut sink = ArchiveSink::new(emitter.clone(), handle.clone(), ratchet.clone());

    let cleanup_staging = |journal_entry: &mut OpJournalEntry| {
        walker::remove_tree_best_effort(&stage_zip);
        if multi {
            walker::remove_tree_best_effort(&stage_contents);
        }
        pop_staging(journal_entry, &stage_zip);
        pop_staging(journal_entry, &stage_contents);
        let _ = engine.journal.write(journal_entry);
    };

    // Staging phase (multi-item only): materializing copy into a contents dir
    // whose layout becomes the zip root.
    let mut cancelled = false;
    let mut staging_failed = false;
    if multi {
        if let Err(e) = std::fs::create_dir(&stage_contents) {
            sink.item_error(&stage_contents, &e);
            staging_failed = true;
        } else {
            for source in &sources {
                if handle.cancel.load(Ordering::SeqCst) {
                    cancelled = true;
                    break;
                }
                let Some(name_os) = source.file_name() else {
                    sink.item_error(
                        source,
                        &io::Error::new(io::ErrorKind::InvalidInput, "invalid source"),
                    );
                    staging_failed = true;
                    break;
                };
                let name = name_os.to_string_lossy().into_owned();
                // Duplicate top-level basenames from different parents get
                // keep-both names inside the archive (Finder behavior).
                let target_name = if walker::exists_ci(&stage_contents, &name) {
                    keep_both_name(&stage_contents, &name)
                } else {
                    name
                };
                // All-or-nothing backstop: `copy_fresh` records child failures
                // via the sink but still returns Done for a directory with
                // failed children — snapshot the error count around each copy.
                let errors_before = sink.errors.len();
                // Dataless sources surface as item errors via the sink's
                // fail-fast abort — an incomplete zip is never produced.
                match walker::copy_fresh(source, &stage_contents.join(&target_name), &mut sink) {
                    Ok(Outcome::Done) => {
                        if sink.errors.len() > errors_before {
                            staging_failed = true;
                            break;
                        }
                    }
                    Ok(Outcome::Cancelled) => {
                        // Either user cancel or the sink's fail-fast abort.
                        if handle.cancel.load(Ordering::SeqCst) {
                            cancelled = true;
                        } else {
                            staging_failed = true;
                        }
                        break;
                    }
                    Err(e) => {
                        sink.item_error(source, &e);
                        staging_failed = true;
                        break;
                    }
                }
            }
        }
    }

    if cancelled || staging_failed {
        cleanup_staging(&mut journal_entry);
        engine.journal.remove(&op_id);
        engine.ops.remove(&op_id);
        emitter.emit(OpEvent::Done {
            status: if cancelled { "cancelled" } else { "failed" },
            errors: sink.errors.clone(),
            warnings: Vec::new(),
            produced: Vec::new(),
            undoable: false,
        });
        return;
    }

    // ditto phase.
    let mut cmd = Command::new(DITTO);
    cmd.arg("-c").arg("-k").arg("--sequesterRsrc");
    if multi {
        // Contents dir without --keepParent: entries land at zip root,
        // matching Finder's multi-select "Archive.zip".
        cmd.arg(&stage_contents).arg(&stage_zip);
    } else {
        // --keepParent ONLY for a directory/package source; for a single
        // regular file it would store "parent/file.txt" instead of "file.txt".
        if single_source_is_dir {
            cmd.arg("--keepParent");
        }
        cmd.arg(&sources[0]).arg(&stage_zip);
    }

    // 250ms zip-size poll — candidate progress through the shared ratchet.
    // The stop flag is set on ANY outcome before Done; the thread is joined
    // before Done is emitted so no Progress can land after the card is gone.
    let poll_stop = Arc::new(AtomicBool::new(false));
    let poll = {
        let stop = poll_stop.clone();
        let ratchet = ratchet.clone();
        let em = emitter.clone();
        let zip = stage_zip.clone();
        let entries_done = sink.entries;
        std::thread::spawn(move || loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            if let Ok(meta) = zip.symlink_metadata() {
                let candidate = meta.len();
                let prev = ratchet.fetch_max(candidate, Ordering::SeqCst);
                let now = prev.max(candidate);
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                em.emit(OpEvent::Progress {
                    bytes_done: now,
                    entries_done,
                    current_path: zip.to_string_lossy().into_owned(),
                    cloned: false,
                });
            }
            // 250ms in short slices so the join after stop is prompt.
            for _ in 0..10 {
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        })
    };
    let stop_poll = |poll: std::thread::JoinHandle<()>| {
        poll_stop.store(true, Ordering::SeqCst);
        let _ = poll.join();
    };

    let child_result = run_child_cancellable(&mut cmd, &handle);
    stop_poll(poll);

    let finish = |status: &'static str, errors: Vec<OpError>, produced: Vec<PathBuf>| {
        let undoable = !produced.is_empty();
        if undoable {
            engine.undo.lock().unwrap().push(UndoOp::ProducedItems {
                kind: ProducedKind::Compress,
                pairs: produced.iter().map(|p| (p.clone(), None)).collect(),
            });
        }
        engine.journal.remove(&op_id);
        engine.ops.remove(&op_id);
        emitter.emit(OpEvent::Done {
            status,
            errors,
            warnings: Vec::new(),
            produced: produced.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
            undoable,
        });
    };

    // Cancel flag wins even if ditto exited successfully after the kill.
    if handle.cancel.load(Ordering::SeqCst) {
        cleanup_staging(&mut journal_entry);
        finish("cancelled", sink.errors.clone(), Vec::new());
        return;
    }

    match child_result {
        Err(e) => {
            let err = OpError {
                path: sources[0].to_string_lossy().into_owned(),
                message: format!("couldn't run ditto: {}", e),
            };
            emitter.emit(OpEvent::ItemError {
                path: err.path.clone(),
                message: err.message.clone(),
            });
            cleanup_staging(&mut journal_entry);
            let mut errors = sink.errors.clone();
            errors.push(err);
            finish("failed", errors, Vec::new());
        }
        Ok((status, stderr_tail)) if !status.success() => {
            let err = OpError {
                path: sources[0].to_string_lossy().into_owned(),
                message: child_failure_message("ditto", &status, &stderr_tail),
            };
            emitter.emit(OpEvent::ItemError {
                path: err.path.clone(),
                message: err.message.clone(),
            });
            cleanup_staging(&mut journal_entry);
            let mut errors = sink.errors.clone();
            errors.push(err);
            finish("failed", errors, Vec::new());
        }
        Ok(_) => {
            // Promote the staged zip; contents dir is now disposable.
            if multi {
                walker::remove_tree_best_effort(&stage_contents);
                pop_staging(&mut journal_entry, &stage_contents);
                let _ = engine.journal.write(&journal_entry);
            }
            match promote_unique(&stage_zip, &dest_dir, &zip_name, &keep_both_name) {
                Ok(dest) => {
                    pop_staging(&mut journal_entry, &stage_zip);
                    journal_entry.completed.push(dest.to_string_lossy().into_owned());
                    let _ = engine.journal.write(&journal_entry);
                    // Snap the bar to the final zip size.
                    if let Ok(meta) = dest.symlink_metadata() {
                        ratchet.fetch_max(meta.len(), Ordering::SeqCst);
                    }
                    emitter.emit(OpEvent::Progress {
                        bytes_done: ratchet.load(Ordering::SeqCst),
                        entries_done: sink.entries,
                        current_path: dest.to_string_lossy().into_owned(),
                        cloned: false,
                    });
                    finish("success", Vec::new(), vec![dest]);
                }
                Err(e) => {
                    let err = OpError {
                        path: sources[0].to_string_lossy().into_owned(),
                        message: format!("couldn't move the archive into place: {}", e),
                    };
                    emitter.emit(OpEvent::ItemError {
                        path: err.path.clone(),
                        message: err.message.clone(),
                    });
                    cleanup_staging(&mut journal_entry);
                    let mut errors = sink.errors.clone();
                    errors.push(err);
                    finish("failed", errors, Vec::new());
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

pub fn spawn_extract(
    engine: Arc<Engine>,
    op_id: String,
    archives: Vec<PathBuf>,
    dest_dir: PathBuf,
    emitter: Arc<dyn OpEmitter>,
) -> Arc<OpHandle> {
    let handle = OpHandle::new();
    engine.ops.insert(op_id.clone(), handle.clone());
    let h = handle.clone();
    std::thread::spawn(move || {
        run_extract_thread(engine, op_id, archives, dest_dir, emitter, h);
    });
    handle
}

/// Validate an extracted staging tree before ANY promote — the gate behind
/// the path-traversal tests. Rejects `..`/absolute components and symlinks
/// whose target escapes the staging root (checked lexically; the walk itself
/// never follows symlinks). Returns Err("archive contains no extractable
/// content") for empty or metadata-only archives.
pub fn validate_staging(staging_dir: &Path) -> Result<(), String> {
    fn walk(root: &Path, dir: &Path, payload_seen: &mut bool) -> Result<(), String> {
        let rd = std::fs::read_dir(dir)
            .map_err(|e| format!("couldn't inspect extracted content: {}", e))?;
        for entry in rd.flatten() {
            let path = entry.path();
            // Defense in depth: reject any structurally unsafe relative path.
            let rel = path.strip_prefix(root).map_err(|_| {
                format!("extracted entry escapes the staging area: {}", path.display())
            })?;
            for comp in rel.components() {
                match comp {
                    Component::Normal(_) => {}
                    _ => {
                        return Err(format!(
                            "unsafe path in archive: {}",
                            rel.to_string_lossy()
                        ))
                    }
                }
            }
            let meta = entry
                .path()
                .symlink_metadata()
                .map_err(|e| format!("couldn't inspect extracted content: {}", e))?;
            if meta.file_type().is_symlink() {
                if symlink_escapes(root, &path) {
                    return Err(format!(
                        "unsafe link in archive: {}",
                        rel.to_string_lossy()
                    ));
                }
            } else if meta.file_type().is_dir() {
                walk(root, &path, payload_seen)?;
            }
            // Payload classification: root-level .DS_Store and the __MACOSX
            // tree are never payload.
            let at_root = rel.components().count() == 1;
            let name = entry.file_name().to_string_lossy().into_owned();
            let in_macosx = rel
                .components()
                .next()
                .map(|c| c.as_os_str() == "__MACOSX")
                .unwrap_or(false);
            if !in_macosx && !(at_root && is_ignored_root_name(&name)) {
                *payload_seen = true;
            }
        }
        Ok(())
    }

    let mut payload_seen = false;
    walk(staging_dir, staging_dir, &mut payload_seen)?;
    if !payload_seen {
        return Err("archive contains no extractable content".into());
    }
    Ok(())
}

/// Lexical escape check for a symlink inside `root`: absolute targets and
/// targets with enough `..` to climb out of `root` are rejected.
fn symlink_escapes(root: &Path, link: &Path) -> bool {
    let Ok(target) = std::fs::read_link(link) else {
        return true;
    };
    if target.is_absolute() {
        return true;
    }
    // Depth of the link's parent below root.
    let mut depth: i64 = link
        .parent()
        .and_then(|p| p.strip_prefix(root).ok())
        .map(|rel| rel.components().count() as i64)
        .unwrap_or(0);
    for comp in target.components() {
        match comp {
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return true;
                }
            }
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            _ => return true,
        }
    }
    false
}

/// Root entries of the staging dir minus ignored metadata.
fn payload_root_entries(staging_dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(staging_dir)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_ignored_root_name(&name) {
            continue;
        }
        out.push(entry.path());
    }
    Ok(out)
}

/// Remove `__MACOSX` and the root `.DS_Store` from the staging dir before a
/// multi-entry promote (nested .DS_Store inside payload dirs are left alone,
/// same as Finder).
fn strip_metadata(staging_dir: &Path) {
    walker::remove_tree_best_effort(&staging_dir.join("__MACOSX"));
    let ds = staging_dir.join(".DS_Store");
    if ds.symlink_metadata().is_ok() {
        let _ = std::fs::remove_file(&ds);
    }
}

fn run_extract_thread(
    engine: Arc<Engine>,
    op_id: String,
    archives: Vec<PathBuf>,
    dest_dir: PathBuf,
    emitter: Arc<dyn OpEmitter>,
    handle: Arc<OpHandle>,
) {
    emitter.emit(OpEvent::Started { op_id: op_id.clone() });

    // Serialize ops targeting the same destination volume.
    let dev = copier::device_of(&dest_dir).unwrap_or(0);
    let lock = engine
        .volume_locks
        .entry(dev)
        .or_insert_with(|| Arc::new(std::sync::Mutex::new(())))
        .clone();
    let _volume_guard = lock.lock().unwrap();

    let mut journal_entry = OpJournalEntry {
        op_id: op_id.clone(),
        kind: "extract".into(),
        sources: archives.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
        dest_dir: dest_dir.to_string_lossy().into_owned(),
        staging: Vec::new(),
        merge_roots: Vec::new(),
        completed: Vec::new(),
        total: archives.len(),
        started_at_ms: now_ms(),
    };
    if !journal_write_fail_fast(&engine, &journal_entry, &op_id, &emitter) {
        return;
    }

    // Entry-count mode up front: N archives is the whole denominator.
    emitter.emit(OpEvent::Enumerated {
        total_bytes: 0,
        total_entries: archives.len() as u64,
    });

    let mut errors: Vec<OpError> = Vec::new();
    let mut produced: Vec<PathBuf> = Vec::new();
    let mut cancelled = false;

    // Per-item error that always carries the ARCHIVE path (retry contract).
    macro_rules! item_error {
        ($errors:expr, $archive:expr, $msg:expr) => {{
            let e = OpError {
                path: $archive.to_string_lossy().into_owned(),
                message: $msg,
            };
            emitter.emit(OpEvent::ItemError {
                path: e.path.clone(),
                message: e.message.clone(),
            });
            $errors.push(e);
        }};
    }

    for (index, archive) in archives.iter().enumerate() {
        if handle.cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        emitter.emit(OpEvent::Progress {
            bytes_done: 0,
            entries_done: index as u64,
            current_path: archive.to_string_lossy().into_owned(),
            cloned: false,
        });

        // One closure per archive so every failure path shares the
        // "count the attempt" epilogue below.
        let mut attempt = || {
            let name = archive
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let Some(kind) = archive_kind(&name) else {
                item_error!(errors, archive, "not a supported archive".to_string());
                return;
            };
            if archive.symlink_metadata().is_err() {
                item_error!(errors, archive, "file not found".to_string());
                return;
            }

            // Unique, journaled-before-creation staging dir.
            let staging = dest_dir.join(staging_name_for_archive(archive, index, &op_id));
            walker::remove_tree_best_effort(&staging);
            journal_entry.staging.push(staging.to_string_lossy().into_owned());
            if let Err(e) = engine.journal.write(&journal_entry) {
                pop_staging(&mut journal_entry, &staging);
                item_error!(
                    errors,
                    archive,
                    format!("couldn't write the crash-safety journal: {}", e)
                );
                return;
            }
            if let Err(e) = std::fs::create_dir_all(&staging) {
                pop_staging(&mut journal_entry, &staging);
                let _ = engine.journal.write(&journal_entry);
                item_error!(errors, archive, format!("couldn't create staging: {}", e));
                return;
            }

            let cleanup = |journal_entry: &mut OpJournalEntry| {
                walker::remove_tree_best_effort(&staging);
                pop_staging(journal_entry, &staging);
                let _ = engine.journal.write(journal_entry);
            };

            let (tool, mut cmd) = match kind {
                ArchiveKind::Zip => {
                    let mut c = Command::new(DITTO);
                    c.arg("-x").arg("-k").arg("--sequesterRsrc").arg("--noqtn");
                    c.arg(archive).arg(&staging);
                    ("ditto", c)
                }
                ArchiveKind::Tar => {
                    let mut c = Command::new(BSDTAR);
                    // Never -P: keep bsdtar's own path-safety behavior on.
                    c.arg("-xf").arg(archive).arg("-o").arg("-C").arg(&staging);
                    ("tar", c)
                }
            };

            let (status, stderr_tail) = match run_child_cancellable(&mut cmd, &handle) {
                Ok(r) => r,
                Err(e) => {
                    cleanup(&mut journal_entry);
                    item_error!(errors, archive, format!("couldn't run {}: {}", tool, e));
                    return;
                }
            };
            if handle.cancel.load(Ordering::SeqCst) {
                cleanup(&mut journal_entry);
                cancelled = true;
                return;
            }
            if !status.success() {
                cleanup(&mut journal_entry);
                item_error!(errors, archive, child_failure_message(tool, &status, &stderr_tail));
                return;
            }

            // The promotion gate: even a clean tool exit never promotes
            // without validation.
            if let Err(msg) = validate_staging(&staging) {
                cleanup(&mut journal_entry);
                item_error!(errors, archive, msg);
                return;
            }

            let payload = match payload_root_entries(&staging) {
                Ok(p) => p,
                Err(e) => {
                    cleanup(&mut journal_entry);
                    item_error!(errors, archive, format!("couldn't read extracted content: {}", e));
                    return;
                }
            };

            let promoted = if payload.len() == 1 {
                // Single-entry promotion: the entry keeps its OWN name
                // (Archive Utility behavior), extension-preserving keep-both
                // on collision.
                let inner = &payload[0];
                let inner_name = inner
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                promote_unique(inner, &dest_dir, &inner_name, &keep_both_name)
            } else {
                // Multi-entry: strip metadata, then promote the whole staging
                // dir under the archive's stem.
                strip_metadata(&staging);
                let folder = archive_stem(&name).to_string();
                promote_unique(&staging, &dest_dir, &folder, &walker::new_folder_name)
            };

            match promoted {
                Ok(dest) => {
                    // Single-entry promote leaves the (metadata-only) staging
                    // shell behind; multi-entry promote consumed it.
                    cleanup(&mut journal_entry);
                    journal_entry.completed.push(dest.to_string_lossy().into_owned());
                    let _ = engine.journal.write(&journal_entry);
                    produced.push(dest);
                }
                Err(e) => {
                    cleanup(&mut journal_entry);
                    item_error!(errors, archive, format!("couldn't move extracted items into place: {}", e));
                }
            }
        };
        attempt();

        if cancelled {
            break;
        }
        // Absolute processed count, incremented after each attempt — success
        // OR failure — so a mid-batch failure still advances the bar.
        emitter.emit(OpEvent::Progress {
            bytes_done: 0,
            entries_done: (index + 1) as u64,
            current_path: archive.to_string_lossy().into_owned(),
            cloned: false,
        });
    }

    let undoable = !produced.is_empty();
    if undoable {
        engine.undo.lock().unwrap().push(UndoOp::ProducedItems {
            kind: ProducedKind::Extract,
            pairs: produced.iter().map(|p| (p.clone(), None)).collect(),
        });
    }
    engine.journal.remove(&op_id);
    engine.ops.remove(&op_id);

    let status = if cancelled {
        "cancelled"
    } else if errors.is_empty() {
        "success"
    } else if produced.is_empty() {
        "failed"
    } else {
        "partial"
    };
    emitter.emit(OpEvent::Done {
        status,
        errors,
        warnings: Vec::new(),
        produced: produced.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
        undoable,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Instant;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fazi-archive-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn archive_stem_table() {
        let cases = [
            ("Report.pdf.zip", "Report.pdf"),
            ("Photos.ZIP", "Photos"),
            ("backup.tar.gz", "backup"),
            ("backup.TAR.GZ", "backup"),
            ("backup.tar.bz2", "backup"),
            ("backup.tar.xz", "backup"),
            ("backup.tgz", "backup"),
            ("backup.tar", "backup"),
            ("plain.rar", "plain.rar"),   // unknown suffix untouched
            ("noext", "noext"),
            ("사진.zip", "사진"),           // non-ASCII stem
            ("naïve.tar.gz", "naïve"),
            (".zip", ".zip"),              // suffix-only name untouched
        ];
        for (input, expected) in cases {
            assert_eq!(archive_stem(input), expected, "input {:?}", input);
        }
    }

    #[test]
    fn archive_kind_table() {
        assert_eq!(archive_kind("a.zip"), Some(ArchiveKind::Zip));
        assert_eq!(archive_kind("a.ZIP"), Some(ArchiveKind::Zip));
        assert_eq!(archive_kind("a.tar"), Some(ArchiveKind::Tar));
        assert_eq!(archive_kind("a.tgz"), Some(ArchiveKind::Tar));
        assert_eq!(archive_kind("a.tar.gz"), Some(ArchiveKind::Tar));
        assert_eq!(archive_kind("a.TAR.GZ"), Some(ArchiveKind::Tar));
        assert_eq!(archive_kind("a.tar.bz2"), Some(ArchiveKind::Tar));
        assert_eq!(archive_kind("a.tar.xz"), Some(ArchiveKind::Tar));
        assert_eq!(archive_kind("a.gz"), None); // lone .gz is out of scope
        assert_eq!(archive_kind("a.7z"), None);
        assert_eq!(archive_kind("a.rar"), None);
        assert_eq!(archive_kind("zip"), None); // suffix-only
    }

    #[test]
    fn staging_names_are_unique_per_index_and_recoverable() {
        let a = staging_name_for_archive(Path::new("/a/Foo.zip"), 0, "op1");
        let b = staging_name_for_archive(Path::new("/b/Foo.zip"), 1, "op1");
        assert_ne!(a, b, "same basename must stage under distinct names");
        // Both must match the recovery scanner's staging pattern.
        assert!(walker::is_staging_name(&a, "op1"));
        assert!(walker::is_staging_name(&b, "op1"));
    }

    #[test]
    fn validate_staging_accepts_normal_payload() {
        let d = tmp("validok");
        fs::create_dir_all(d.join("Photos/sub")).unwrap();
        fs::write(d.join("Photos/a.jpg"), b"x").unwrap();
        fs::write(d.join("Photos/sub/b.jpg"), b"y").unwrap();
        std::os::unix::fs::symlink("a.jpg", d.join("Photos/link")).unwrap();
        assert!(validate_staging(&d).is_ok());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn validate_staging_rejects_escaping_symlinks() {
        // Absolute target.
        let d = tmp("validabs");
        fs::write(d.join("a.txt"), b"x").unwrap();
        std::os::unix::fs::symlink("/etc/passwd", d.join("evil")).unwrap();
        let err = validate_staging(&d).unwrap_err();
        assert!(err.contains("unsafe link"), "{}", err);
        fs::remove_dir_all(&d).ok();

        // Relative target climbing out of staging.
        let d = tmp("validrel");
        fs::create_dir_all(d.join("sub")).unwrap();
        fs::write(d.join("a.txt"), b"x").unwrap();
        std::os::unix::fs::symlink("../../outside", d.join("sub/evil")).unwrap();
        let err = validate_staging(&d).unwrap_err();
        assert!(err.contains("unsafe link"), "{}", err);
        fs::remove_dir_all(&d).ok();

        // Relative target that stays inside is fine.
        let d = tmp("validinside");
        fs::create_dir_all(d.join("sub")).unwrap();
        fs::write(d.join("a.txt"), b"x").unwrap();
        std::os::unix::fs::symlink("../a.txt", d.join("sub/ok")).unwrap();
        assert!(validate_staging(&d).is_ok());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn validate_staging_rejects_empty_and_metadata_only() {
        let d = tmp("validempty");
        let err = validate_staging(&d).unwrap_err();
        assert!(err.contains("no extractable content"), "{}", err);
        fs::remove_dir_all(&d).ok();

        let d = tmp("validmeta");
        fs::create_dir_all(d.join("__MACOSX/inner")).unwrap();
        fs::write(d.join("__MACOSX/inner/._junk"), b"rsrc").unwrap();
        fs::write(d.join(".DS_Store"), b"ds").unwrap();
        let err = validate_staging(&d).unwrap_err();
        assert!(err.contains("no extractable content"), "{}", err);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn validate_staging_one_payload_plus_metadata_is_ok() {
        let d = tmp("validonemeta");
        fs::create_dir_all(d.join("__MACOSX")).unwrap();
        fs::write(d.join(".DS_Store"), b"ds").unwrap();
        fs::write(d.join("readme.txt"), b"hello").unwrap();
        assert!(validate_staging(&d).is_ok());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn run_child_cancellable_kills_and_reaps_promptly() {
        let handle = OpHandle::new();
        let h = handle.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            h.cancel();
        });
        let start = Instant::now();
        let mut cmd = Command::new("/bin/sleep");
        cmd.arg("30");
        let (status, _tail) = run_child_cancellable(&mut cmd, &handle).unwrap();
        // Returned promptly (killed, not waited out) and the child is reaped
        // (wait() returned a real status — a zombie would hang or error).
        assert!(start.elapsed() < Duration::from_secs(5), "took {:?}", start.elapsed());
        assert!(!status.success());
        assert!(handle.cancel.load(Ordering::SeqCst));
    }

    #[test]
    fn child_failure_message_handles_signal_death_without_panicking() {
        // A child killed by a signal has code() == None — the message must
        // come from status.to_string(), never code().unwrap().
        let handle = OpHandle::new();
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg("kill -9 $$");
        let (status, tail) = run_child_cancellable(&mut cmd, &handle).unwrap();
        assert!(!status.success());
        assert_eq!(status.code(), None, "expected a signal death");
        let msg = child_failure_message("ditto", &status, &tail);
        assert!(msg.contains("signal"), "{}", msg);
    }

    #[test]
    fn child_failure_message_includes_stderr_tail() {
        let handle = OpHandle::new();
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg("echo boom-detail >&2; exit 3");
        let (status, tail) = run_child_cancellable(&mut cmd, &handle).unwrap();
        assert!(!status.success());
        let msg = child_failure_message("ditto", &status, &tail);
        assert!(msg.contains("boom-detail"), "{}", msg);
        assert!(msg.contains("3"), "{}", msg);
    }

    #[test]
    fn stderr_tail_is_bounded() {
        let handle = OpHandle::new();
        let mut cmd = Command::new("/bin/sh");
        // ~1MB of stderr must neither deadlock the wait loop nor blow the tail.
        cmd.arg("-c")
            .arg("i=0; while [ $i -lt 16384 ]; do echo 0123456789012345678901234567890123456789012345678901234567890123 >&2; i=$((i+1)); done; exit 1");
        let (status, tail) = run_child_cancellable(&mut cmd, &handle).unwrap();
        assert!(!status.success());
        assert!(tail.len() <= STDERR_TAIL_BYTES, "tail {} bytes", tail.len());
        assert!(!tail.is_empty());
    }

    #[test]
    fn strip_metadata_removes_macosx_and_root_ds_store_only() {
        let d = tmp("strip");
        fs::create_dir_all(d.join("__MACOSX/deep")).unwrap();
        fs::write(d.join("__MACOSX/deep/._x"), b"r").unwrap();
        fs::write(d.join(".DS_Store"), b"ds").unwrap();
        fs::create_dir_all(d.join("Photos")).unwrap();
        fs::write(d.join("Photos/.DS_Store"), b"nested-kept").unwrap();
        fs::write(d.join("Photos/pic.jpg"), b"p").unwrap();
        strip_metadata(&d);
        assert!(!d.join("__MACOSX").exists());
        assert!(!d.join(".DS_Store").exists());
        // Nested .DS_Store inside payload dirs is left alone (Finder parity).
        assert!(d.join("Photos/.DS_Store").exists());
        assert!(d.join("Photos/pic.jpg").exists());
        fs::remove_dir_all(&d).ok();
    }
}
