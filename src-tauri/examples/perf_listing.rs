//! Listing / watcher / token / icon hot-path benchmark on synthetic data.
//!
//! Usage:
//!   cargo run --release --example perf_listing -- [out.tsv]
//!   PERF_BASELINE=before.tsv cargo run --release --example perf_listing -- after.tsv out.json
//!
//! Builds (once) a 100k-entry and a 5k-entry directory under
//! /tmp/fazi-bench-data, then measures the paths the listing engine runs
//! headless (no AppKit: icon renders and NSWorkspace package checks are
//! counted through mocks). Each timing is the median of several runs.
//! Prints `name\tunit\tvalue\tnote` rows; with PERF_BASELINE set, merges the
//! baseline rows into {"area":"rust-listing","results":[...]} JSON.
//!
//! Everything version-specific lives in `mod api` so the same workload can
//! run against the pre-change code (whose `mod api` re-creates the old call
//! sequences from its public pieces).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

use fazi_lib::core::entry::Entry;
use fazi_lib::state::TokenTable;

const DATA: &str = "/tmp/fazi-bench-data";
const BIG: usize = 100_000;
const MID: usize = 5_000;

mod api {
    use super::*;
    use fazi_lib::commands::listing::{build_entry_unresolved, pass1_scan, resolve_packages_with};
    use fazi_lib::core::entry::{hydrate, pass1_entry, EntryKind};
    use fazi_lib::core::watcher::{map_events, WatchEvent};
    use fazi_lib::macos::icons::{cached_or_render, IconCache, IconFlights};
    use std::sync::atomic::AtomicBool;

    /// Pass 1 over `dir` (token minting + entry building), entries collected.
    pub fn pass1(dir: &str, owner: &str, tokens: &TokenTable) -> Vec<Entry> {
        let mut out = Vec::new();
        let rd = std::fs::read_dir(dir).unwrap();
        pass1_scan(rd, dir, owner, tokens, &AtomicBool::new(false), |chunk| {
            out.extend(chunk);
            true
        });
        out
    }

    /// Synchronous part of cancel_listing for `owner`'s tokens (the command
    /// thread; before = AppKit main thread).
    pub fn cancel_sync(tokens: &Arc<TokenTable>, owner: &str) {
        if let Some(scope) = tokens.detach_owner(owner) {
            let t = tokens.clone();
            std::thread::spawn(move || t.release(scope)).join().unwrap();
        }
    }

    /// Synchronous part of cancel_listing; returns the deferred remainder.
    pub fn cancel_sync_only<'a>(
        tokens: &'a TokenTable,
        owner: &str,
    ) -> Option<Box<dyn FnOnce() + 'a>> {
        let scope = tokens.detach_owner(owner)?;
        Some(Box::new(move || tokens.release(scope)))
    }

    /// Pass 2 over retained pass-1 entries: hydrate + build the Hydrate
    /// batches that get sent. Returns entries "sent".
    pub fn pass2(all: Vec<Entry>) -> usize {
        let mut sent = 0;
        let mut rest = all.into_iter();
        loop {
            let mut batch: Vec<Entry> = rest.by_ref().take(256).collect();
            if batch.is_empty() {
                break;
            }
            let needs: Vec<bool> = batch.iter_mut().map(hydrate).collect();
            std::hint::black_box(&needs);
            sent += std::hint::black_box(batch).len();
        }
        sent
    }

    pub fn watch_batch(root: &Path, paths: &[PathBuf]) -> Option<WatchEvent> {
        map_events(root, paths.iter())
    }

    /// One watcher upsert (stat_paths per path).
    pub fn upsert(tokens: &TokenTable, p: &Path, owner: &str) -> Option<String> {
        let meta = p.symlink_metadata().ok()?;
        build_entry_unresolved(tokens, p, &meta, owner).map(|(e, _)| e.icon)
    }

    /// `requests` concurrent icon requests over `keys` distinct cache keys;
    /// returns how many renders ran.
    pub fn icon_misses(requests: usize, keys: usize, render_ms: u64) -> usize {
        let cache: Arc<IconCache> = Arc::new(IconCache::new());
        let flights: Arc<IconFlights> = Arc::new(IconFlights::default());
        let renders = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(requests));
        let hs: Vec<_> = (0..requests)
            .map(|i| {
                let (cache, flights, renders, barrier) =
                    (cache.clone(), flights.clone(), renders.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    let key = (format!("ext:{}", i % keys), 32u32);
                    cached_or_render(&cache, &flights, key, || {
                        renders.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(render_ms));
                        Some(vec![0u8; 4096])
                    })
                })
            })
            .collect();
        for h in hs {
            h.join().unwrap();
        }
        renders.load(Ordering::SeqCst)
    }

    /// Main-thread package questions (paths asked, trips) for `dirs`.
    pub fn package_queries(dirs: &[PathBuf]) -> (usize, usize) {
        let mut entries: Vec<Entry> = dirs
            .iter()
            .map(|p| {
                pass1_entry(
                    0,
                    p.parent().unwrap(),
                    &p.file_name().unwrap().to_string_lossy(),
                    EntryKind::Unknown,
                    String::new(),
                )
            })
            .collect();
        let needs: Vec<bool> = entries.iter_mut().map(hydrate).collect();
        let (mut asked, mut trips) = (0, 0);
        resolve_packages_with(
            entries.iter_mut().zip(&needs).filter(|(_, n)| **n).map(|(e, _)| e).collect(),
            |paths| {
                asked += paths.len();
                trips += 1;
                vec![false; paths.len()]
            },
        );
        (asked, trips)
    }
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn time_ms<T>(iters: usize, mut f: impl FnMut() -> T) -> f64 {
    let mut samples = Vec::with_capacity(iters);
    for _ in 0..iters {
        let t = Instant::now();
        std::hint::black_box(f());
        samples.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    median(samples)
}

fn ensure_data() -> (PathBuf, PathBuf) {
    let root = PathBuf::from(DATA);
    let big = root.join("big");
    let mid = root.join("mid");
    let marker = root.join(".complete");
    if marker.exists() {
        return (big, mid);
    }
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&big).unwrap();
    std::fs::create_dir_all(&mid).unwrap();
    let exts = ["txt", "rs", "png", "jpg", "pdf", "md", "json", "mov", "zip", "swift"];
    for i in 0..BIG {
        let p = big.join(format!("file-{i:06}.{}", exts[i % exts.len()]));
        if i % 100 == 99 {
            std::os::unix::fs::symlink(format!("file-{:06}.txt", i - 9), &p).unwrap();
        } else {
            std::fs::File::create(&p).unwrap();
        }
    }
    for i in 0..MID {
        if i % 10 == 0 {
            // Dirs, a fifth of them with an unknown extension (ambiguous).
            let name = if i % 50 == 0 { format!("dir-{i:05}.bundleish") } else { format!("dir-{i:05}") };
            std::fs::create_dir(mid.join(name)).unwrap();
        } else {
            std::fs::write(mid.join(format!("doc-{i:05}.{}", exts[i % exts.len()])), b"hello").unwrap();
        }
    }
    std::fs::write(&marker, b"").unwrap();
    (big, mid)
}

