//! End-to-end tests for the file-operations engine — the reason this app
//! exists. These drive `spawn_op` exactly as the IPC layer does and assert
//! the transactional guarantees from the plan.

use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use fazi_lib::core::journal::Journal;
use fazi_lib::core::op_queue::{
    spawn_duplicate, spawn_op, CopyVerifier, Engine, InvalidateFuzzy, OpArgs, OpEmitter, OpEvent,
    OpKind, Policy,
};
use fazi_lib::core::undo::UndoStack;
use fazi_lib::core::verify::ChecksumReport;
use fazi_lib::core::walker::{is_staging_name, DirTrasher, Resolution, Trasher};

// ---------------------------------------------------------------------------
// Harness
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
    env_with(name, None)
}

/// Like `env`, but with a custom trasher (defaults to `DirTrasher`).
fn env_with(name: &str, trasher: Option<Arc<dyn Trasher>>) -> Env {
    env_with_verifier(
        name,
        trasher,
        Arc::new(|src, dst, cancelled| {
            fazi_lib::core::verify::checksum_compare(src, dst, cancelled)
        }),
    )
}

/// Like `env_with`, but with an injected copy verifier (defaults to the real
/// `checksum_compare`).
fn env_with_verifier(
    name: &str,
    trasher: Option<Arc<dyn Trasher>>,
    verifier: CopyVerifier,
) -> Env {
    env_full(name, trasher, verifier, Arc::new(|_| {}))
}

/// Like `env`, but with an injected fuzzy invalidator (defaults to a no-op).
fn env_with_invalidator(name: &str, invalidator: InvalidateFuzzy) -> Env {
    env_full(
        name,
        None,
        Arc::new(|src, dst, cancelled| {
            fazi_lib::core::verify::checksum_compare(src, dst, cancelled)
        }),
        invalidator,
    )
}

/// The single Engine construction point every `env*` builder routes through.
fn env_full(
    name: &str,
    trasher: Option<Arc<dyn Trasher>>,
    verifier: CopyVerifier,
    invalidator: InvalidateFuzzy,
) -> Env {
    let root = std::env::temp_dir().join(format!("fazi-engine-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let trash_dir = root.join(".test-trash");
    let engine = Arc::new(Engine {
        trasher: trasher.unwrap_or_else(|| Arc::new(DirTrasher(trash_dir.clone()))),
        journal: Arc::new(Journal::new(root.join(".journal")).unwrap()),
        undo: Arc::new(Mutex::new(UndoStack::default())),
        ops: DashMap::new(),
        volume_locks: DashMap::new(),
        icon_token: Arc::new(|_, _| String::new()),
        verify_copy_contents: verifier,
        invalidate_fuzzy: invalidator,
        undo_changed: Arc::new(|_| {}),
    });
    Env { root, engine, trash_dir }
}

/// Trasher that always fails — simulates an unavailable Trash.
struct FailTrasher;
impl Trasher for FailTrasher {
    fn trash(&self, _: &Path) -> io::Result<PathBuf> {
        Err(io::Error::new(io::ErrorKind::PermissionDenied, "trash unavailable"))
    }
}

/// Trasher that parks in `trash()` until released — freezes an op at the
/// post-swap crash point so the on-disk journal can be inspected.
struct BlockingTrasher {
    inner: DirTrasher,
    entered: Arc<(Mutex<bool>, Condvar)>,
    release: Arc<(Mutex<bool>, Condvar)>,
}

impl BlockingTrasher {
    fn new(trash_dir: PathBuf) -> Self {
        BlockingTrasher {
            inner: DirTrasher(trash_dir),
            entered: Arc::new((Mutex::new(false), Condvar::new())),
            release: Arc::new((Mutex::new(false), Condvar::new())),
        }
    }

    fn wait_entered(&self, timeout: Duration) {
        let (m, cv) = &*self.entered;
        let mut entered = m.lock().unwrap();
        let deadline = Instant::now() + timeout;
        while !*entered {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "trasher was never entered");
            let (guard, _) = cv.wait_timeout(entered, remaining).unwrap();
            entered = guard;
        }
    }

    fn release(&self) {
        let (m, cv) = &*self.release;
        *m.lock().unwrap() = true;
        cv.notify_all();
    }
}

impl Trasher for BlockingTrasher {
    fn trash(&self, path: &Path) -> io::Result<PathBuf> {
        {
            let (m, cv) = &*self.entered;
            *m.lock().unwrap() = true;
            cv.notify_all();
        }
        {
            let (m, cv) = &*self.release;
            let mut released = m.lock().unwrap();
            while !*released {
                released = cv.wait(released).unwrap();
            }
        }
        self.inner.trash(path)
    }
}

/// True when the filesystem under `dir` supports renamex_np(RENAME_SWAP).
/// Post-swap tests are skipped without it (macOS temp dirs are APFS).
fn swap_supported(dir: &Path) -> bool {
    let a = dir.join(".swapprobe-a");
    let b = dir.join(".swapprobe-b");
    std::fs::write(&a, b"a").unwrap();
    std::fs::write(&b, b"b").unwrap();
    let ok = fazi_lib::core::copier::rename_swap(&a, &b).is_ok();
    let _ = std::fs::remove_file(&a);
    let _ = std::fs::remove_file(&b);
    ok
}

fn make_tree(root: &Path, files: usize) {
    std::fs::create_dir_all(root.join("nested/deeper")).unwrap();
    for i in 0..files {
        std::fs::write(root.join(format!("file{:03}.txt", i)), format!("content-{}", i)).unwrap();
    }
    std::fs::write(root.join("nested/inner.txt"), b"inner").unwrap();
    std::fs::write(root.join("nested/deeper/deep.bin"), vec![5u8; 4096]).unwrap();
    xattr::set(root.join("file000.txt"), "com.fazi.test", b"tagged").unwrap();
}

fn done_status(events: &[OpEvent]) -> (&'static str, Vec<String>, bool) {
    for e in events {
        if let OpEvent::Done { status, produced, undoable, .. } = e {
            return (status, produced.clone(), *undoable);
        }
    }
    panic!("no Done event");
}

fn count_staging(root: &Path) -> usize {
    let mut n = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.contains(".fazi-partial-") {
                n += 1;
            }
            if e.path().is_dir() && !e.path().is_symlink() {
                stack.push(e.path());
            }
        }
    }
    n
}

