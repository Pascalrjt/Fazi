//! Walk/query contention benchmark for the ⌘P fuzzy index (plan Verification
//! A: walk throughput and concurrent scan latency per walker pool size).
//!
//! Usage:
//!   FAZI_WALK_THREADS=4 cargo run --release --example fuzzy_bench -- <root>
//!
//! Builds an uncapped index of <root> (default: $HOME) with the default
//! excludes while a "keystroke" thread runs a live-style query every 250 ms,
//! reporting each scan's latency — the number that beachballed when the walk
//! starved the shared rayon pool. Prints walk duration, entries/s, query
//! latency min/p50/max, and peak RSS.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use fazi_lib::search::fuzzy::{
    build_index, config_hash, run_query, Excludes, FuzzyFilters, FuzzyIndex,
};

fn peak_rss_mb() -> f64 {
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) };
    ru.ru_maxrss as f64 / (1024.0 * 1024.0) // macOS reports bytes
}

fn main() {
    let root = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .expect("no root given and $HOME unset");
    let excludes = vec![
        ".git".to_string(),
        "node_modules".to_string(),
        "Library/Caches".to_string(),
        ".Trash".to_string(),
    ];
    let cap = u64::MAX; // production semantics: uncapped
    let threads = std::env::var("FAZI_WALK_THREADS").unwrap_or_else(|_| "4 (default)".into());
    eprintln!("indexing {} uncapped, walk threads = {}", root.display(), threads);

    let index = FuzzyIndex::new(root, config_hash(&excludes, cap), 0);
    let walker = {
        let index = index.clone();
        let excludes = Excludes::parse(&excludes);
        std::thread::spawn(move || {
            let t0 = Instant::now();
            build_index(index, excludes, cap, 0);
            t0.elapsed()
        })
    };

    // The "keystroke" load: a fresh scan every 250 ms against the growing
    // snapshot, mimicking the overlay's live query pressure.
    let mut latencies_ms: Vec<f64> = Vec::new();
    let patterns = ["main", "readme", "cargo toml", "notes", "photo"];
    let mut i = 0usize;
    while index.indexing.load(Ordering::SeqCst) {
        let t0 = Instant::now();
        let outcome = run_query(
            &index,
            patterns[i % patterns.len()],
            100,
            &FuzzyFilters::default(),
            &AtomicBool::new(false),
            index.generation.load(Ordering::SeqCst),
        );
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        latencies_ms.push(ms);
        let indexed = index.indexed.load(Ordering::SeqCst);
        eprintln!(
            "  scan #{i:>3} '{}' over {:>9} entries: {:>8.1} ms ({} hits)",
            patterns[i % patterns.len()],
            indexed,
            ms,
            outcome.map(|o| o.hits.len()).unwrap_or(0),
        );
        i += 1;
        std::thread::sleep(Duration::from_millis(250));
    }
    let walk_time = walker.join().expect("walker thread panicked");

    // One warm-index scan for the post-walk baseline.
    let t0 = Instant::now();
    let _ = run_query(
        &index,
        "main",
        100,
        &FuzzyFilters::default(),
        &AtomicBool::new(false),
        index.generation.load(Ordering::SeqCst),
    );
    let warm_ms = t0.elapsed().as_secs_f64() * 1000.0;

    latencies_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let total = index.indexed.load(Ordering::SeqCst);
    let arc = Arc::strong_count(&index); // keep index alive to the end
    println!("--------------------------------------------------------------");
    println!("entries indexed     : {total} (arc refs {arc})");
    println!(
        "walk                : {:.2}s ({:.0} entries/s)",
        walk_time.as_secs_f64(),
        total as f64 / walk_time.as_secs_f64().max(1e-9),
    );
    if !latencies_ms.is_empty() {
        println!(
            "mid-walk scan ms    : min {:.1} / p50 {:.1} / max {:.1} ({} scans)",
            latencies_ms.first().unwrap(),
            latencies_ms[latencies_ms.len() / 2],
            latencies_ms.last().unwrap(),
            latencies_ms.len(),
        );
    }
    println!("warm scan ms        : {warm_ms:.1}");
    println!("peak RSS            : {:.0} MB", peak_rss_mb());
}