struct Row {
    name: String,
    unit: &'static str,
    value: f64,
    note: String,
}

fn main() {
    let (big, mid) = ensure_data();
    let big_s = big.to_string_lossy().into_owned();
    let mid_s = mid.to_string_lossy().into_owned();
    let mut rows: Vec<Row> = Vec::new();
    let mut push = |name: &str, unit: &'static str, value: f64, note: &str| {
        eprintln!("{name:<44} {value:>12.3} {unit}");
        rows.push(Row { name: name.into(), unit, value, note: note.into() });
    };

    // Warm the dentry cache.
    let _ = std::fs::read_dir(&big).unwrap().count();

    // 1. Pass 1: readdir + token minting + entry building, 100k entries.
    let pass1 = time_ms(7, || {
        let tokens = TokenTable::default();
        api::pass1(&big_s, "bench-listing", &tokens).len()
    });
    push(
        "pass1_100k_entries",
        "ms",
        pass1,
        "readdir + token mint + Entry build for 100k entries (1% symlinks), median of 7",
    );

    // 2. Token minting alone (100k distinct paths, one owner).
    let paths: Vec<PathBuf> = (0..BIG).map(|i| big.join(format!("p-{i}"))).collect();
    let mint = time_ms(7, || {
        let tokens = TokenTable::default();
        for p in &paths {
            std::hint::black_box(tokens.register("bench-owner", p));
        }
        tokens
    });
    push("token_mint_100k", "ms", mint, "TokenTable::register x100k distinct paths, median of 7");

    // 3. cancel_listing: synchronous cost on the command thread (before: the
    // AppKit main thread dropped every token inline).
    let cancel = {
        let mut samples = Vec::new();
        for _ in 0..7 {
            let tokens = TokenTable::default();
            for p in &paths {
                tokens.register("bench-owner", p);
            }
            let t = Instant::now();
            let rest = api::cancel_sync_only(&tokens, "bench-owner");
            samples.push(t.elapsed().as_secs_f64() * 1000.0);
            if let Some(release) = rest {
                release();
            }
            assert!(tokens.is_empty());
        }
        median(samples)
    };
    push(
        "cancel_listing_sync_100k_tokens",
        "ms",
        cancel,
        "time cancel_listing blocks its calling thread (was the main thread) for a 100k-token listing",
    );
    {
        let tokens = Arc::new(TokenTable::default());
        for p in &paths[..10] {
            tokens.register("o", p);
        }
        api::cancel_sync(&tokens, "o");
        assert!(tokens.is_empty());
    }

    // 4. Pass 2 over a 5k-entry listing (hydrate + batch handoff).
    let pass2 = {
        let tokens = TokenTable::default();
        let entries = api::pass1(&mid_s, "bench-mid", &tokens);
        time_ms(9, || api::pass2(entries.clone()))
    };
    push("pass2_hydrate_5k_entries", "ms", pass2, "hydrate 5k entries in 256-entry batches incl. batch handoff, median of 9");

    // 5. Watcher: one debounced batch (15 changed + 3 removed + 2 deep paths)
    // in the 100k-entry directory.
    let canon = std::fs::canonicalize(&big).unwrap();
    let mut batch: Vec<PathBuf> = (0..15).map(|i| canon.join(format!("file-{:06}.{}", i * 7, ["txt", "rs", "png", "jpg", "pdf", "md", "json", "mov", "zip", "swift"][(i * 7) % 10]))).collect();
    for i in 0..3 {
        batch.push(canon.join(format!("gone-{i}.tmp")));
    }
    batch.push(canon.join("sub/deep-1"));
    batch.push(canon.join("sub/deep-2"));
    let ev = api::watch_batch(&canon, &batch);
    if let Some(fazi_lib::core::watcher::WatchEvent::Batch { upserted, removed, .. }) = &ev {
        assert_eq!((upserted.len(), removed.len()), (15, 3), "{ev:?}");
    } else {
        panic!("unexpected {ev:?}");
    }
    let watch = time_ms(21, || api::watch_batch(&canon, &batch));
    push(
        "watcher_map_events_20_paths_in_100k_dir",
        "ms",
        watch,
        "map_events for one 20-path debounced batch in a 100k-entry dir, median of 21",
    );

    // 6. Watcher upserts: token-table growth and per-upsert cost.
    let owner = "bench-upserts";
    let tokens = TokenTable::default();
    let listed = api::pass1(&mid_s, owner, &tokens);
    let before = tokens.len();
    let targets: Vec<PathBuf> = listed.iter().take(100).map(|e| PathBuf::from(&e.path)).collect();
    let t = Instant::now();
    let n_upserts = 10_000;
    for i in 0..n_upserts {
        std::hint::black_box(api::upsert(&tokens, &targets[i % targets.len()], owner));
    }
    let per_upsert_us = t.elapsed().as_secs_f64() * 1e6 / n_upserts as f64;
    push(
        "token_table_growth_after_10k_upserts",
        "count",
        (tokens.len() - before) as f64,
        "new tokens after 10k watcher upserts of 100 already-listed files (same listing owner)",
    );
    push("watcher_upsert_cost", "ms", per_upsert_us / 1000.0, "per stat_paths entry (lstat + hydrate + token), mean of 10k");

    // 7. Concurrent icon misses: 64 simultaneous requests over 4 cache keys.
    let renders = median((0..5).map(|_| api::icon_misses(64, 4, 5) as f64).collect());
    push(
        "icon_renders_for_64_concurrent_misses_4_keys",
        "count",
        renders,
        "renders (main-thread trips) for 64 concurrent cold requests sharing 4 keys; mock 5 ms render",
    );

    // 8. Package checks: two 256-dir batches with one unknown extension.
    let pkg_root = PathBuf::from(DATA).join(format!("pkg-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&pkg_root);
    std::fs::create_dir_all(&pkg_root).unwrap();
    let ext = format!("benchext{}", std::process::id());
    let dirs: Vec<PathBuf> = (0..512)
        .map(|i| {
            let p = pkg_root.join(format!("d{i}.{ext}"));
            std::fs::create_dir(&p).unwrap();
            p
        })
        .collect();
    let (a1, t1) = api::package_queries(&dirs[..256]);
    let (a2, t2) = api::package_queries(&dirs[256..]);
    let _ = std::fs::remove_dir_all(&pkg_root);
    push(
        "package_checks_main_thread_paths_2x256_dirs",
        "count",
        (a1 + a2) as f64,
        "isFilePackageAtPath questions for 2 batches of 256 dirs sharing one unknown extension",
    );
    push(
        "package_checks_main_thread_trips_2x256_dirs",
        "count",
        (t1 + t2) as f64,
        "main-thread round trips for the same (stat_paths path was one trip per dir)",
    );

    // Output.
    let args: Vec<String> = std::env::args().skip(1).collect();
    let tsv: String = rows
        .iter()
        .map(|r| format!("{}\t{}\t{}\t{}\n", r.name, r.unit, r.value, r.note))
        .collect();
    if let Some(out) = args.first() {
        std::fs::write(out, &tsv).unwrap();
    }
    print!("{tsv}");
    if let (Ok(base), Some(json_out)) = (std::env::var("PERF_BASELINE"), args.get(1)) {
        let base = std::fs::read_to_string(base).unwrap();
        let before: std::collections::HashMap<String, f64> = base
            .lines()
            .filter_map(|l| {
                let mut it = l.split('\t');
                Some((it.next()?.to_string(), it.nth(1)?.parse().ok()?))
            })
            .collect();
        let results: Vec<serde_json::Value> = rows
            .iter()
            .filter_map(|r| {
                Some(serde_json::json!({
                    "name": r.name,
                    "unit": r.unit,
                    "before": (*before.get(&r.name)? * 1000.0).round() / 1000.0,
                    "after": (r.value * 1000.0).round() / 1000.0,
                    "lowerIsBetter": true,
                    "note": r.note,
                }))
            })
            .collect();
        let doc = serde_json::json!({ "area": "rust-listing", "results": results });
        if let Some(dir) = Path::new(json_out).parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::write(json_out, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
        eprintln!("wrote {json_out}");
    }
}