// ---------------------------------------------------------------------------
// Copy & move fundamentals
// ---------------------------------------------------------------------------

#[test]
fn copy_folder_preserves_content_metadata_and_reports() {
    let env = env("copy");
    let src = env.root.join("src");
    make_tree(&src, 20);
    let dst = env.root.join("dst");
    std::fs::create_dir_all(&dst).unwrap();

    let emitter = TestEmitter::new();
    spawn_op(
        env.engine.clone(),
        OpArgs {
            op_id: "op-copy".into(),
            kind: OpKind::Copy,
            sources: vec![src.clone()],
            dest_dir: dst.clone(),
            policy: Policy::Ask,
            verify: false,
        },
        Arc::new(emitter.clone()),
    );
    let events = emitter.wait_done(Duration::from_secs(30));
    let (status, produced, undoable) = done_status(&events);
    assert_eq!(status, "success");
    assert_eq!(produced, vec![dst.join("src").to_string_lossy().into_owned()]);
    assert!(undoable);

    // Content + metadata preserved.
    assert_eq!(
        std::fs::read(dst.join("src/file007.txt")).unwrap(),
        b"content-7"
    );
    assert_eq!(
        std::fs::read(dst.join("src/nested/deeper/deep.bin")).unwrap().len(),
        4096
    );
    assert_eq!(
        xattr::get(dst.join("src/file000.txt"), "com.fazi.test").unwrap().as_deref(),
        Some(b"tagged".as_ref())
    );
    // Source untouched; no staging artifacts; journal cleared.
    assert!(src.join("file000.txt").exists());
    assert_eq!(count_staging(&env.root), 0);
    assert!(env.engine.journal.recover().is_empty());

    // Started + Enumerated + Progress events flowed.
    assert!(events.iter().any(|e| matches!(e, OpEvent::Started { .. })));
    assert!(events.iter().any(|e| matches!(e, OpEvent::Enumerated { .. })));
    std::fs::remove_dir_all(&env.root).ok();
}

#[test]
fn same_volume_move_is_instant_rename() {
    let env = env("move");
    let src = env.root.join("big");
    make_tree(&src, 100);
    let src_inode = std::fs::metadata(&src).unwrap().ino();
    let dst = env.root.join("elsewhere");
    std::fs::create_dir_all(&dst).unwrap();

    let emitter = TestEmitter::new();
    let started = Instant::now();
    spawn_op(
        env.engine.clone(),
        OpArgs {
            op_id: "op-move".into(),
            kind: OpKind::Move,
            sources: vec![src.clone()],
            dest_dir: dst.clone(),
            policy: Policy::Ask,
            verify: false,
        },
        Arc::new(emitter.clone()),
    );
    let events = emitter.wait_done(Duration::from_secs(10));
    let elapsed = started.elapsed();
    let (status, _, undoable) = done_status(&events);
    assert_eq!(status, "success");
    assert!(undoable);
    // rename(2): same inode at the destination, source gone, fast.
    assert_eq!(std::fs::metadata(dst.join("big")).unwrap().ino(), src_inode);
    assert!(!src.exists());
    assert!(elapsed < Duration::from_secs(1), "move took {:?} — not a rename", elapsed);
    std::fs::remove_dir_all(&env.root).ok();
}

