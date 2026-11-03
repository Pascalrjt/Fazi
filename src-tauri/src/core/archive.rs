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
    /// Record errors without emitting them: a source-side staging attempt
    /// that fails falls back to the destination, so its errors aren't final.
    quiet: bool,
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
            quiet: false,
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
                phase: None,
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
        if !self.quiet {
            self.emitter.emit(OpEvent::ItemError {
                path: e.path.clone(),
                message: e.message.clone(),
            });
        }
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
            skipped: None,
            undoable: false,
        });
        return false;
    }
    true
}

/// Whether the volume holding `path` supports clonefile(2)
/// (VOL_CAP_INT_CLONE, as reported for its mount point).
pub fn volume_supports_clone(path: &Path) -> bool {
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    let mut sfs: libc::statfs = unsafe { std::mem::zeroed() };
    // SAFETY: valid path, out-pointer to a zeroed statfs.
    if unsafe { libc::statfs(c.as_ptr(), &mut sfs) } != 0 {
        return false;
    }
    let mnt: Vec<u8> = sfs
        .f_mntonname
        .iter()
        .take_while(|&&b| b != 0)
        .map(|&b| b as u8)
        .collect();
    let Ok(mnt) = std::ffi::CString::new(std::ffi::OsString::from_vec(mnt).into_vec()) else {
        return false;
    };
    let mut req: libc::attrlist = unsafe { std::mem::zeroed() };
    req.bitmapcount = libc::ATTR_BIT_MAP_COUNT;
    req.volattr = libc::ATTR_VOL_INFO | libc::ATTR_VOL_CAPABILITIES;
    #[repr(C, packed(4))]
    struct Buf {
        len: u32,
        caps: libc::vol_capabilities_attr_t,
    }
    let mut buf: Buf = unsafe { std::mem::zeroed() };
    // SAFETY: valid mount path, attrlist and buffer of the declared size.
    let rc = unsafe {
        libc::getattrlist(
            mnt.as_ptr(),
            (&mut req as *mut libc::attrlist).cast(),
            (&mut buf as *mut Buf).cast(),
            std::mem::size_of::<Buf>(),
            0,
        )
    };
    if rc != 0 {
        return false;
    }
    let caps = buf.caps;
    let i = libc::VOL_CAPABILITIES_INTERFACES;
    caps.valid[i] & libc::VOL_CAP_INT_CLONE != 0 && caps.capabilities[i] & libc::VOL_CAP_INT_CLONE != 0
}

