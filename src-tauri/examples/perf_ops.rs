//! Synthetic benchmarks for the file-ops / search hot paths.
//!
//! Usage: cargo run --release --example perf_ops -- [out.json] [iters]
//!
//! Every case builds its own data under a temp dir, runs `iters` times
//! (default 3) and reports the median. Output: one JSON object per case
//! (`{"name","unit","value","note"}`) — the before/after table is assembled
//! by running the same harness on two trees. Cases:
//! - journal: N per-item updates through the journal API (bytes, fsyncs, ms)
//! - engine move: 10k-file same-volume move (ms, Progress events)
//! - names: batch-rename validation / keep-both naming in a 20k-entry dir
//! - fuzzy refresh: refreshes triggered by K warms after one op
//! - mdfind: time to first hit message, message count
//! - fuzzy scan: 1M-entry synthetic index query latency (plain + kind filter)
//! - verify_tree: 50k files (ms, peak heap)
//! - checksum: clone copy vs byte copy (ms)
//! - empty trash: progress callbacks for 20k items
//! - compress: multi-source compress onto another volume (needs
//!   FAZI_BENCH_VOLUME=<mounted dir on a second volume>)

use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use fazi_lib::core::journal::{Journal, OpJournalEntry};
use fazi_lib::core::op_queue::{spawn_op, Engine, OpArgs, OpEmitter, OpEvent, OpKind, Policy};
use fazi_lib::core::undo::UndoStack;
use fazi_lib::core::walker::DirTrasher;
use fazi_lib::search::fuzzy::{config_hash, run_query, FuzzyFilters, FuzzyIndex, IndexedPath};

// ---------------------------------------------------------------------------
// Peak-heap tracking allocator
// ---------------------------------------------------------------------------

struct Counting;
static CUR: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(l) };
        if !p.is_null() {
            let now = CUR.fetch_add(l.size(), Ordering::Relaxed) + l.size();
            PEAK.fetch_max(now, Ordering::Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) };
        CUR.fetch_sub(l.size(), Ordering::Relaxed);
    }
}

#[global_allocator]
static A: Counting = Counting;