#[test]
fn undo_inversion_restores_tree() {
    let env = env("undoinv");
    let src = env.root.join("src");
    make_tree(&src, 5);
    let dst = env.root.join("dst");
    std::fs::create_dir_all(&dst).unwrap();

    let emitter = TestEmitter::new();
    spawn_op(
        env.engine.clone(),
        OpArgs {
            op_id: "op-mv".into(),
            kind: OpKind::Move,
            sources: vec![src.clone()],
            dest_dir: dst.clone(),
            policy: Policy::Ask,
            verify: false,
        },
        Arc::new(emitter.clone()),
    );
    emitter.wait_done(Duration::from_secs(10));
    assert!(!src.exists());

    // op → undo → tree is back exactly.
    let outcome = env
        .engine
        .undo
        .lock()
        .unwrap()
        .undo(env.engine.trasher.as_ref())
        .unwrap()
        .expect("undoable");
    assert_eq!(outcome.restored, vec![src.clone()]);
    assert!(src.join("file000.txt").exists());
    assert!(!dst.join("src").exists());
    std::fs::remove_dir_all(&env.root).ok();
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

#[test]
fn conflict_ask_keep_both_and_apply_to_all() {
    let env = env("conflict");
    let srcdir = env.root.join("from");
    std::fs::create_dir_all(&srcdir).unwrap();
    std::fs::write(srcdir.join("a.txt"), b"new-a").unwrap();
    std::fs::write(srcdir.join("b.txt"), b"new-b").unwrap();
    let dst = env.root.join("to");
    std::fs::create_dir_all(&dst).unwrap();
    std::fs::write(dst.join("a.txt"), b"old-a").unwrap();
    std::fs::write(dst.join("b.txt"), b"old-b").unwrap();

    let emitter = TestEmitter::new();
    let engine = env.engine.clone();
    spawn_op(
        engine.clone(),
        OpArgs {
            op_id: "op-conf".into(),
            kind: OpKind::Copy,
            sources: vec![srcdir.join("a.txt"), srcdir.join("b.txt")],
            dest_dir: dst.clone(),
            policy: Policy::Ask,
            verify: false,
        },
        Arc::new(emitter.clone()),
    );

    // Answer the first conflict with keepBoth + apply-to-all.
    let deadline = Instant::now() + Duration::from_secs(10);
    let conflict_id = loop {
        {
            let events = emitter.0.events.lock().unwrap();
            if let Some(OpEvent::Conflict { conflict_id, kind, remaining, .. }) =
                events.iter().find(|e| matches!(e, OpEvent::Conflict { .. }))
            {
                assert_eq!(*kind, "fileFile");
                assert_eq!(*remaining, 1);
                break *conflict_id;
            }
        }
        assert!(Instant::now() < deadline, "no conflict surfaced");
        std::thread::sleep(Duration::from_millis(20));
    };
    engine.respond_conflict("op-conf", conflict_id, Resolution::KeepBoth, true);

    let events = emitter.wait_done(Duration::from_secs(10));
    let (status, produced, _) = done_status(&events);
    assert_eq!(status, "success");
    // Apply-to-all: exactly one conflict prompt for two collisions.
    let prompts = events.iter().filter(|e| matches!(e, OpEvent::Conflict { .. })).count();
    assert_eq!(prompts, 1);
    assert_eq!(produced.len(), 2);
    assert_eq!(std::fs::read(dst.join("a.txt")).unwrap(), b"old-a");
    assert_eq!(std::fs::read(dst.join("a 2.txt")).unwrap(), b"new-a");
    assert_eq!(std::fs::read(dst.join("b 2.txt")).unwrap(), b"new-b");
    std::fs::remove_dir_all(&env.root).ok();
}

#[test]
fn replace_policy_trashes_original_and_is_not_undoable() {
    let env = env("replace");
    let srcdir = env.root.join("from");
    std::fs::create_dir_all(&srcdir).unwrap();
    std::fs::write(srcdir.join("doc.txt"), b"new").unwrap();
    let dst = env.root.join("to");
    std::fs::create_dir_all(&dst).unwrap();
    std::fs::write(dst.join("doc.txt"), b"old").unwrap();

    let emitter = TestEmitter::new();
    spawn_op(
        env.engine.clone(),
        OpArgs {
            op_id: "op-repl".into(),
            kind: OpKind::Copy,
            sources: vec![srcdir.join("doc.txt")],
            dest_dir: dst.clone(),
            policy: Policy::Replace,
            verify: false,
        },
        Arc::new(emitter.clone()),
    );
    let events = emitter.wait_done(Duration::from_secs(10));
    let (status, _, undoable) = done_status(&events);
    assert_eq!(status, "success");
    assert!(!undoable, "replace outcomes must not enter the undo stack");
    assert_eq!(std::fs::read(dst.join("doc.txt")).unwrap(), b"new");
    // The old original is recoverable from the (test) trash.
    let trashed: Vec<_> = std::fs::read_dir(&env.trash_dir).unwrap().flatten().collect();
    assert_eq!(trashed.len(), 1);
    std::fs::remove_dir_all(&env.root).ok();
}

#[test]
fn dir_merge_combines_and_prompts_file_level_lazily() {
    let env = env("merge");
    let srcdir = env.root.join("from");
    std::fs::create_dir_all(srcdir.join("Project/sub")).unwrap();
    std::fs::write(srcdir.join("Project/keep-src.txt"), b"from-src").unwrap();
    std::fs::write(srcdir.join("Project/collide.txt"), b"src-version").unwrap();
    std::fs::write(srcdir.join("Project/sub/nested.txt"), b"nested").unwrap();
    let dst = env.root.join("to");
    std::fs::create_dir_all(dst.join("Project")).unwrap();
    std::fs::write(dst.join("Project/keep-dst.txt"), b"from-dst").unwrap();
    std::fs::write(dst.join("Project/collide.txt"), b"dst-version").unwrap();

    let emitter = TestEmitter::new();
    let engine = env.engine.clone();
    spawn_op(
        engine.clone(),
        OpArgs {
            op_id: "op-merge".into(),
            kind: OpKind::Copy,
            sources: vec![srcdir.join("Project")],
            dest_dir: dst.clone(),
            policy: Policy::Ask,
            verify: false,
        },
        Arc::new(emitter.clone()),
    );

    // First conflict: dirDir → answer Merge.
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut answered_merge = false;
    let mut answered_file = false;
    loop {
        let pending: Vec<(u64, String)> = {
            let events = emitter.0.events.lock().unwrap();
            events
                .iter()
                .filter_map(|e| match e {
                    OpEvent::Conflict { conflict_id, kind, .. } => Some((*conflict_id, kind.to_string())),
                    _ => None,
                })
                .collect()
        };
        for (id, kind) in pending {
            if kind == "dirDir" && !answered_merge {
                engine.respond_conflict("op-merge", id, Resolution::Merge, false);
                answered_merge = true;
            } else if kind == "fileFile" && !answered_file {
                engine.respond_conflict("op-merge", id, Resolution::Skip, false);
                answered_file = true;
            }
        }
        {
            let events = emitter.0.events.lock().unwrap();
            if events.iter().any(|e| matches!(e, OpEvent::Done { .. })) {
                break;
            }
        }
        assert!(Instant::now() < deadline, "merge did not complete");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(answered_merge && answered_file);

    // Merge result: union of both sides, collide.txt untouched (Skip).
    assert_eq!(std::fs::read(dst.join("Project/keep-dst.txt")).unwrap(), b"from-dst");
    assert_eq!(std::fs::read(dst.join("Project/keep-src.txt")).unwrap(), b"from-src");
    assert_eq!(std::fs::read(dst.join("Project/collide.txt")).unwrap(), b"dst-version");
    assert_eq!(std::fs::read(dst.join("Project/sub/nested.txt")).unwrap(), b"nested");
    assert_eq!(count_staging(&env.root), 0);
    std::fs::remove_dir_all(&env.root).ok();
}

#[test]
fn case_insensitive_collision_detected() {
    let env = env("caseci");
    let srcdir = env.root.join("from");
    std::fs::create_dir_all(&srcdir).unwrap();
    std::fs::write(srcdir.join("README.txt"), b"upper").unwrap();
    let dst = env.root.join("to");
    std::fs::create_dir_all(&dst).unwrap();
    std::fs::write(dst.join("readme.txt"), b"lower").unwrap();

    let emitter = TestEmitter::new();
    spawn_op(
        env.engine.clone(),
        OpArgs {
            op_id: "op-ci".into(),
            kind: OpKind::Copy,
            sources: vec![srcdir.join("README.txt")],
            dest_dir: dst.clone(),
            policy: Policy::Skip, // collision must be detected → skipped
            verify: false,
        },
        Arc::new(emitter.clone()),
    );
    let events = emitter.wait_done(Duration::from_secs(10));
    let (status, produced, undoable) = done_status(&events);
    assert!(produced.is_empty(), "case-variant name must be treated as a conflict");
    assert_eq!(status, "success");
    assert!(!undoable);
    assert!(env.engine.undo.lock().unwrap().undo_top().is_none());
    assert!(events.iter().any(|event| matches!(
        event,
        OpEvent::Done { skipped: Some(1), .. }
    )));
    std::fs::remove_dir_all(&env.root).ok();
}

// ---------------------------------------------------------------------------
// Cancellation & crash safety
// ---------------------------------------------------------------------------

#[test]
fn cancel_mid_op_leaves_no_staging_and_source_untouched() {
    // Deterministic cancellation point: the op blocks on a conflict prompt
    // for its FIRST item; cancelling there must abandon the whole batch —
    // including the 200 files queued behind it — with zero staging left.
    let env = env("cancel");
    let src = env.root.join("src");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("collide.txt"), b"new").unwrap();
    let bulk = src.join("bulk");
    std::fs::create_dir_all(&bulk).unwrap();
    for i in 0..200 {
        std::fs::write(bulk.join(format!("f{:04}.bin", i)), vec![1u8; 64 * 1024]).unwrap();
    }
    let dst = env.root.join("dst");
    std::fs::create_dir_all(&dst).unwrap();
    std::fs::write(dst.join("collide.txt"), b"old").unwrap();

    let emitter = TestEmitter::new();
    spawn_op(
        env.engine.clone(),
        OpArgs {
            op_id: "op-cxl".into(),
            kind: OpKind::Copy,
            sources: vec![src.join("collide.txt"), bulk.clone()],
            dest_dir: dst.clone(),
            policy: Policy::Ask,
            verify: false,
        },
        Arc::new(emitter.clone()),
    );
    // Wait until the op is parked on the conflict, then cancel the op.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        {
            let events = emitter.0.events.lock().unwrap();
            if events.iter().any(|e| matches!(e, OpEvent::Conflict { .. })) {
                break;
            }
        }
        assert!(Instant::now() < deadline, "conflict never surfaced");
        std::thread::sleep(Duration::from_millis(10));
    }
    env.engine.cancel_op("op-cxl");

    let events = emitter.wait_done(Duration::from_secs(10));
    let (status, produced, _) = done_status(&events);
    assert_eq!(status, "cancelled");
    assert!(produced.is_empty());
    // Destination has only its pre-existing file, no staging; source intact.
    assert_eq!(count_staging(&env.root), 0);
    let dst_names: Vec<_> = std::fs::read_dir(&dst)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(dst_names, vec!["collide.txt".to_string()]);
    assert_eq!(std::fs::read(dst.join("collide.txt")).unwrap(), b"old");
    assert_eq!(std::fs::read_dir(&bulk).unwrap().count(), 200);
    assert!(env.engine.journal.recover().is_empty());
    std::fs::remove_dir_all(&env.root).ok();
}