/// Where a multi-item compress should materialize its contents dir: beside
/// the first source when every source lives on one clone-capable volume that
/// differs from the destination's, so staging is per-entry clones instead of
/// a full byte copy onto the destination volume. Without clone support the
/// source side would byte-copy too (and may lack the space: exFAT, a nearly
/// full stick), so None = stage on the destination.
fn source_side_staging_dir(sources: &[PathBuf], dest_dir: &Path) -> Option<PathBuf> {
    let dev = copier::device_of(sources.first()?)?;
    if copier::device_of(dest_dir) == Some(dev) {
        return None; // already same-volume: the destination clones too
    }
    if !sources.iter().skip(1).all(|s| copier::device_of(s) == Some(dev)) {
        return None;
    }
    let parent = sources[0].parent()?;
    // A mount-point source has its parent on another volume; a parent inside
    // a selected folder would make the staging dir copy itself.
    if copier::device_of(parent) != Some(dev) || sources.iter().any(|s| parent.starts_with(s)) {
        return None;
    }
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(parent.as_os_str().as_bytes()).ok()?;
    // SAFETY: valid NUL-terminated path.
    if unsafe { libc::access(c.as_ptr(), libc::W_OK) } != 0 {
        return None;
    }
    if !volume_supports_clone(parent) {
        return None;
    }
    Some(parent.to_path_buf())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Staged {
    Done,
    Cancelled,
    Failed,
    /// Re-journaling the fallback spot failed (Done already emitted).
    JournalFailed,
}

/// Run the staging copy into `stage_contents`; if that is a source-side
/// spot and it fails for any reason (no space, permissions, clone refused),
/// discard it, journal the destination-side spot FIRST, and stage there.
/// `stage(dir, is_final)` performs one attempt; only the final attempt's
/// errors are user-facing. `discard` reports whether the tree is gone;
/// `rejournal(from, to, from_removed)` must keep `from` journaled unless it
/// was removed, so startup recovery deletes a tree that refused to go.
fn stage_with_fallback(
    stage_contents: &mut PathBuf,
    dest_side: &Path,
    mut stage: impl FnMut(&Path, bool) -> Staged,
    mut rejournal: impl FnMut(&Path, &Path, bool) -> bool,
    mut discard: impl FnMut(&Path) -> bool,
) -> Staged {
    let source_side = stage_contents.as_path() != dest_side;
    let first = stage(stage_contents, !source_side);
    if first != Staged::Failed || !source_side {
        return first;
    }
    let removed = discard(stage_contents);
    if !rejournal(stage_contents, dest_side, removed) {
        return Staged::JournalFailed;
    }
    *stage_contents = dest_side.to_path_buf();
    // Fresh name embedding the op id: nothing of value can be there.
    discard(stage_contents);
    stage(stage_contents, true)
}

/// Finish an op's journal record: retry removing staging trees that refused
/// to go earlier; drop the record only once they're all gone, else leave
/// just those paths journaled for startup recovery.
fn retire_journal(journal: &crate::core::journal::Journal, op_id: &str, leftovers: &[PathBuf]) {
    let remaining: Vec<String> = leftovers
        .iter()
        .filter(|p| walker::remove_tree(p).is_err())
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    if remaining.is_empty() {
        journal.remove(op_id);
        return;
    }
    match journal.snapshot(op_id) {
        Some(mut entry) => {
            entry.staging = remaining;
            entry.merge_roots.clear();
            if journal.write(&entry).is_err() {
                // Keep the previous record (it lists the leftovers too).
            }
        }
        None => journal.remove(op_id),
    }
}

/// One staging attempt: create the contents dir and materialize every
/// source into it (keep-both names for duplicate basenames).
fn stage_sources(
    sources: &[PathBuf],
    stage_contents: &Path,
    sink: &mut ArchiveSink,
    handle: &OpHandle,
) -> Staged {
    if let Err(e) = std::fs::create_dir(stage_contents) {
        sink.item_error(stage_contents, &e);
        return Staged::Failed;
    }
    // Inside-archive keep-both naming: one cached name set.
    let mut staged_names = walker::DirNames::new(stage_contents);
    for source in sources {
        if handle.cancel.load(Ordering::SeqCst) {
            return Staged::Cancelled;
        }
        let Some(name_os) = source.file_name() else {
            sink.item_error(source, &io::Error::new(io::ErrorKind::InvalidInput, "invalid source"));
            return Staged::Failed;
        };
        let name = name_os.to_string_lossy().into_owned();
        // Duplicate top-level basenames from different parents get
        // keep-both names inside the archive (Finder behavior).
        let target_name = if staged_names.contains(&name) {
            walker::keep_both_name_in(&mut staged_names, &name)
        } else {
            name
        };
        staged_names.insert(&target_name);
        // All-or-nothing backstop: `copy_fresh` records child failures
        // via the sink but still returns Done for a directory with
        // failed children — snapshot the error count around each copy.
        let errors_before = sink.errors.len();
        // Dataless sources surface as item errors via the sink's
        // fail-fast abort — an incomplete zip is never produced.
        match walker::copy_fresh(source, &stage_contents.join(&target_name), sink) {
            Ok(Outcome::Done) => {
                if sink.errors.len() > errors_before {
                    return Staged::Failed;
                }
            }
            Ok(Outcome::Cancelled) => {
                // Either user cancel or the sink's fail-fast abort.
                return if handle.cancel.load(Ordering::SeqCst) {
                    Staged::Cancelled
                } else {
                    Staged::Failed
                };
            }
            Err(e) => {
                sink.item_error(source, &e);
                return Staged::Failed;
            }
        }
    }
    Staged::Done
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
            skipped: None,
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
    let contents_name = staging_name(&format!("{}.contents", zip_name), &op_id);
    let dest_side_contents = dest_dir.join(&contents_name);
    // Multi-item staging is a materializing copy: on the sources' volume
    // it's per-entry clones (free); on another destination volume it's a
    // full byte copy before ditto even starts. Falls back to the
    // destination when the sources span volumes or the spot isn't usable.
    let mut stage_contents = if multi {
        source_side_staging_dir(&sources, &dest_dir)
            .map(|dir| dir.join(&contents_name))
            .unwrap_or_else(|| dest_side_contents.clone())
    } else {
        dest_side_contents.clone()
    };
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

    // Staging phase (multi-item only): materializing copy into a contents dir
    // whose layout becomes the zip root. A failed source-side attempt falls
    // back to journaled destination-side staging.
    let mut cancelled = false;
    let mut staging_failed = false;
    // Failed source-side trees that couldn't be removed: stay journaled.
    let mut leftovers: Vec<PathBuf> = Vec::new();
    if multi {
        let staged = stage_with_fallback(
            &mut stage_contents,
            &dest_side_contents,
            |dir, is_final| {
                sink.errors.clear();
                sink.aborted = false;
                sink.quiet = !is_final;
                stage_sources(&sources, dir, &mut sink, &handle)
            },
            |from, to, from_removed| {
                if from_removed {
                    pop_staging(&mut journal_entry, from);
                } else {
                    leftovers.push(from.to_path_buf());
                }
                journal_entry.staging.push(to.to_string_lossy().into_owned());
                journal_write_fail_fast(&engine, &journal_entry, &op_id, &emitter)
            },
            |dir| walker::remove_tree(dir).is_ok(),
        );
        match staged {
            Staged::Done => {}
            Staged::Cancelled => cancelled = true,
            Staged::Failed => staging_failed = true,
            Staged::JournalFailed => {
                walker::remove_tree_best_effort(&stage_zip);
                engine.journal.remove(&op_id);
                return;
            }
        }
    }
    let stage_contents = stage_contents;
    let leftovers = leftovers;

    let cleanup_staging = |journal_entry: &mut OpJournalEntry| {
        walker::remove_tree_best_effort(&stage_zip);
        if multi {
            walker::remove_tree_best_effort(&stage_contents);
        }
        pop_staging(journal_entry, &stage_zip);
        pop_staging(journal_entry, &stage_contents);
        let _ = engine.journal.write(journal_entry);
    };

    if cancelled || staging_failed {
        cleanup_staging(&mut journal_entry);
        retire_journal(&engine.journal, &op_id, &leftovers);
        engine.ops.remove(&op_id);
        emitter.emit(OpEvent::Done {
            status: if cancelled { "cancelled" } else { "failed" },
            errors: sink.errors.clone(),
            warnings: Vec::new(),
            produced: Vec::new(),
            skipped: None,
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
                    phase: None,
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
            engine.push_undo(UndoOp::ProducedItems {
                kind: ProducedKind::Compress,
                pairs: produced.iter().map(|p| (p.clone(), None)).collect(),
            });
        }
        retire_journal(&engine.journal, &op_id, &leftovers);
        engine.ops.remove(&op_id);
        let touched: Vec<PathBuf> = sources.iter().chain(produced.iter()).cloned().collect();
        (engine.invalidate_fuzzy)(&touched);
        emitter.emit(OpEvent::Done {
            status,
            errors,
            warnings: Vec::new(),
            produced: produced.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
            skipped: None,
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
                        phase: None,
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
            // The dirent type (lstat semantics, never follows links) — no
            // extra lstat per extracted entry. std falls back to lstat
            // itself when the filesystem reports DT_UNKNOWN.
            let ft = entry
                .file_type()
                .map_err(|e| format!("couldn't inspect extracted content: {}", e))?;
            if ft.is_symlink() {
                if symlink_escapes(root, &path) {
                    return Err(format!(
                        "unsafe link in archive: {}",
                        rel.to_string_lossy()
                    ));
                }
            } else if ft.is_dir() {
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
            if !(in_macosx || at_root && is_ignored_root_name(&name)) {
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
            phase: None,
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
            phase: None,
        });
    }

    let undoable = !produced.is_empty();
    if undoable {
        engine.push_undo(UndoOp::ProducedItems {
            kind: ProducedKind::Extract,
            pairs: produced.iter().map(|p| (p.clone(), None)).collect(),
        });
    }
    engine.journal.remove(&op_id);
    engine.ops.remove(&op_id);

    let touched: Vec<PathBuf> = archives.iter().chain(produced.iter()).cloned().collect();
    (engine.invalidate_fuzzy)(&touched);

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
        skipped: None,
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

    #[test]
    fn apfs_temp_volume_reports_clone_support() {
        assert!(volume_supports_clone(&std::env::temp_dir()));
        assert!(!volume_supports_clone(Path::new("/definitely/not/here")));
        assert!(!volume_supports_clone(Path::new("/dev")), "devfs has no clones");
    }

    #[test]
    fn failed_source_side_staging_falls_back_to_the_destination() {
        let src = PathBuf::from("/src/.stage");
        let dst = PathBuf::from("/dst/.stage");
        let attempts = std::cell::RefCell::new(Vec::new());
        let discarded = std::cell::RefCell::new(Vec::new());
        let journaled = std::cell::RefCell::new(Vec::new());
        let mut at = src.clone();
        let r = stage_with_fallback(
            &mut at,
            &dst,
            |d, fin| {
                attempts.borrow_mut().push((d.to_path_buf(), fin));
                if d == src { Staged::Failed } else { Staged::Done }
            },
            |from, to, removed| {
                assert!(removed);
                journaled.borrow_mut().push((from.to_path_buf(), to.to_path_buf()));
                true
            },
            |d| {
                discarded.borrow_mut().push(d.to_path_buf());
                true
            },
        );
        assert_eq!(r, Staged::Done);
        assert_eq!(at, dst);
        assert_eq!(*attempts.borrow(), vec![(src.clone(), false), (dst.clone(), true)]);
        assert_eq!(*journaled.borrow(), vec![(src.clone(), dst.clone())]);
        assert_eq!(*discarded.borrow(), vec![src.clone(), dst.clone()]);

        // No retry for cancel, for destination-side failures, or when the
        // fallback can't be journaled.
        let mut at = src.clone();
        assert_eq!(
            stage_with_fallback(&mut at, &dst, |_, _| Staged::Cancelled, |_, _, _| true, |_| true),
            Staged::Cancelled
        );
        let mut at = dst.clone();
        let mut n = 0;
        assert_eq!(
            stage_with_fallback(&mut at, &dst, |_, fin| { n += 1; assert!(fin); Staged::Failed }, |_, _, _| true, |_| true),
            Staged::Failed
        );
        assert_eq!(n, 1);
        let mut at = src.clone();
        assert_eq!(
            stage_with_fallback(&mut at, &dst, |_, _| Staged::Failed, |_, _, _| false, |_| true),
            Staged::JournalFailed
        );
    }

    struct Recorder(std::sync::Mutex<Vec<String>>);
    impl OpEmitter for Recorder {
        fn emit(&self, e: OpEvent) {
            if let OpEvent::ItemError { path, .. } = e {
                self.0.lock().unwrap().push(path);
            }
        }
    }

    #[test]
    fn real_source_side_failure_is_quiet_and_the_destination_attempt_succeeds() {
        use std::os::unix::fs::PermissionsExt;
        let d = tmp("fallback");
        let a = d.join("a.txt");
        let b = d.join("b");
        fs::write(&a, b"a").unwrap();
        fs::create_dir(&b).unwrap();
        fs::write(b.join("inner.txt"), b"i").unwrap();
        // Source-side spot: its parent refuses writes (stand-in for ENOSPC).
        let locked = d.join("locked");
        fs::create_dir(&locked).unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
        let dest = d.join("dest");
        fs::create_dir(&dest).unwrap();
        let dest_side = dest.join(".stage.contents");

        let rec = Arc::new(Recorder(std::sync::Mutex::new(Vec::new())));
        let handle = OpHandle::new();
        let mut sink =
            ArchiveSink::new(rec.clone(), handle.clone(), Arc::new(AtomicU64::new(0)));
        let sources = vec![a.clone(), b.clone()];
        let mut at = locked.join(".stage.contents");
        let r = stage_with_fallback(
            &mut at,
            &dest_side,
            |dir, fin| {
                sink.errors.clear();
                sink.aborted = false;
                sink.quiet = !fin;
                stage_sources(&sources, dir, &mut sink, &handle)
            },
            |_, _, _| true,
            |d| walker::remove_tree(d).is_ok(),
        );
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(r, Staged::Done);
        assert_eq!(at, dest_side);
        assert!(sink.errors.is_empty());
        assert!(rec.0.lock().unwrap().is_empty(), "the discarded attempt emits no errors");
        assert_eq!(fs::read(dest_side.join("a.txt")).unwrap(), b"a");
        assert_eq!(fs::read(dest_side.join("b/inner.txt")).unwrap(), b"i");
        assert_eq!(fs::read_dir(&locked).unwrap().count(), 0);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn undeletable_source_stage_stays_journaled_until_removed() {
        use std::os::unix::fs::PermissionsExt;
        let d = tmp("leftover");
        let journal = crate::core::journal::Journal::new(d.join("journal")).unwrap();
        // The failed source-side tree sits in a folder that turned
        // read-only: neither discard nor retire can remove it.
        let parent = d.join("src-parent");
        let stage = parent.join(".stage.contents");
        fs::create_dir_all(stage.join("sub")).unwrap();
        fs::write(stage.join("sub/f.txt"), b"x").unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o555)).unwrap();
        let dest_side = d.join("dest/.stage.contents");

        let mut entry = OpJournalEntry {
            op_id: "op-left".into(),
            kind: "compress".into(),
            sources: vec![],
            dest_dir: d.join("dest").to_string_lossy().into_owned(),
            staging: vec![stage.to_string_lossy().into_owned()],
            merge_roots: Vec::new(),
            completed: Vec::new(),
            total: 1,
            started_at_ms: 0,
        };
        journal.write(&entry).unwrap();
        let mut leftovers = Vec::new();
        let mut at = stage.clone();
        let r = stage_with_fallback(
            &mut at,
            &dest_side,
            |dir, _| if dir == stage { Staged::Failed } else { Staged::Done },
            |from, to, removed| {
                assert!(!removed, "a read-only parent blocks removal");
                leftovers.push(from.to_path_buf());
                entry.staging.push(to.to_string_lossy().into_owned());
                journal.write(&entry).is_ok()
            },
            |dir| walker::remove_tree(dir).is_ok(),
        );
        assert_eq!(r, Staged::Done);
        // Op finishes: the leftover is still there, so its record survives.
        retire_journal(&journal, "op-left", &leftovers);
        let kept = journal.snapshot("op-left").expect("leftover keeps the record");
        assert_eq!(kept.staging, vec![stage.to_string_lossy().into_owned()]);

        // A launch while it's still stuck: recovery can't remove it either,
        // so the record survives for the next attempt.
        assert_eq!(journal.recover().len(), 1);
        assert!(stage.exists());
        assert!(journal.snapshot("op-left").is_some());

        // Next launch, the folder is writable again: recovery removes it.
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o755)).unwrap();
        let report = journal.recover();
        assert_eq!(report.len(), 1);
        assert!(!stage.exists());
        assert!(journal.recover().is_empty());
        fs::remove_dir_all(&d).ok();
    }
}