fn reset_peak() -> usize {
    let cur = CUR.load(Ordering::Relaxed);
    PEAK.store(cur, Ordering::Relaxed);
    cur
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("fazi-perf-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

struct Out(Mutex<Vec<String>>);
impl Out {
    fn push(&self, name: &str, unit: &str, value: f64, note: &str) {
        eprintln!("{name:<40} {value:>14.3} {unit}  {note}");
        self.0.lock().unwrap().push(format!(
            "{{\"name\":{:?},\"unit\":{:?},\"value\":{},\"note\":{:?}}}",
            name, unit, value, note
        ));
    }
}

#[derive(Clone)]
struct Collector(Arc<(Mutex<Vec<OpEvent>>, Condvar)>);
impl OpEmitter for Collector {
    fn emit(&self, e: OpEvent) {
        let done = matches!(e, OpEvent::Done { .. });
        self.0 .0.lock().unwrap().push(e);
        if done {
            self.0 .1.notify_all();
        }
    }
}
impl Collector {
    fn new() -> Self {
        Collector(Arc::new((Mutex::new(Vec::new()), Condvar::new())))
    }
    fn wait(&self) -> Vec<OpEvent> {
        let mut ev = self.0 .0.lock().unwrap();
        while !ev.iter().any(|e| matches!(e, OpEvent::Done { .. })) {
            ev = self.0 .1.wait(ev).unwrap();
        }
        std::mem::take(&mut *ev)
    }
}

fn engine(root: &Path) -> Arc<Engine> {
    Arc::new(Engine {
        trasher: Arc::new(DirTrasher(root.join(".trash"))),
        journal: Arc::new(Journal::new(root.join(".journal")).unwrap()),
        undo: Arc::new(Mutex::new(UndoStack::default())),
        ops: DashMap::new(),
        volume_locks: DashMap::new(),
        icon_token: Arc::new(|_, _| String::new()),
        verify_copy_contents: Arc::new(|s, d, c| fazi_lib::core::verify::checksum_compare(s, d, c)),
        invalidate_fuzzy: Arc::new(|_| {}),
        undo_changed: Arc::new(|_| {}),
    })
}

fn write_files(dir: &Path, n: usize, size: usize) {
    std::fs::create_dir_all(dir).unwrap();
    let data = vec![b'x'; size];
    for i in 0..n {
        std::fs::write(dir.join(format!("file-{i:06}.dat")), &data).unwrap();
    }
}

fn byte_copy_tree(src: &Path, dst: &Path) {
    std::fs::create_dir_all(dst).unwrap();
    for e in std::fs::read_dir(src).unwrap().flatten() {
        let p = e.path();
        let t = dst.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            byte_copy_tree(&p, &t);
        } else {
            std::fs::write(&t, std::fs::read(&p).unwrap()).unwrap();
        }
    }
}

// ---------------------------------------------------------------------------
// Version-specific shims (the baseline copy of this file swaps this module)
// ---------------------------------------------------------------------------

mod compat {
    use super::*;
    use fazi_lib::search::mdfind::SearchEvent;

    pub const VERSION: &str = "after";

    /// Bytes the journal wrote so far.
    pub fn journal_bytes(j: &Journal, _sequence_bytes: u64) -> u64 {
        j.bytes_written()
    }
    pub fn journal_syncs(j: &Journal, _writes: u64) -> u64 {
        j.syncs()
    }

    /// (is a hit-carrying message, hits in it)
    pub fn hit_msg(e: &SearchEvent) -> Option<usize> {
        match e {
            SearchEvent::Hits { hits } => Some(hits.len()),
            _ => None,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn refresh(
        fuzzy: Arc<DashMap<PathBuf, Arc<FuzzyIndex>>>,
        pending: Arc<DashMap<PathBuf, Arc<FuzzyIndex>>>,
        old: Arc<FuzzyIndex>,
        root: PathBuf,
        hash: u64,
        snapshot: PathBuf,
    ) -> bool {
        fazi_lib::commands::fuzzy::spawn_refresh(
            fuzzy,
            pending,
            Arc::new(fazi_lib::state::TokenTable::default()),
            Arc::new(fazi_lib::core::volume_gate::VolumeGate::default()),
            old,
            root,
            vec![],
            u64::MAX,
            hash,
            snapshot,
        )
    }
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

/// Per-item journal updates exactly as `run_op_thread` issues them for a
/// same-volume move: intent header with N sources, then one write per
/// promoted item (completed grows by one).
fn bench_journal(out: &Out, n: usize, iters: usize) {
    let mut times = Vec::new();
    let mut bytes = 0u64;
    let mut syncs = 0u64;
    for it in 0..iters {
        let d = tmp("journal");
        let j = Journal::new(d.join("j")).unwrap();
        let mut e = OpJournalEntry {
            op_id: format!("op-bench-{it}"),
            kind: "move".into(),
            sources: (0..n).map(|i| format!("/Users/someone/Projects/src/dir/file-{i:06}.dat")).collect(),
            dest_dir: "/Users/someone/Projects/dest".into(),
            staging: vec![],
            merge_roots: vec![],
            completed: vec![],
            total: n,
            started_at_ms: 0,
        };
        // Exact bytes of the previous whole-entry rewrite format, for the
        // baseline shim (pretty JSON per write).
        let mut seq_bytes = serde_json::to_vec_pretty(&e).unwrap().len() as u64;
        let t0 = Instant::now();
        j.write(&e).unwrap();
        for i in 0..n {
            e.completed.push(format!("/Users/someone/Projects/dest/file-{i:06}.dat"));
            j.write(&e).unwrap();
            if compat::VERSION == "before" {
                seq_bytes += serde_json::to_vec_pretty(&e).unwrap().len() as u64;
            }
        }
        times.push(t0.elapsed().as_secs_f64() * 1000.0);
        bytes = compat::journal_bytes(&j, seq_bytes);
        syncs = compat::journal_syncs(&j, n as u64 + 1);
        j.remove(&e.op_id);
        let _ = std::fs::remove_dir_all(&d);
    }
    let name = format!("journal: {n} per-item updates");
    out.push(&format!("{name} wall"), "ms", median(times), "same-volume move write pattern");
    out.push(&format!("{name} bytes"), "MB", bytes as f64 / 1e6, "header + records written");
    out.push(&format!("{name} fsyncs"), "count", syncs as f64, "fsync calls (file + dir)");
}

fn bench_engine_move(out: &Out, n: usize, iters: usize) {
    let mut times = Vec::new();
    let mut progress = 0usize;
    let mut jbytes = 0u64;
    for _ in 0..iters {
        let d = tmp("move");
        let src = d.join("src");
        write_files(&src, n, 16);
        let dst = d.join("dst");
        std::fs::create_dir_all(&dst).unwrap();
        let e = engine(&d);
        let sources: Vec<PathBuf> = (0..n).map(|i| src.join(format!("file-{i:06}.dat"))).collect();
        let em = Collector::new();
        let t0 = Instant::now();
        spawn_op(
            e.clone(),
            OpArgs {
                op_id: "op-move".into(),
                kind: OpKind::Move,
                sources,
                dest_dir: dst.clone(),
                policy: Policy::Ask,
                verify: false,
            },
            Arc::new(em.clone()),
        );
        let events = em.wait();
        times.push(t0.elapsed().as_secs_f64() * 1000.0);
        progress = events.iter().filter(|e| matches!(e, OpEvent::Progress { .. })).count();
        jbytes = compat::journal_bytes(&e.journal, 0);
        let _ = std::fs::remove_dir_all(&d);
    }
    out.push(&format!("engine: {n}-file same-volume move"), "ms", median(times), "spawn_op → Done");
    out.push(&format!("engine: {n}-file move Progress events"), "count", progress as f64, "channel messages");
    if compat::VERSION == "after" {
        out.push(&format!("engine: {n}-file move journal bytes"), "MB", jbytes as f64 / 1e6, "measured");
    }
}

fn bench_names(out: &Out, iters: usize) {
    let d = tmp("names");
    let dir = d.join("big");
    write_files(&dir, 20_000, 0);
    // 50 keep-both variants of one name.
    std::fs::write(dir.join("report.pdf"), b"").unwrap();
    for i in 2..=50 {
        std::fs::write(dir.join(format!("report {i}.pdf")), b"").unwrap();
    }
    let pairs: Vec<(String, String)> = (0..2000)
        .map(|i| (format!("file-{i:06}.dat"), format!("renamed-{i:06}.dat")))
        .collect();
    let mut t_batch = Vec::new();
    let mut t_kb = Vec::new();
    for _ in 0..iters {
        let t0 = Instant::now();
        fazi_lib::core::batch_rename::validate_batch(&dir, &pairs).unwrap();
        t_batch.push(t0.elapsed().as_secs_f64() * 1000.0);
        let t0 = Instant::now();
        for _ in 0..20 {
            let n = fazi_lib::core::walker::keep_both_name(&dir, "report.pdf");
            assert_eq!(n, "report 51.pdf");
        }
        t_kb.push(t_kb_ms(t0));
    }
    out.push("names: validate 2k renames in 20k dir", "ms", median(t_batch), "batch_rename::validate_batch");
    out.push("names: 20× keep-both past 50 variants, 20k dir", "ms", median(t_kb), "walker::keep_both_name");
    let _ = std::fs::remove_dir_all(&d);
}

fn t_kb_ms(t0: Instant) -> f64 {
    t0.elapsed().as_secs_f64() * 1000.0
}

fn bench_fuzzy_refresh(out: &Out, k: usize) {
    let d = tmp("refresh");
    let root = d.join("tree");
    for s in 0..20 {
        write_files(&root.join(format!("sub{s}")), 500, 0);
    }
    let cache = d.join("cache");
    std::fs::create_dir_all(&cache).unwrap();
    let snapshot = cache.join("snap.fzidx");
    let hash = config_hash(&[], u64::MAX);
    let idx = FuzzyIndex::restore(root.clone(), hash, vec![], false, 0);
    let fuzzy: Arc<DashMap<PathBuf, Arc<FuzzyIndex>>> = Arc::new(DashMap::new());
    fuzzy.insert(root.clone(), idx);
    let pending: Arc<DashMap<PathBuf, Arc<FuzzyIndex>>> = Arc::new(DashMap::new());
    // One op lands under the root.
    fazi_lib::search::fuzzy::mark_stale_under(&fuzzy, &[root.join("sub0/file-000000.dat")]);
    let mut refreshes = 0;
    let t0 = Instant::now();
    for _ in 0..k {
        // fuzzy_warm's same-config reuse path.
        let existing = fuzzy.get(&root).unwrap().clone();
        if existing.stale.load(Ordering::SeqCst)
            && compat::refresh(fuzzy.clone(), pending.clone(), existing, root.clone(), hash, snapshot.clone())
        {
            refreshes += 1;
        }
        while !pending.is_empty() {
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    out.push(&format!("fuzzy: refreshes from {k} warms after 1 op"), "count", refreshes as f64, "full re-walk + snapshot rewrite each");
    out.push(&format!("fuzzy: {k} warms after 1 op (10k-entry tree)"), "ms", ms, "warm loop incl. refresh walks");
    let _ = std::fs::remove_dir_all(&d);
}

fn bench_mdfind(out: &Out, iters: usize) {
    use fazi_lib::search::mdfind::{spawn_search, SearchEvent, SearchFilters};
    let scope = PathBuf::from("/Library");
    let mut first = Vec::new();
    let mut msgs = Vec::new();
    let mut hits_n = 0usize;
    let mut total_ms = Vec::new();
    for _ in 0..iters {
        let (tx, rx) = std::sync::mpsc::channel::<(Instant, SearchEvent)>();
        let t0 = Instant::now();
        let _h = spawn_search(
            "e".into(),
            SearchFilters::default(),
            Some(scope.clone()),
            false,
            10_000,
            Arc::new(|_| String::new()),
            move |e| {
                let _ = tx.send((Instant::now(), e));
            },
        )
        .unwrap();
        let mut first_at = None;
        let mut n_msgs = 0;
        let mut n_hits = 0;
        loop {
            let (at, e) = rx.recv().unwrap();
            if let Some(n) = compat::hit_msg(&e) {
                first_at.get_or_insert(at);
                n_msgs += 1;
                n_hits += n;
            }
            if matches!(e, SearchEvent::Done { .. }) {
                total_ms.push((at - t0).as_secs_f64() * 1000.0);
                break;
            }
        }
        first.push(first_at.map(|a| (a - t0).as_secs_f64() * 1000.0).unwrap_or(f64::NAN));
        msgs.push(n_msgs as f64);
        hits_n = n_hits;
    }
    let note = format!("/Library, name contains \"e\": {hits_n} hits");
    out.push("mdfind: time to first hit message", "ms", median(first), &note);
    out.push("mdfind: time to Done", "ms", median(total_ms), &note);
    out.push("mdfind: hit messages", "count", median(msgs), &note);
}

fn synthetic_index(n: usize) -> Arc<FuzzyIndex> {
    let exts = ["rs", "md", "png", "jpg", "txt", "json", "ts", "pdf", "mov", "zip"];
    let words = ["main", "lib", "notes", "photo", "readme", "cargo", "index", "build", "test", "src"];
    let mut blocks = Vec::new();
    let mut block = Vec::new();
    for i in 0..n {
        let rel = format!(
            "{}/{}-{}/{}{}.{}",
            words[i % 10],
            words[(i / 10) % 10],
            i % 997,
            words[(i / 100) % 10],
            i,
            exts[(i / 7) % 10]
        );
        let name_len = rel.rsplit('/').next().unwrap().len() as u16;
        block.push(IndexedPath { rel: rel.into_boxed_str(), name_len, is_dir: false });
        if block.len() == 4096 {
            blocks.push(std::mem::take(&mut block));
        }
    }
    blocks.push(block);
    FuzzyIndex::restore(PathBuf::from("/synthetic"), 0, blocks, false, 0)
}

fn bench_fuzzy_scan(out: &Out, iters: usize) {
    let idx = synthetic_index(1_000_000);
    let cancel = AtomicBool::new(false);
    let mut plain = Vec::new();
    let mut kind = Vec::new();
    let image = FuzzyFilters { kind: Some("image".into()), ..Default::default() };
    for _ in 0..iters.max(5) {
        let t0 = Instant::now();
        let r = run_query(&idx, "mainphoto", 100, &FuzzyFilters::default(), &cancel, 0).unwrap();
        plain.push(t0.elapsed().as_secs_f64() * 1000.0);
        assert!(!r.hits.is_empty());
        let t0 = Instant::now();
        let r = run_query(&idx, "notes", 100, &image, &cancel, 0).unwrap();
        kind.push(t0.elapsed().as_secs_f64() * 1000.0);
        assert!(!r.hits.is_empty());
    }
    out.push("fuzzy scan: 1M entries, \"mainphoto\"", "ms", median(plain), "run_query top-100");
    out.push("fuzzy scan: 1M entries, \"notes\" kind:image", "ms", median(kind), "run_query top-100 + kind filter");
}

fn bench_verify_tree(out: &Out, iters: usize) {
    let d = tmp("verify");
    let src = d.join("src");
    for s in 0..50 {
        write_files(&src.join(format!("d{s:02}")), 1000, 8);
    }
    let dst = d.join("dst");
    let mut sink = fazi_lib::core::walker::SilentSink;
    fazi_lib::core::walker::copy_fresh(&src, &dst, &mut sink).unwrap();
    let mut times = Vec::new();
    let mut peak = 0usize;
    for _ in 0..iters {
        let base = reset_peak();
        let t0 = Instant::now();
        let r = fazi_lib::core::walker::verify_tree(&src, &dst, &HashSet::new(), 2).unwrap();
        times.push(t0.elapsed().as_secs_f64() * 1000.0);
        peak = PEAK.load(Ordering::Relaxed).saturating_sub(base);
        assert!(r.mismatches.is_empty());
    }
    out.push("verify_tree: 50k files", "ms", median(times), "cross-volume move gate");
    out.push("verify_tree: 50k files peak heap", "MB", peak as f64 / 1e6, "allocator high-water mark");
    let _ = std::fs::remove_dir_all(&d);
}

fn bench_checksum(out: &Out, iters: usize) {
    let d = tmp("checksum");
    let src = d.join("src");
    std::fs::create_dir_all(&src).unwrap();
    let chunk: Vec<u8> = (0..(64 << 20)).map(|i: u32| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
    for i in 0..8 {
        std::fs::write(src.join(format!("big{i}.bin")), &chunk).unwrap(); // 8 × 64 MiB
    }
    for i in 0..2000 {
        std::fs::write(src.join(format!("small{i}.txt")), b"tiny file contents").unwrap();
    }
    let clone = d.join("clone");
    let mut sink = fazi_lib::core::walker::SilentSink;
    fazi_lib::core::walker::copy_fresh(&src, &clone, &mut sink).unwrap();
    let bytes = d.join("bytes");
    byte_copy_tree(&src, &bytes);
    let never = || false;
    let mut t_clone = Vec::new();
    let mut t_bytes = Vec::new();
    for _ in 0..iters {
        let t0 = Instant::now();
        let r = fazi_lib::core::verify::checksum_compare(&src, &clone, &never);
        t_clone.push(t0.elapsed().as_secs_f64() * 1000.0);
        assert!(r.mismatches.is_empty());
        let t0 = Instant::now();
        let r = fazi_lib::core::verify::checksum_compare(&src, &bytes, &never);
        t_bytes.push(t0.elapsed().as_secs_f64() * 1000.0);
        assert!(r.mismatches.is_empty());
    }
    out.push("checksum: 512 MiB + 2k small, clone copy", "ms", median(t_clone), "verifyCopies on same-volume copy");
    out.push("checksum: 512 MiB + 2k small, byte copy", "ms", median(t_bytes), "verifyCopies on byte copy");
    let _ = std::fs::remove_dir_all(&d);
}

fn bench_empty_trash(out: &Out) {
    let d = tmp("trash");
    write_files(&d.join("t"), 20_000, 0);
    let mut calls = 0usize;
    let t0 = Instant::now();
    let o = fazi_lib::macos::trash::empty_trash_dirs(&[d.join("t")], &mut |_, _| calls += 1, &AtomicBool::new(false));
    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(o.deleted.len(), 20_000);
    out.push("empty trash: 20k items progress events", "count", calls as f64, &format!("{ms:.0} ms run"));
    let _ = std::fs::remove_dir_all(&d);
}

fn bench_compress_cross_volume(out: &Out, iters: usize) {
    let Ok(vol) = std::env::var("FAZI_BENCH_VOLUME") else {
        eprintln!("(skipping compress: set FAZI_BENCH_VOLUME)");
        return;
    };
    let d = tmp("compress");
    // Two sources, 256 MiB of zeros (compresses fast, so staging dominates).
    write_files(&d.join("a"), 16, 8 << 20);
    write_files(&d.join("b"), 16, 8 << 20);
    let mut times = Vec::new();
    for it in 0..iters {
        let dest = PathBuf::from(&vol).join(format!("out-{}-{it}", std::process::id()));
        std::fs::create_dir_all(&dest).unwrap();
        let e = engine(&d);
        let em = Collector::new();
        let t0 = Instant::now();
        fazi_lib::core::archive::spawn_compress(
            e,
            format!("op-cz-{it}"),
            vec![d.join("a"), d.join("b")],
            dest.clone(),
            Arc::new(em.clone()),
        );
        let ev = em.wait();
        times.push(t0.elapsed().as_secs_f64() * 1000.0);
        assert!(ev.iter().any(|e| matches!(e, OpEvent::Done { status: "success", .. })));
        let _ = std::fs::remove_dir_all(&dest);
    }
    out.push("compress: 2 sources (256 MiB) onto another volume", "ms", median(times), "spawn_compress → Done");
    let _ = std::fs::remove_dir_all(&d);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let out_path = args.get(1).cloned().unwrap_or_else(|| "/tmp/fazi-bench/perf_ops.json".into());
    let iters: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(3);
    let only = std::env::var("FAZI_BENCH_ONLY").ok();
    let run = |case: &str| only.as_deref().is_none_or(|o| o.split(',').any(|c| c == case));
    let out = Out(Mutex::new(Vec::new()));
    eprintln!("perf_ops ({}), {iters} iterations, median", compat::VERSION);
    if run("journal") {
        bench_journal(&out, 2_000, iters);
    }
    if run("move") {
        let n: usize = std::env::var("FAZI_BENCH_MOVE_N").ok().and_then(|s| s.parse().ok()).unwrap_or(10_000);
        let move_iters = std::env::var("FAZI_BENCH_MOVE_ITERS").ok().and_then(|s| s.parse().ok()).unwrap_or(iters);
        bench_engine_move(&out, n, move_iters);
    }
    if run("names") {
        bench_names(&out, iters);
    }
    if run("refresh") {
        bench_fuzzy_refresh(&out, 10);
    }
    if run("mdfind") {
        bench_mdfind(&out, iters.max(5));
    }
    if run("scan") {
        bench_fuzzy_scan(&out, iters);
    }
    if run("verify") {
        bench_verify_tree(&out, iters);
    }
    if run("checksum") {
        bench_checksum(&out, iters);
    }
    if run("trash") {
        bench_empty_trash(&out);
    }
    if run("compress") {
        bench_compress_cross_volume(&out, iters);
    }
    let body = format!("{{\"version\":{:?},\"results\":[{}]}}\n", compat::VERSION, out.0.lock().unwrap().join(","));
    if let Some(dir) = Path::new(&out_path).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&out_path, body).unwrap();
    eprintln!("wrote {out_path}");
}