#[test]
fn simulated_crash_recovery_removes_staging_keeps_promoted() {
    // kill -9 semantics: journal written, staging on disk, no cleanup ran.
    let env = env("crash");
    let dst = env.root.join("dst");
    std::fs::create_dir_all(&dst).unwrap();

    // A fully promoted item from "before the crash".
    std::fs::write(dst.join("promoted.txt"), b"safe").unwrap();
    // A half-copied staging artifact.
    let staging = dst.join(".BigFolder.fazi-partial-op-crash");
    std::fs::create_dir_all(&staging).unwrap();
    std::fs::write(staging.join("half.bin"), vec![0u8; 1024]).unwrap();

    env.engine
        .journal
        .write(&fazi_lib::core::journal::OpJournalEntry {
            op_id: "op-crash".into(),
            kind: "copy".into(),
            sources: vec!["/somewhere/BigFolder".into(), "/somewhere/promoted.txt".into()],
            dest_dir: dst.to_string_lossy().into_owned(),
            staging: vec![staging.to_string_lossy().into_owned()],
            merge_roots: vec![],
            completed: vec![dst.join("promoted.txt").to_string_lossy().into_owned()],
            total: 2,
            started_at_ms: 0,
        })
        .unwrap();

    // Relaunch: recovery runs.
    let report = env.engine.journal.recover();
    assert_eq!(report.len(), 1);
    assert_eq!(report[0].completed, 1);
    assert_eq!(report[0].total, 2);
    // Destination contains only fully-promoted items.
    assert!(!staging.exists());
    assert_eq!(std::fs::read(dst.join("promoted.txt")).unwrap(), b"safe");
    assert_eq!(count_staging(&env.root), 0);
    std::fs::remove_dir_all(&env.root).ok();
}

// ---------------------------------------------------------------------------
// Partial failure & duplicate
// ---------------------------------------------------------------------------

#[test]
fn partial_batch_failure_continues_and_undo_covers_only_successes() {
    let env = env("partial");
    let srcdir = env.root.join("from");
    std::fs::create_dir_all(&srcdir).unwrap();
    std::fs::write(srcdir.join("good.txt"), b"ok").unwrap();
    let missing = srcdir.join("ghost.txt"); // never created
    let dst = env.root.join("to");
    std::fs::create_dir_all(&dst).unwrap();

    let emitter = TestEmitter::new();
    spawn_op(
        env.engine.clone(),
        OpArgs {
            op_id: "op-part".into(),
            kind: OpKind::Move,
            sources: vec![missing.clone(), srcdir.join("good.txt")],
            dest_dir: dst.clone(),
            policy: Policy::Ask,
            verify: false,
        },
        Arc::new(emitter.clone()),
    );
    let events = emitter.wait_done(Duration::from_secs(10));
    let (status, produced, undoable) = done_status(&events);
    assert_eq!(status, "partial");
    assert_eq!(produced, vec![dst.join("good.txt").to_string_lossy().into_owned()]);
    assert!(events.iter().any(|e| matches!(e, OpEvent::ItemError { path, .. } if path.contains("ghost"))));
    assert!(undoable);

    // Undo restores exactly what moved — nothing else.
    let outcome = env
        .engine
        .undo
        .lock()
        .unwrap()
        .undo(env.engine.trasher.as_ref())
        .unwrap()
        .unwrap();
    assert_eq!(outcome.restored, vec![srcdir.join("good.txt")]);
    assert!(srcdir.join("good.txt").exists());
    std::fs::remove_dir_all(&env.root).ok();
}

#[test]
fn duplicate_uses_copy_naming() {
    let env = env("dup");
    let f = env.root.join("report.pdf");
    std::fs::write(&f, b"pdf-bytes").unwrap();

    let emitter = TestEmitter::new();
    spawn_duplicate(
        env.engine.clone(),
        "op-dup".into(),
        vec![f.clone()],
        Arc::new(emitter.clone()),
    );
    let events = emitter.wait_done(Duration::from_secs(10));
    let (status, produced, undoable) = done_status(&events);
    assert_eq!(status, "success");
    assert!(undoable);
    assert_eq!(produced, vec![env.root.join("report copy.pdf").to_string_lossy().into_owned()]);
    assert_eq!(std::fs::read(env.root.join("report copy.pdf")).unwrap(), b"pdf-bytes");
    std::fs::remove_dir_all(&env.root).ok();
}

// ---------------------------------------------------------------------------
// Replace crash safety (direct swap, trash failure, journal fail-fast)
// ---------------------------------------------------------------------------

/// Pins the property that recovery can never delete the source of a
/// same-volume move-replace: at the post-swap crash point (parked inside the
/// trasher) the on-disk journal must have an empty `staging` array and the
/// destination must already hold the new content.
#[test]
fn move_replace_same_volume_never_registers_source_in_staging() {
    let trasher = Arc::new(BlockingTrasher::new(
        std::env::temp_dir()
            .join(format!("fazi-engine-swapstage-{}", std::process::id()))
            .join(".test-trash"),
    ));
    let env = env_with("swapstage", Some(trasher.clone()));
    if !swap_supported(&env.root) {
        std::fs::remove_dir_all(&env.root).ok();
        return;
    }
    let srcdir = env.root.join("from");
    std::fs::create_dir_all(&srcdir).unwrap();
    std::fs::write(srcdir.join("doc.txt"), b"new").unwrap();
    let dst = env.root.join("to");
    std::fs::create_dir_all(&dst).unwrap();
    std::fs::write(dst.join("doc.txt"), b"old").unwrap();

    let emitter = TestEmitter::new();
    spawn_op(
        env.engine.clone(),
        OpArgs {
            op_id: "op-swapstage".into(),
            kind: OpKind::Move,
            sources: vec![srcdir.join("doc.txt")],
            dest_dir: dst.clone(),
            policy: Policy::Replace,
            verify: false,
        },
        Arc::new(emitter.clone()),
    );

    // Parked inside trash() — the post-swap crash point.
    trasher.wait_entered(Duration::from_secs(10));
    let journal_json =
        std::fs::read_to_string(env.root.join(".journal/op-swapstage.json")).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&journal_json).unwrap();
    assert_eq!(
        parsed["staging"].as_array().unwrap().len(),
        0,
        "the source must never be registered in staging: {}",
        journal_json
    );
    // The swap already happened: dest holds the new content.
    assert_eq!(std::fs::read(dst.join("doc.txt")).unwrap(), b"new");

    trasher.release();
    let events = emitter.wait_done(Duration::from_secs(10));
    let (status, _, _) = done_status(&events);
    assert_eq!(status, "success");
    // Old original trashed; no staging anywhere.
    let trashed: Vec<_> = std::fs::read_dir(&trasher.inner.0).unwrap().flatten().collect();
    assert_eq!(trashed.len(), 1);
    assert_eq!(std::fs::read(trashed[0].path()).unwrap(), b"old");
    assert_eq!(count_staging(&env.root), 0);
    std::fs::remove_dir_all(&env.root).ok();
    std::fs::remove_dir_all(trasher.inner.0.parent().unwrap()).ok();
}

/// A fabricated post-crash journal for a move op: recovery must delete the
/// throwaway partial but never touch the intact source.
#[test]
fn crash_recovery_of_move_op_keeps_source() {
    let env = env("crashmove");
    let src = env.root.join("src");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("doc.txt"), b"precious").unwrap();
    let dst = env.root.join("dst");
    std::fs::create_dir_all(&dst).unwrap();
    let partial = dst.join(".doc.txt.fazi-partial-op-crashmove");
    std::fs::write(&partial, b"half").unwrap();

    env.engine
        .journal
        .write(&fazi_lib::core::journal::OpJournalEntry {
            op_id: "op-crashmove".into(),
            kind: "move".into(),
            sources: vec![src.join("doc.txt").to_string_lossy().into_owned()],
            dest_dir: dst.to_string_lossy().into_owned(),
            staging: vec![partial.to_string_lossy().into_owned()],
            merge_roots: vec![],
            completed: vec![],
            total: 1,
            started_at_ms: 0,
        })
        .unwrap();

    let report = env.engine.journal.recover();
    assert_eq!(report.len(), 1);
    assert!(!partial.exists(), "throwaway partial must be cleaned up");
    assert_eq!(
        std::fs::read(src.join("doc.txt")).unwrap(),
        b"precious",
        "recovery must never touch the source"
    );
    std::fs::remove_dir_all(&env.root).ok();
}

/// Post-swap trash failure: the replacement is done and reported as success
/// with a warning; the old original is stranded but never destroyed.
#[test]
fn post_swap_trash_failure_replaces_and_strands_old_original() {
    // Copy-kind (staged path): leftover is rescued out of the staging name.
    {
        let env = env_with("trashfailcopy", Some(Arc::new(FailTrasher)));
        if !swap_supported(&env.root) {
            std::fs::remove_dir_all(&env.root).ok();
            return;
        }
        let srcdir = env.root.join("from");
        std::fs::create_dir_all(&srcdir).unwrap();
        std::fs::write(srcdir.join("doc.txt"), b"new").unwrap();
        let dst = env.root.join("to");
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(dst.join("doc.txt"), b"old").unwrap();

        let emitter = TestEmitter::new();
        spawn_op(
            env.engine.clone(),
            OpArgs {
                op_id: "op-tfc".into(),
                kind: OpKind::Copy,
                sources: vec![srcdir.join("doc.txt")],
                dest_dir: dst.clone(),
                policy: Policy::Replace,
            verify: false,
            },
            Arc::new(emitter.clone()),
        );
        let events = emitter.wait_done(Duration::from_secs(10));
        let (status, _, _) = done_status(&events);
        assert_eq!(status, "success");
        let warning_path = events
            .iter()
            .find_map(|e| match e {
                OpEvent::Warning { path, .. } => Some(PathBuf::from(path)),
                _ => None,
            })
            .expect("a Warning event must carry the leftover path");
        assert_eq!(std::fs::read(dst.join("doc.txt")).unwrap(), b"new");
        assert_eq!(
            std::fs::read(&warning_path).unwrap(),
            b"old",
            "the old original must survive at the leftover path"
        );
        std::fs::remove_dir_all(&env.root).ok();
    }

    // Move-kind (direct swap): the old original sits at the SOURCE path —
    // regression for the old mis-restore that renamed old-dest content over
    // the source.
    {
        let env = env_with("trashfailmove", Some(Arc::new(FailTrasher)));
        if !swap_supported(&env.root) {
            std::fs::remove_dir_all(&env.root).ok();
            return;
        }
        let srcdir = env.root.join("from");
        std::fs::create_dir_all(&srcdir).unwrap();
        std::fs::write(srcdir.join("doc.txt"), b"new").unwrap();
        let dst = env.root.join("to");
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(dst.join("doc.txt"), b"old").unwrap();

        let emitter = TestEmitter::new();
        spawn_op(
            env.engine.clone(),
            OpArgs {
                op_id: "op-tfm".into(),
                kind: OpKind::Move,
                sources: vec![srcdir.join("doc.txt")],
                dest_dir: dst.clone(),
                policy: Policy::Replace,
            verify: false,
            },
            Arc::new(emitter.clone()),
        );
        let events = emitter.wait_done(Duration::from_secs(10));
        let (status, _, _) = done_status(&events);
        assert_eq!(status, "success");
        assert!(events.iter().any(|e| matches!(e, OpEvent::Warning { .. })));
        // Source content landed at dest; old original sits at the source path.
        assert_eq!(std::fs::read(dst.join("doc.txt")).unwrap(), b"new");
        assert_eq!(std::fs::read(srcdir.join("doc.txt")).unwrap(), b"old");
        assert_eq!(count_staging(&env.root), 0);
        std::fs::remove_dir_all(&env.root).ok();
    }
}

/// The rescued leftover must be immune to crash recovery: not a staging name,
/// and it must survive a `recover()` run over the pre-crash journal state.
#[test]
fn staged_trash_failure_moves_leftover_out_of_staging() {
    let env = env_with("leftoverrescue", Some(Arc::new(FailTrasher)));
    if !swap_supported(&env.root) {
        std::fs::remove_dir_all(&env.root).ok();
        return;
    }
    let srcdir = env.root.join("from");
    std::fs::create_dir_all(&srcdir).unwrap();
    std::fs::write(srcdir.join("doc.txt"), b"new").unwrap();
    let dst = env.root.join("to");
    std::fs::create_dir_all(&dst).unwrap();
    std::fs::write(dst.join("doc.txt"), b"old").unwrap();

    let emitter = TestEmitter::new();
    spawn_op(
        env.engine.clone(),
        OpArgs {
            op_id: "op-rescue".into(),
            kind: OpKind::Copy,
            sources: vec![srcdir.join("doc.txt")],
            dest_dir: dst.clone(),
            policy: Policy::Replace,
            verify: false,
        },
        Arc::new(emitter.clone()),
    );
    let events = emitter.wait_done(Duration::from_secs(10));
    let (status, _, _) = done_status(&events);
    assert_eq!(status, "success");
    let leftover = events
        .iter()
        .find_map(|e| match e {
            OpEvent::Warning { path, .. } => Some(PathBuf::from(path)),
            _ => None,
        })
        .expect("warning with leftover path");
    let leftover_name = leftover.file_name().unwrap().to_string_lossy().into_owned();
    assert!(
        !is_staging_name(&leftover_name, "op-rescue"),
        "leftover must not carry a staging name: {}",
        leftover_name
    );

    // Replay the pre-crash journal state (stage still registered, dest dir a
    // merge root) and run recovery: the rescued leftover must survive both
    // deletion mechanisms.
    let stage = dst.join(".doc.txt.fazi-partial-op-rescue");
    env.engine
        .journal
        .write(&fazi_lib::core::journal::OpJournalEntry {
            op_id: "op-rescue".into(),
            kind: "copy".into(),
            sources: vec![srcdir.join("doc.txt").to_string_lossy().into_owned()],
            dest_dir: dst.to_string_lossy().into_owned(),
            staging: vec![stage.to_string_lossy().into_owned()],
            merge_roots: vec![dst.to_string_lossy().into_owned()],
            completed: vec![],
            total: 1,
            started_at_ms: 0,
        })
        .unwrap();
    let report = env.engine.journal.recover();
    assert_eq!(report.len(), 1);
    assert_eq!(
        std::fs::read(&leftover).unwrap(),
        b"old",
        "recovery must never delete the rescued leftover"
    );
    std::fs::remove_dir_all(&env.root).ok();
}

/// Journal write failure aborts before any fs mutation — and the enumeration
/// thread (spawned only after a successful intent write) never emits a stray
/// Enumerated event after the failed Done. Covers both entry points.
#[test]
fn journal_write_failure_aborts_before_any_fs_mutation() {
    // Copy/move entry point.
    {
        let env = env("journalfail");
        // Sabotage: replace the journal dir with a plain file.
        let jdir = env.root.join(".journal");
        std::fs::remove_dir_all(&jdir).unwrap();
        std::fs::write(&jdir, b"not a dir").unwrap();

        let src = env.root.join("src");
        make_tree(&src, 3);
        let dst = env.root.join("dst");
        std::fs::create_dir_all(&dst).unwrap();

        let emitter = TestEmitter::new();
        spawn_op(
            env.engine.clone(),
            OpArgs {
                op_id: "op-jfail".into(),
                kind: OpKind::Copy,
                sources: vec![src.clone()],
                dest_dir: dst.clone(),
                policy: Policy::Ask,
            verify: false,
            },
            Arc::new(emitter.clone()),
        );
        let events = emitter.wait_done(Duration::from_secs(10));
        let (status, produced, _) = done_status(&events);
        assert_eq!(status, "failed");
        assert!(produced.is_empty());
        assert!(events.iter().any(|e| matches!(
            e,
            OpEvent::Done { errors, .. } if errors.iter().any(|err| err.message.contains("journal"))
        )));
        // No fs mutation: source intact, destination empty, no staging.
        assert!(src.join("file000.txt").exists());
        assert_eq!(std::fs::read_dir(&dst).unwrap().count(), 0);
        assert_eq!(count_staging(&env.root), 0);
        // The enumeration thread was never spawned — give a straggler every
        // chance to appear, then assert it didn't.
        std::thread::sleep(Duration::from_millis(300));
        let events = emitter.0.events.lock().unwrap();
        assert!(
            !events.iter().any(|e| matches!(e, OpEvent::Enumerated { .. })),
            "no Enumerated event may follow a failed intent write"
        );
        drop(events);
        std::fs::remove_dir_all(&env.root).ok();
    }

    // Duplicate entry point (has its own pre-write enumeration spawn).
    {
        let env = env("journalfaildup");
        let jdir = env.root.join(".journal");
        std::fs::remove_dir_all(&jdir).unwrap();
        std::fs::write(&jdir, b"not a dir").unwrap();

        let f = env.root.join("report.pdf");
        std::fs::write(&f, b"pdf-bytes").unwrap();

        let emitter = TestEmitter::new();
        spawn_duplicate(
            env.engine.clone(),
            "op-jfaildup".into(),
            vec![f.clone()],
            Arc::new(emitter.clone()),
        );
        let events = emitter.wait_done(Duration::from_secs(10));
        let (status, produced, _) = done_status(&events);
        assert_eq!(status, "failed");
        assert!(produced.is_empty());
        assert!(!env.root.join("report copy.pdf").exists());
        assert_eq!(count_staging(&env.root), 0);
        std::thread::sleep(Duration::from_millis(300));
        let events = emitter.0.events.lock().unwrap();
        assert!(
            !events.iter().any(|e| matches!(e, OpEvent::Enumerated { .. })),
            "no Enumerated event may follow a failed intent write"
        );
        drop(events);
        std::fs::remove_dir_all(&env.root).ok();
    }
}

#[test]
fn move_into_itself_is_rejected_per_item() {
    let env = env("self");
    let src = env.root.join("folder");
    std::fs::create_dir_all(src.join("inner")).unwrap();

    let emitter = TestEmitter::new();
    spawn_op(
        env.engine.clone(),
        OpArgs {
            op_id: "op-self".into(),
            kind: OpKind::Move,
            sources: vec![src.clone()],
            dest_dir: src.join("inner"),
            policy: Policy::Ask,
            verify: false,
        },
        Arc::new(emitter.clone()),
    );
    let events = emitter.wait_done(Duration::from_secs(10));
    let (status, produced, _) = done_status(&events);
    assert_eq!(status, "failed");
    assert!(produced.is_empty());
    assert!(src.exists());
    std::fs::remove_dir_all(&env.root).ok();
}

#[test]
fn verified_copy_emits_verifying_phase_and_succeeds_clean() {
    let env = env("verifycopy");
    let src = env.root.join("src");
    std::fs::create_dir_all(src.join("sub")).unwrap();
    std::fs::write(src.join("a.txt"), b"alpha").unwrap();
    std::fs::write(src.join("sub/b.bin"), vec![9u8; 64 * 1024]).unwrap();
    std::os::unix::fs::symlink("a.txt", src.join("link")).unwrap();
    let dst = env.root.join("dst");
    std::fs::create_dir_all(&dst).unwrap();

    let emitter = TestEmitter::new();
    spawn_op(
        env.engine.clone(),
        OpArgs {
            op_id: "op-verify".into(),
            kind: OpKind::Copy,
            sources: vec![src.clone()],
            dest_dir: dst.clone(),
            policy: Policy::Ask,
            verify: true,
        },
        Arc::new(emitter.clone()),
    );
    let events = emitter.wait_done(Duration::from_secs(10));
    let (status, produced, undoable) = done_status(&events);
    assert_eq!(status, "success");
    assert_eq!(produced.len(), 1);
    assert!(undoable);
    // The wire-level phase announced the checksum pass.
    let saw_verifying = events.iter().any(|e| {
        matches!(e, OpEvent::Progress { phase: Some(p), .. } if *p == "verifying")
    });
    assert!(saw_verifying, "expected a phase=verifying Progress event");
    // And the copy verified clean end-to-end.
    assert_eq!(std::fs::read(dst.join("src/a.txt")).unwrap(), b"alpha");
    std::fs::remove_dir_all(&env.root).ok();
}

#[test]
fn checksum_mismatch_keeps_copy_reports_partial_and_remains_undoable() {
    let env = env_with_verifier(
        "verify-mismatch",
        None,
        Arc::new(|_, _, _| ChecksumReport {
            mismatches: vec!["data.bin: BLAKE3 checksum differs".into()],
            cancelled: false,
        }),
    );
    let src_dir = env.root.join("src");
    let dst = env.root.join("dst");
    std::fs::create_dir_all(&src_dir).unwrap();
    std::fs::create_dir_all(&dst).unwrap();
    let source = src_dir.join("data.bin");
    std::fs::write(&source, b"content").unwrap();

    let emitter = TestEmitter::new();
    spawn_op(
        env.engine.clone(),
        OpArgs {
            op_id: "op-verify-mismatch".into(),
            kind: OpKind::Copy,
            sources: vec![source],
            dest_dir: dst.clone(),
            policy: Policy::Ask,
            verify: true,
        },
        Arc::new(emitter.clone()),
    );
    let events = emitter.wait_done(Duration::from_secs(10));
    let (status, produced, undoable) = done_status(&events);
    // A mismatch is a per-item error: op → partial, but the suspect copy
    // stays on disk AND in `produced`, and the op remains undoable.
    assert_eq!(status, "partial");
    assert!(undoable);
    assert_eq!(produced, vec![dst.join("data.bin").to_string_lossy().into_owned()]);
    assert!(dst.join("data.bin").exists());
    let saw_verifying = events.iter().any(|e| {
        matches!(e, OpEvent::Progress { phase: Some(p), .. } if *p == "verifying")
    });
    assert!(saw_verifying, "expected a phase=verifying Progress event");
    assert!(events.iter().any(|e| matches!(
        e,
        OpEvent::ItemError { message, .. }
            if message.contains("copy kept for inspection; Undo removes it")
    )));

    // ⌘Z removes the suspect copy.
    env.engine
        .undo
        .lock()
        .unwrap()
        .undo(env.engine.trasher.as_ref())
        .unwrap()
        .expect("mismatch copy should be undoable");
    assert!(!dst.join("data.bin").exists());
    std::fs::remove_dir_all(&env.root).ok();
}

#[test]
fn streamed_copy_reports_touched_paths_to_fuzzy_invalidator() {
    let recorded: Arc<Mutex<Vec<PathBuf>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = recorded.clone();
    let env = env_with_invalidator(
        "fuzzy-invalidate",
        Arc::new(move |paths: &[PathBuf]| {
            sink.lock().unwrap().extend(paths.iter().cloned());
        }),
    );
    let src_dir = env.root.join("src");
    let dst = env.root.join("dst");
    std::fs::create_dir_all(&src_dir).unwrap();
    std::fs::create_dir_all(&dst).unwrap();
    let source = src_dir.join("a.txt");
    std::fs::write(&source, b"alpha").unwrap();

    let emitter = TestEmitter::new();
    spawn_op(
        env.engine.clone(),
        OpArgs {
            op_id: "op-fuzzy-invalidate".into(),
            kind: OpKind::Copy,
            sources: vec![source.clone()],
            dest_dir: dst.clone(),
            policy: Policy::Ask,
            verify: false,
        },
        Arc::new(emitter.clone()),
    );
    let events = emitter.wait_done(Duration::from_secs(10));
    let (status, _, _) = done_status(&events);
    assert_eq!(status, "success");

    // The epilogue reported source + produced dest before Done.
    let touched = recorded.lock().unwrap().clone();
    assert!(touched.contains(&source), "sources missing from invalidation: {touched:?}");
    assert!(
        touched.contains(&dst.join("a.txt")),
        "produced dest missing from invalidation: {touched:?}"
    );
    std::fs::remove_dir_all(&env.root).ok();
}
