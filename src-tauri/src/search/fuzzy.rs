//! Concurrent fuzzy path index for the ⌘P finder (and M4's walker fallback).
//!
//! Design (see plan): append-only completed blocks — the walk thread fills
//! 4096-entry blocks locally and appends each under a brief write lock;
//! queries clone the block list under a read lock (cheap Arc bumps) and scan
//! lock-free on that snapshot. A `live` query stored in `active` is re-run by
//! the walk thread against the grown snapshot (on ≥20% growth or ≥500 ms), so
//! the overlay refines while indexing. The index is a snapshot of the walk
//! moment — watchers are non-recursive, so external deep changes are NOT
//! caught; the UI shows the index age and offers an explicit Rebuild.
//!
//! Concurrency invariants (the beachball fix — see the concurrency tests):
//! - the `active` mutex is held only for clone/compare/replace, never across
//!   a scan; `fuzzy_cancel` must always complete in O(µs);
//! - the walk runs on its own rayon pool so it cannot starve query scans;
//! - active-slot mutation is ownership-aware (query seq / exact id) — an old
//!   refinement or the end-of-walk cleanup can never clear a newer query;
//! - icon tokens are owned by the index generation and cached (bounded LRU)
//!   so refine ticks reuse identical icon:// URLs and cancellation never
//!   revokes a token another live view still shows.

use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, HashMap};
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::core::op_queue::IconTokenFn;

pub const BLOCK_SIZE: usize = 4096;
/// Query-cancel check granularity, in items.
const CANCEL_STRIDE: usize = 4096;
/// Live-refine pacing: re-run the live query once the index grew ≥20% since
/// the last refinement, or after this long at the latest — not on a fixed
/// short interval, which repeats O(N) scans against an ever-growing index.
const REFINE_MAX_INTERVAL: Duration = Duration::from_millis(500);
/// Minimum growth (numerator/denominator) that triggers a refinement early.
const REFINE_GROWTH_NUM: u64 = 6;
const REFINE_GROWTH_DEN: u64 = 5;
/// Dedicated walker pool size: the walk must never queue refine/query scans
/// behind its own tasks on the global rayon pool (the beachball's amplifier).
/// Candidates 1/2/4/8 — retune with the FAZI_FUZZY_TRACE walk-rate log.
const WALK_THREADS: usize = 4;

/// `FAZI_WALK_THREADS` overrides the walker pool size (benchmarking knob).
fn walk_threads() -> usize {
    static N: OnceLock<usize> = OnceLock::new();
    *N.get_or_init(|| {
        std::env::var("FAZI_WALK_THREADS")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|n| (1..=64).contains(n))
            .unwrap_or(WALK_THREADS)
    })
}
/// Cap on the per-index icon-token cache; eviction revokes exactly the
/// evicted token (never a whole owner scope).
const ICON_TOKEN_CACHE_CAP: usize = 20_000;
/// Max stats spent on date/size filters per query (overflow → capped).
const STAT_BUDGET: usize = 50_000;
pub const MAX_TOP_K: usize = 10_000;

/// `FAZI_FUZZY_TRACE=1` logs refine tick durations, walk throughput, and
/// cancel latency to stderr (Verification A instrumentation).
pub fn trace_enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("FAZI_FUZZY_TRACE").is_some())
}

// ---------------------------------------------------------------------------
// Wire types (lockstep with src/types/ipc.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum FuzzyEvent {
    #[serde(rename_all = "camelCase")]
    Results {
        query_id: String,
        items: Vec<FuzzyItem>,
        indexed: u64,
        indexing: bool,
    },
    #[serde(rename_all = "camelCase")]
    Done { query_id: String, capped: bool },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FuzzyItem {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub icon: String,
    pub score: u32,
}

/// Snapshot returned by fuzzy_warm.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FuzzyIndexStatus {
    pub indexed: u64,
    pub indexing: bool,
    pub capped: bool,
    pub built_at_ms: u64,
}

/// Predicate filters applied in Rust BEFORE top-K selection (M4's search
/// fallback) — client-side post-filtering would hide qualifying hits ranked
/// beyond the top K.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FuzzyFilters {
    /// "image" | "video" | "audio" | "doc" | "pdf" | "folder" | "archive"
    pub kind: Option<String>,
    pub date_from_ms: Option<i64>,
    pub date_to_ms: Option<i64>,
    pub size_min: Option<u64>,
    pub size_max: Option<u64>,
}

impl FuzzyFilters {
    fn needs_stat(&self) -> bool {
        self.date_from_ms.is_some()
            || self.date_to_ms.is_some()
            || self.size_min.is_some()
            || self.size_max.is_some()
    }

    fn is_empty(&self) -> bool {
        self.kind.is_none() && !self.needs_stat()
    }
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

pub struct IndexedPath {
    /// Root-relative path (what the pattern matches against).
    pub rel: Box<str>,
    /// Length of the final component in bytes (name = &rel[rel.len()-name_len..]).
    pub name_len: u16,
    pub is_dir: bool,
}

impl IndexedPath {
    pub fn name(&self) -> &str {
        &self.rel[self.rel.len() - self.name_len as usize..]
    }
}

type Block = Box<[IndexedPath]>;

/// The channel-send closure a query streams `FuzzyEvent`s through.
pub type SendFn = Arc<dyn Fn(FuzzyEvent) + Send + Sync>;

/// Revoke one token from an owner scope (the icon-token LRU eviction path).
pub type RevokeTokenFn = Arc<dyn Fn(&str, &str) + Send + Sync>;

#[derive(Clone)]
pub struct ActiveQuery {
    pub query_id: String,
    /// Monotonic install order (`FuzzyIndex::next_query_seq`) — an older
    /// query can never replace a newer one in the active slot.
    pub seq: u64,
    pub pattern: String,
    pub max_results: usize,
    pub filters: FuzzyFilters,
    pub cancel: Arc<AtomicBool>,
    /// Set once Done has been sent for this query — the final refinement and
    /// the installing query thread race to finish the stream; exactly one wins.
    pub done: Arc<AtomicBool>,
    pub send: SendFn,
    pub icon_token: IconTokenFn,
    pub icon_revoke: RevokeTokenFn,
}

/// Bounded rel-path → icon-token cache: repeat results keep identical tokens
/// (stable icon:// URLs, so the WebView HTTP cache absorbs refine ticks)
/// while the warm-index lifetime stays bounded — `max_results` bounds one
/// batch, not many distinct queries. Eviction hands back exactly the evicted
/// token for individual revocation.
struct TokenLru {
    cap: usize,
    by_rel: HashMap<Box<str>, (String, u64)>,
    by_tick: BTreeMap<u64, Box<str>>,
    tick: u64,
}

impl TokenLru {
    fn new(cap: usize) -> Self {
        TokenLru { cap: cap.max(1), by_rel: HashMap::new(), by_tick: BTreeMap::new(), tick: 0 }
    }

    fn len(&self) -> usize {
        self.by_rel.len()
    }

    /// Cached token for `rel`, minting on miss. The second value is a token
    /// evicted to hold the cap — the caller must revoke it.
    fn get_or_mint(&mut self, rel: &str, mint: impl FnOnce() -> String) -> (String, Option<String>) {
        self.tick += 1;
        if let Some((token, tick)) = self.by_rel.get_mut(rel) {
            let old = std::mem::replace(tick, self.tick);
            let key = self.by_tick.remove(&old).expect("lru maps in sync");
            self.by_tick.insert(self.tick, key);
            return (token.clone(), None);
        }
        let token = mint();
        self.by_rel.insert(rel.into(), (token.clone(), self.tick));
        self.by_tick.insert(self.tick, rel.into());
        let evicted = if self.by_rel.len() > self.cap {
            let (_, oldest) = self.by_tick.pop_first().expect("over cap implies nonempty");
            self.by_rel.remove(&oldest).map(|(t, _)| t)
        } else {
            None
        };
        (token, evicted)
    }
}

/// Uniquifies token-owner keys across rebuilds of the same root.
static INSTANCE_COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct FuzzyIndex {
    pub root: PathBuf,
    /// Unique per index instance — owner keys must never collide between an
    /// aborted old index and its replacement for the same root.
    instance_id: u64,
    blocks: RwLock<Vec<Arc<Block>>>,
    /// Bumped on rebuild/root-switch: aborts the walk and in-flight queries.
    pub generation: AtomicU64,
    pub indexing: AtomicBool,
    pub indexed: AtomicU64,
    /// Walk hit max_entries — surfaced as "index capped" in the footer.
    pub capped: AtomicBool,
    /// An engine op / direct command touched a path under this root since the
    /// build — `fuzzy_warm` rebuilds instead of reusing.
    pub stale: AtomicBool,
    pub config_hash: u64,
    pub built_at_ms: AtomicU64,
    /// Live-query install order; assigned on the IPC thread so it follows
    /// keystroke order.
    query_seq: AtomicU64,
    /// The ⌘P overlay's live query, re-run by the walk thread while indexing.
    /// One-shot (live: false) queries never occupy this slot. Held only for
    /// O(µs) clone/compare/replace — NEVER across a scan (the beachball fix).
    active: Mutex<Option<ActiveQuery>>,
    /// Icon-token owner scopes minted from this index (generation keys) —
    /// revoked wholesale on rebuild/drop/evict.
    pub owners: Mutex<Vec<String>>,
    /// Lazy stable icon tokens for results served from this index.
    icon_tokens: Mutex<TokenLru>,
}

impl FuzzyIndex {
    pub fn new(root: PathBuf, config_hash: u64, now_ms: u64) -> Arc<Self> {
        Arc::new(FuzzyIndex {
            root,
            instance_id: INSTANCE_COUNTER.fetch_add(1, Ordering::SeqCst),
            blocks: RwLock::new(Vec::new()),
            generation: AtomicU64::new(0),
            indexing: AtomicBool::new(true),
            indexed: AtomicU64::new(0),
            capped: AtomicBool::new(false),
            stale: AtomicBool::new(false),
            config_hash,
            built_at_ms: AtomicU64::new(now_ms),
            query_seq: AtomicU64::new(0),
            active: Mutex::new(None),
            owners: Mutex::new(Vec::new()),
            icon_tokens: Mutex::new(TokenLru::new(ICON_TOKEN_CACHE_CAP)),
        })
    }

    pub fn snapshot(&self) -> Vec<Arc<Block>> {
        self.blocks.read().unwrap().clone()
    }

    pub fn status(&self) -> FuzzyIndexStatus {
        FuzzyIndexStatus {
            indexed: self.indexed.load(Ordering::SeqCst),
            indexing: self.indexing.load(Ordering::SeqCst),
            capped: self.capped.load(Ordering::SeqCst),
            built_at_ms: self.built_at_ms.load(Ordering::SeqCst),
        }
    }

    pub fn next_query_seq(&self) -> u64 {
        self.query_seq.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Owner scope for icon tokens minted from this index's results. Never a
    /// queryId: cancelling one query must not 404 icons another live view
    /// still shows.
    pub fn token_owner(&self) -> String {
        format!(
            "fuzzy-index:{}:{}",
            self.instance_id,
            self.generation.load(Ordering::SeqCst)
        )
    }

    /// Install `q` unless it was already cancelled or a newer (or the same)
    /// query holds the slot. Returns whether it was installed.
    pub fn install_active(&self, q: ActiveQuery) -> bool {
        if q.cancel.load(Ordering::SeqCst) {
            return false;
        }
        let mut slot = self.active.lock().unwrap();
        if slot.as_ref().is_some_and(|cur| cur.seq >= q.seq) {
            return false;
        }
        *slot = Some(q);
        true
    }

    /// Clear the active slot iff it belongs to `query_id` (cancel path and
    /// end-of-index cleanup). Returns whether this call cleared it.
    pub fn clear_active_if(&self, query_id: &str) -> bool {
        let mut slot = self.active.lock().unwrap();
        if slot.as_ref().is_some_and(|q| q.query_id == query_id) {
            *slot = None;
            true
        } else {
            false
        }
    }

    #[cfg(test)]
    pub fn active_query_id(&self) -> Option<String> {
        self.active.lock().unwrap().as_ref().map(|q| q.query_id.clone())
    }

    #[cfg(test)]
    pub fn set_icon_cache_cap(&self, cap: usize) {
        *self.icon_tokens.lock().unwrap() = TokenLru::new(cap);
    }

    pub fn icon_cache_len(&self) -> usize {
        self.icon_tokens.lock().unwrap().len()
    }

    pub fn record_owner(&self, owner: &str) {
        let mut owners = self.owners.lock().unwrap();
        if !owners.iter().any(|o| o == owner) {
            owners.push(owner.to_string());
        }
    }

    pub fn take_owners(&self) -> Vec<String> {
        std::mem::take(&mut *self.owners.lock().unwrap())
    }
}

/// Mark every warm index whose root contains one of `touched` as stale —
/// `fuzzy_warm` rebuilds it instead of reusing (the engine's invalidation
/// hook after file operations mutate the tree).
pub fn mark_stale_under(fuzzy: &DashMap<PathBuf, Arc<FuzzyIndex>>, touched: &[PathBuf]) {
    for index in fuzzy.iter() {
        if touched.iter().any(|p| p.starts_with(index.key())) {
            index.stale.store(true, Ordering::Relaxed);
        }
    }
}

/// Covers everything that shapes index content — a warm with a different
/// hash drops and rebuilds.
pub fn config_hash(excludes: &[String], max_entries: u64) -> u64 {
    let mut h = DefaultHasher::new();
    for e in excludes {
        e.hash(&mut h);
    }
    max_entries.hash(&mut h);
    h.finish()
}

// ---------------------------------------------------------------------------
// Excludes
// ---------------------------------------------------------------------------

/// Exclude semantics (defined): an exclude containing '/' matches as a
/// root-relative path PREFIX (e.g. "Library/Caches"); a bare name matches as
/// a path COMPONENT at any depth (e.g. "node_modules", ".git"). Matching
/// happens in the jwalk read-dir hook so excluded subtrees are pruned.
pub struct Excludes {
    prefixes: Vec<String>,
    components: Vec<String>,
}

impl Excludes {
    pub fn parse(raw: &[String]) -> Excludes {
        let mut prefixes = Vec::new();
        let mut components = Vec::new();
        for e in raw {
            let e = e.trim().trim_matches('/');
            if e.is_empty() {
                continue;
            }
            if e.contains('/') {
                prefixes.push(e.to_string());
            } else {
                components.push(e.to_string());
            }
        }
        Excludes { prefixes, components }
    }

    /// `rel` is the candidate's root-relative path, `name` its final component.
    pub fn excluded(&self, rel: &str, name: &str) -> bool {
        if self.components.iter().any(|c| c == name) {
            return true;
        }
        self.prefixes.iter().any(|p| {
            rel == p || (rel.len() > p.len() && rel.starts_with(p.as_str()) && rel.as_bytes()[p.len()] == b'/')
        })
    }
}

// ---------------------------------------------------------------------------
// The walk (index build)
// ---------------------------------------------------------------------------

/// Walk `index.root` and fill the index. Runs on the caller's thread — spawn
/// it. Re-runs the live query adaptively (≥20% growth or ≥500 ms) and once
/// more (plus Done) at the end. Aborts when the index generation changes.
///
/// The walk runs on its own bounded rayon pool: on the global pool its tasks
/// starved refine/query scans for seconds, which the beachballed main thread
/// then waited on.
pub fn build_index(
    index: Arc<FuzzyIndex>,
    excludes: Excludes,
    max_entries: u64,
    now_ms: u64,
) {
    let generation = index.generation.load(Ordering::SeqCst);
    index.built_at_ms.store(now_ms, Ordering::SeqCst);
    let root = index.root.clone();
    let excludes = Arc::new(excludes);
    let root_for_hook = root.clone();
    let excludes_for_hook = excludes.clone();
    let walk_start = Instant::now();

    let walk = jwalk::WalkDir::new(&root)
        .skip_hidden(false)
        .follow_links(false)
        .parallelism(jwalk::Parallelism::RayonNewPool(walk_threads()))
        .process_read_dir(move |_depth, dir_path, _state, children| {
            // Prune excluded subtrees here, not post-hoc.
            let rel_dir = dir_path.strip_prefix(&root_for_hook).ok();
            children.retain(|entry| {
                let Ok(entry) = entry else { return true };
                let name = entry.file_name().to_string_lossy();
                let rel = match rel_dir {
                    Some(d) if !d.as_os_str().is_empty() => {
                        format!("{}/{}", d.to_string_lossy(), name)
                    }
                    _ => name.to_string(),
                };
                !excludes_for_hook.excluded(&rel, &name)
            });
        });

    let mut block: Vec<IndexedPath> = Vec::with_capacity(BLOCK_SIZE);
    let mut total: u64 = 0;
    let mut last_refine = Instant::now();
    let mut refined_at: u64 = 0;
    let mut aborted = false;

    for entry in walk {
        if index.generation.load(Ordering::SeqCst) != generation {
            aborted = true;
            break;
        }
        let Ok(entry) = entry else { continue };
        if entry.depth == 0 {
            continue; // the root itself is not a result
        }
        let path = entry.path();
        let Ok(rel) = path.strip_prefix(&root) else { continue };
        let rel = rel.to_string_lossy().into_owned();
        let name_len = entry.file_name().to_string_lossy().len().min(u16::MAX as usize) as u16;
        block.push(IndexedPath {
            rel: rel.into_boxed_str(),
            name_len,
            is_dir: entry.file_type().is_dir(),
        });
        total += 1;

        if block.len() >= BLOCK_SIZE {
            push_block(&index, &mut block);
        }
        if total >= max_entries {
            index.capped.store(true, Ordering::SeqCst);
            break;
        }
        let grown = total >= refined_at + BLOCK_SIZE as u64
            && total * REFINE_GROWTH_DEN >= refined_at * REFINE_GROWTH_NUM;
        if grown || last_refine.elapsed() >= REFINE_MAX_INTERVAL {
            last_refine = Instant::now();
            refined_at = total;
            if !block.is_empty() {
                push_block(&index, &mut block);
            }
            refine_active(&index, generation, true);
        }
    }
    if !block.is_empty() {
        push_block(&index, &mut block);
    }

    if trace_enabled() {
        let secs = walk_start.elapsed().as_secs_f64();
        eprintln!(
            "[fuzzy] walk {} entries in {:.2}s ({:.0}/s, threads={}, aborted={})",
            total,
            secs,
            total as f64 / secs.max(1e-9),
            walk_threads(),
            aborted,
        );
    }

    if !aborted && index.generation.load(Ordering::SeqCst) == generation {
        index.indexing.store(false, Ordering::SeqCst);
        // Final refinement + Done for the live query, then clear EXACTLY the
        // query that was refined — a newer query can finish its initial scan
        // and install itself concurrently, and must not be wiped.
        if let Some(refined) = refine_active(&index, generation, false) {
            index.clear_active_if(&refined);
        }
    }
}

fn push_block(index: &FuzzyIndex, block: &mut Vec<IndexedPath>) {
    let filled: Block = std::mem::take(block).into_boxed_slice();
    let n = filled.len() as u64;
    index.blocks.write().unwrap().push(Arc::new(filled));
    index.indexed.fetch_add(n, Ordering::SeqCst);
    block.reserve(BLOCK_SIZE);
}

/// Re-run the stored live query against the current snapshot. Returns the id
/// of the query it refined (for exact end-of-index cleanup).
///
/// The `active` lock is held only to clone the query out — never across the
/// scan. `fuzzy_cancel`'s `clear_active_if` runs on an app thread the UI may
/// wait on, so any lock hold here must stay O(µs). Because the slot can be
/// cancelled or replaced while the scan runs unlocked, the cancel flag is
/// re-checked before every externally visible step.
fn refine_active(index: &FuzzyIndex, generation: u64, still_indexing: bool) -> Option<String> {
    let q = {
        let guard = index.active.lock().unwrap();
        let q = guard.as_ref()?;
        if q.cancel.load(Ordering::SeqCst) {
            return None;
        }
        q.clone()
    };
    let started = Instant::now();
    let outcome = run_query(index, &q.pattern, q.max_results, &q.filters, &q.cancel, generation)?;
    if q.cancel.load(Ordering::SeqCst) {
        return None;
    }
    let items = build_items(index, outcome.hits, &q.icon_token, &q.icon_revoke);
    if q.cancel.load(Ordering::SeqCst) {
        return None;
    }
    if trace_enabled() {
        eprintln!(
            "[fuzzy] refine {} → {} items over {} entries in {:.1}ms",
            q.query_id,
            items.len(),
            index.indexed.load(Ordering::SeqCst),
            started.elapsed().as_secs_f64() * 1000.0,
        );
    }
    (q.send)(FuzzyEvent::Results {
        query_id: q.query_id.clone(),
        items,
        indexed: index.indexed.load(Ordering::SeqCst),
        indexing: still_indexing,
    });
    if !still_indexing && !q.cancel.load(Ordering::SeqCst) && !q.done.swap(true, Ordering::SeqCst) {
        (q.send)(FuzzyEvent::Done {
            query_id: q.query_id.clone(),
            capped: index.capped.load(Ordering::SeqCst) || outcome.filters_capped,
        });
    }
    Some(q.query_id)
}

// ---------------------------------------------------------------------------
// Query execution
// ---------------------------------------------------------------------------

pub struct QueryOutcome {
    /// (score, block_idx, item_idx) resolved into refs at build_items time.
    pub hits: Vec<(u32, Arc<Block>, usize)>,
    /// The date/size stat budget overflowed — results may be incomplete.
    pub filters_capped: bool,
}

/// Scan a snapshot of the index. Returns None when cancelled or the index
/// generation changed mid-scan (stale queryId must emit nothing).
pub fn run_query(
    index: &FuzzyIndex,
    pattern_str: &str,
    max_results: usize,
    filters: &FuzzyFilters,
    cancel: &AtomicBool,
    generation: u64,
) -> Option<QueryOutcome> {
    let blocks = index.snapshot();
    let k = max_results.clamp(1, MAX_TOP_K);
    let pattern = if pattern_str.trim().is_empty() {
        None
    } else {
        Some(Pattern::parse(pattern_str, CaseMatching::Smart, Normalization::Smart))
    };
    let stat_budget = AtomicUsize::new(STAT_BUDGET);
    let filters_capped = AtomicBool::new(false);
    let cancelled = AtomicBool::new(false);

    // Per-thread top-K, merged after — no shared state on the hot path.
    let per_block: Vec<Vec<(u32, Arc<Block>, usize)>> = blocks
        .par_iter()
        .map_init(
            || Matcher::new(Config::DEFAULT.match_paths()),
            |matcher, block| {
                let mut local: Vec<(u32, Arc<Block>, usize)> = Vec::new();
                if cancelled.load(Ordering::Relaxed) {
                    return local;
                }
                let mut buf = Vec::new();
                for (i, item) in block.iter().enumerate() {
                    if i % CANCEL_STRIDE == 0
                        && (cancel.load(Ordering::Relaxed)
                            || index.generation.load(Ordering::Relaxed) != generation)
                    {
                        cancelled.store(true, Ordering::Relaxed);
                        return Vec::new();
                    }
                    let score = match &pattern {
                        Some(p) => {
                            let hay = Utf32Str::new(&item.rel, &mut buf);
                            match p.score(hay, matcher) {
                                Some(s) => s,
                                None => continue,
                            }
                        }
                        // Empty query: rank shallow/short paths first.
                        None => u32::MAX - item.rel.len().min(65_535) as u32,
                    };
                    if !filter_matches(index, item, filters, &stat_budget, &filters_capped) {
                        continue;
                    }
                    local.push((score, block.clone(), i));
                }
                // Keep only this block's top K (tie-break: shorter path wins).
                sort_hits(&mut local);
                local.truncate(k);
                local
            },
        )
        .collect();

    if cancelled.load(Ordering::Relaxed)
        || cancel.load(Ordering::Relaxed)
        || index.generation.load(Ordering::Relaxed) != generation
    {
        return None;
    }

    let mut merged: Vec<(u32, Arc<Block>, usize)> = per_block.into_iter().flatten().collect();
    sort_hits(&mut merged);
    merged.truncate(k);
    Some(QueryOutcome {
        hits: merged,
        filters_capped: filters_capped.load(Ordering::SeqCst),
    })
}

fn sort_hits(hits: &mut [(u32, Arc<Block>, usize)]) {
    hits.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1[a.2].rel.len().cmp(&b.1[b.2].rel.len()))
            .then_with(|| a.1[a.2].rel.cmp(&b.1[b.2].rel))
    });
}

/// Resolve hits into wire items. Icon tokens are minted lazily through the
/// index's bounded token cache under the index-generation owner: unchanged
/// results keep identical tokens across refine ticks, cancelling a query
/// never revokes them, and LRU eviction revokes exactly the evicted token.
pub fn build_items(
    index: &FuzzyIndex,
    hits: Vec<(u32, Arc<Block>, usize)>,
    icon_token: &IconTokenFn,
    icon_revoke: &RevokeTokenFn,
) -> Vec<FuzzyItem> {
    if hits.is_empty() {
        return Vec::new();
    }
    let owner = index.token_owner();
    index.record_owner(&owner);
    hits.into_iter()
        .map(|(score, block, i)| {
            let item = &block[i];
            let abs = index.root.join(&*item.rel);
            let (token, evicted) = index
                .icon_tokens
                .lock()
                .unwrap()
                .get_or_mint(&item.rel, || icon_token(&owner, &abs));
            if let Some(old) = evicted {
                icon_revoke(&owner, &old);
            }
            FuzzyItem {
                icon: token,
                path: abs.to_string_lossy().into_owned(),
                name: item.name().to_string(),
                is_dir: item.is_dir,
                score,
            }
        })
        .collect()
}

/// One query's full lifecycle, run on its own thread by the `fuzzy_query`
/// command (factored out of the command for the concurrency tests).
pub struct QuerySpec {
    pub query_id: String,
    /// From `FuzzyIndex::next_query_seq`, assigned on the IPC thread so seq
    /// order matches keystroke order.
    pub seq: u64,
    pub pattern: String,
    pub max_results: usize,
    pub live: bool,
    pub filters: FuzzyFilters,
}

pub fn execute_query(
    index: &Arc<FuzzyIndex>,
    spec: QuerySpec,
    cancel: Arc<AtomicBool>,
    send: SendFn,
    icon_token: IconTokenFn,
    icon_revoke: RevokeTokenFn,
) {
    let generation = index.generation.load(Ordering::SeqCst);
    // One-shot queries (the search fallback) want COMPLETE results — wait
    // out the walk instead of scanning a partial snapshot. Live queries
    // scan immediately and refine via the active slot.
    if !spec.live {
        while index.indexing.load(Ordering::SeqCst) {
            if cancel.load(Ordering::SeqCst)
                || index.generation.load(Ordering::SeqCst) != generation
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    let indexing = index.indexing.load(Ordering::SeqCst);
    let Some(outcome) =
        run_query(index, &spec.pattern, spec.max_results, &spec.filters, &cancel, generation)
    else {
        return;
    };
    let items = build_items(index, outcome.hits, &icon_token, &icon_revoke);
    if cancel.load(Ordering::SeqCst) {
        return;
    }
    let done = Arc::new(AtomicBool::new(false));
    send(FuzzyEvent::Results {
        query_id: spec.query_id.clone(),
        items,
        indexed: index.indexed.load(Ordering::SeqCst),
        indexing,
    });
    if !spec.live || !indexing {
        if !done.swap(true, Ordering::SeqCst) {
            send(FuzzyEvent::Done {
                query_id: spec.query_id.clone(),
                capped: index.capped.load(Ordering::SeqCst) || outcome.filters_capped,
            });
        }
        return;
    }
    // Live query while the walk runs: occupy the active slot for refinement.
    // install_active is compare/replace — an older query whose scan finished
    // late can never displace a newer one.
    let installed = index.install_active(ActiveQuery {
        query_id: spec.query_id.clone(),
        seq: spec.seq,
        pattern: spec.pattern,
        max_results: spec.max_results,
        filters: spec.filters,
        cancel: cancel.clone(),
        done: done.clone(),
        send: send.clone(),
        icon_token,
        icon_revoke,
    });
    if !installed {
        return;
    }
    // Close the install/end-of-walk race: if indexing finished during the
    // initial scan or install, the final refinement may already have run and
    // missed this query — pull it back out and finish the stream here. The
    // `done` flag arbitrates when both sides race to send Done.
    if !index.indexing.load(Ordering::SeqCst)
        && index.clear_active_if(&spec.query_id)
        && !done.swap(true, Ordering::SeqCst)
    {
        send(FuzzyEvent::Done {
            query_id: spec.query_id,
            capped: index.capped.load(Ordering::SeqCst) || outcome.filters_capped,
        });
    }
}

// ---------------------------------------------------------------------------
// Filters (M4 fallback)
// ---------------------------------------------------------------------------

const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "svg", "bmp", "tiff", "tif", "ico",
    "avif", "raw", "cr2", "nef",
];
const VIDEO_EXTS: &[&str] = &["mp4", "mov", "m4v", "webm", "avi", "mkv", "flv", "wmv", "mpg", "mpeg"];
const AUDIO_EXTS: &[&str] = &["mp3", "m4a", "wav", "aac", "flac", "ogg", "aiff", "aif"];
const DOC_EXTS: &[&str] = &[
    "doc", "docx", "pages", "txt", "md", "rtf", "odt", "xls", "xlsx", "numbers", "csv", "ppt",
    "pptx", "key",
];
const ARCHIVE_EXTS: &[&str] = &["zip", "tar", "gz", "bz2", "xz", "7z", "rar", "tgz", "dmg", "iso"];

fn ext_of(name: &str) -> &str {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => ext,
        _ => "",
    }
}

fn kind_matches(kind: &str, item: &IndexedPath) -> bool {
    if kind == "folder" {
        return item.is_dir;
    }
    if item.is_dir {
        return false;
    }
    let ext = ext_of(item.name()).to_ascii_lowercase();
    match kind {
        "image" => IMAGE_EXTS.contains(&ext.as_str()),
        "video" => VIDEO_EXTS.contains(&ext.as_str()),
        "audio" => AUDIO_EXTS.contains(&ext.as_str()),
        "pdf" => ext == "pdf",
        "doc" => DOC_EXTS.contains(&ext.as_str()),
        "archive" => ARCHIVE_EXTS.contains(&ext.as_str()),
        _ => true,
    }
}

fn filter_matches(
    index: &FuzzyIndex,
    item: &IndexedPath,
    filters: &FuzzyFilters,
    stat_budget: &AtomicUsize,
    filters_capped: &AtomicBool,
) -> bool {
    if filters.is_empty() {
        return true;
    }
    if let Some(kind) = &filters.kind {
        if !kind_matches(kind, item) {
            return false;
        }
    }
    if !filters.needs_stat() {
        return true;
    }
    // date/size need a stat — budgeted; overflow excludes and reports capped.
    if stat_budget
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |b| b.checked_sub(1))
        .is_err()
    {
        filters_capped.store(true, Ordering::SeqCst);
        return false;
    }
    let Ok(meta) = index.root.join(&*item.rel).symlink_metadata() else {
        return false;
    };
    if filters.size_min.is_some() || filters.size_max.is_some() {
        let size = if meta.is_dir() { 0 } else { meta.len() };
        if filters.size_min.is_some_and(|m| size < m) {
            return false;
        }
        if filters.size_max.is_some_and(|m| size > m) {
            return false;
        }
    }
    if filters.date_from_ms.is_some() || filters.date_to_ms.is_some() {
        use std::os::unix::fs::MetadataExt;
        let mtime_ms = meta.mtime() * 1000;
        if filters.date_from_ms.is_some_and(|f| mtime_ms < f) {
            return false;
        }
        if filters.date_to_ms.is_some_and(|t| mtime_ms > t) {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fazi-fuzzy-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn no_token() -> IconTokenFn {
        Arc::new(|_, _| String::new())
    }

    fn no_revoke() -> RevokeTokenFn {
        Arc::new(|_, _| {})
    }

    fn active_query(id: &str, seq: u64, send: SendFn, icon_token: IconTokenFn) -> ActiveQuery {
        ActiveQuery {
            query_id: id.to_string(),
            seq,
            pattern: String::new(),
            max_results: 100,
            filters: FuzzyFilters::default(),
            cancel: Arc::new(AtomicBool::new(false)),
            done: Arc::new(AtomicBool::new(false)),
            send,
            icon_token,
            icon_revoke: no_revoke(),
        }
    }

    fn warm_sync(root: &Path, excludes: &[String], cap: u64) -> Arc<FuzzyIndex> {
        let idx = FuzzyIndex::new(root.to_path_buf(), config_hash(excludes, cap), 0);
        build_index(idx.clone(), Excludes::parse(excludes), cap, 0);
        idx
    }

    fn query_paths(idx: &FuzzyIndex, q: &str, k: usize) -> Vec<String> {
        let outcome = run_query(
            idx,
            q,
            k,
            &FuzzyFilters::default(),
            &AtomicBool::new(false),
            idx.generation.load(Ordering::SeqCst),
        )
        .expect("query not cancelled");
        build_items(idx, outcome.hits, &no_token(), &no_revoke())
            .into_iter()
            .map(|i| i.path)
            .collect()
    }

    fn make_tree(root: &Path) {
        fs::create_dir_all(root.join("src/components")).unwrap();
        fs::create_dir_all(root.join("node_modules/react")).unwrap();
        fs::create_dir_all(root.join("Library/Caches/junk")).unwrap();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(root.join("src/main.rs"), b"x").unwrap();
        fs::write(root.join("src/components/Button.tsx"), b"x").unwrap();
        fs::write(root.join("node_modules/react/index.js"), b"x").unwrap();
        fs::write(root.join("Library/Caches/junk/blob.bin"), b"x").unwrap();
        fs::write(root.join("docs/readme.md"), b"x").unwrap();
        fs::write(root.join("photo.png"), b"x").unwrap();
    }

    #[test]
    fn warm_and_query_ranks_matches() {
        let d = tmp("basic");
        make_tree(&d);
        let idx = warm_sync(&d, &[], 1_000_000);
        assert!(!idx.indexing.load(Ordering::SeqCst));

        let hits = query_paths(&idx, "button", 100);
        assert!(hits.iter().any(|p| p.ends_with("Button.tsx")), "{hits:?}");

        // top-K bound respected
        let all = query_paths(&idx, "", 3);
        assert_eq!(all.len(), 3);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn excludes_prune_components_and_prefixes() {
        let d = tmp("excludes");
        make_tree(&d);
        let idx = warm_sync(
            &d,
            &["node_modules".into(), "Library/Caches".into()],
            1_000_000,
        );
        let hits = query_paths(&idx, "", 10_000);
        assert!(!hits.iter().any(|p| p.contains("node_modules")), "{hits:?}");
        assert!(!hits.iter().any(|p| p.contains("Caches")), "{hits:?}");
        // "Library" itself survives (only the prefix subtree is pruned).
        assert!(hits.iter().any(|p| p.ends_with("Library")), "{hits:?}");
        assert!(hits.iter().any(|p| p.ends_with("readme.md")));
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn entry_cap_marks_capped() {
        let d = tmp("cap");
        make_tree(&d);
        let idx = warm_sync(&d, &[], 3);
        assert!(idx.capped.load(Ordering::SeqCst));
        assert!(idx.indexed.load(Ordering::SeqCst) <= 4);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn query_against_appending_index_sees_consistent_snapshot() {
        // Snapshot semantics: a query taken mid-append scans exactly the
        // blocks it snapshotted — concurrent appends never tear it.
        let d = tmp("snapshot");
        make_tree(&d);
        let idx = FuzzyIndex::new(d.clone(), 0, 0);
        // Manually append one block, snapshot, then append another.
        let items: Vec<IndexedPath> = vec![IndexedPath {
            rel: "src/main.rs".into(),
            name_len: 7,
            is_dir: false,
        }];
        idx.blocks.write().unwrap().push(Arc::new(items.into_boxed_slice()));
        idx.indexed.store(1, Ordering::SeqCst);
        let snap = idx.snapshot();
        let more: Vec<IndexedPath> = vec![IndexedPath {
            rel: "docs/readme.md".into(),
            name_len: 9,
            is_dir: false,
        }];
        idx.blocks.write().unwrap().push(Arc::new(more.into_boxed_slice()));
        assert_eq!(snap.len(), 1, "old snapshot untouched by the append");
        assert_eq!(idx.snapshot().len(), 2);

        // And a real query on the grown index sees both.
        let hits = query_paths(&idx, "", 10);
        assert_eq!(hits.len(), 2);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn cancellation_and_generation_abort() {
        let d = tmp("cancel");
        make_tree(&d);
        let idx = warm_sync(&d, &[], 1_000_000);

        // Pre-cancelled query emits nothing.
        let cancelled = AtomicBool::new(true);
        let gen = idx.generation.load(Ordering::SeqCst);
        assert!(run_query(&idx, "main", 10, &FuzzyFilters::default(), &cancelled, gen).is_none());

        // Stale generation (root switched / rebuilt) also aborts.
        idx.generation.fetch_add(1, Ordering::SeqCst);
        assert!(run_query(
            &idx,
            "main",
            10,
            &FuzzyFilters::default(),
            &AtomicBool::new(false),
            gen
        )
        .is_none());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn config_hash_changes_with_excludes_and_cap() {
        let a = config_hash(&["node_modules".into()], 100);
        let b = config_hash(&["node_modules".into()], 200);
        let c = config_hash(&[".git".into()], 100);
        let a2 = config_hash(&["node_modules".into()], 100);
        assert_eq!(a, a2);
        assert_ne!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn kind_and_stat_filters_apply_before_top_k() {
        let d = tmp("filters");
        make_tree(&d);
        let idx = warm_sync(&d, &[], 1_000_000);
        let gen = idx.generation.load(Ordering::SeqCst);

        let outcome = run_query(
            &idx,
            "",
            10_000,
            &FuzzyFilters { kind: Some("image".into()), ..Default::default() },
            &AtomicBool::new(false),
            gen,
        )
        .unwrap();
        let items = build_items(&idx, outcome.hits, &no_token(), &no_revoke());
        assert_eq!(items.len(), 1);
        assert!(items[0].path.ends_with("photo.png"));

        // folders only
        let outcome = run_query(
            &idx,
            "",
            10_000,
            &FuzzyFilters { kind: Some("folder".into()), ..Default::default() },
            &AtomicBool::new(false),
            gen,
        )
        .unwrap();
        let items = build_items(&idx, outcome.hits, &no_token(), &no_revoke());
        assert!(items.iter().all(|i| i.is_dir));

        // size filter: everything here is 1 byte, so min 10 → nothing
        let outcome = run_query(
            &idx,
            "",
            10_000,
            &FuzzyFilters { size_min: Some(10), ..Default::default() },
            &AtomicBool::new(false),
            gen,
        )
        .unwrap();
        let files: Vec<_> = build_items(&idx, outcome.hits, &no_token(), &no_revoke())
            .into_iter()
            .filter(|i| !i.is_dir)
            .collect();
        assert!(files.is_empty(), "{files:?}");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn excluded_matcher_table() {
        let ex = Excludes::parse(&[
            "node_modules".into(),
            "Library/Caches".into(),
            ".git".into(),
        ]);
        assert!(ex.excluded("node_modules", "node_modules"));
        assert!(ex.excluded("a/b/node_modules", "node_modules"));
        assert!(ex.excluded("Library/Caches", "Caches"));
        assert!(ex.excluded("Library/Caches/x", "x"));
        assert!(!ex.excluded("Library", "Library"));
        assert!(!ex.excluded("LibraryX/Caches", "Caches"), "prefix must stop at a component boundary");
        assert!(!ex.excluded("src/git", "git"));
        assert!(ex.excluded("a/.git", ".git"));
    }

    #[test]
    fn mark_stale_under_marks_only_containing_roots() {
        let fuzzy: DashMap<PathBuf, Arc<FuzzyIndex>> = DashMap::new();
        let a = PathBuf::from("/tmp/fuzzy-stale/a");
        let b = PathBuf::from("/tmp/fuzzy-stale/b");
        fuzzy.insert(a.clone(), FuzzyIndex::new(a.clone(), 0, 0));
        fuzzy.insert(b.clone(), FuzzyIndex::new(b.clone(), 0, 0));

        // A path under one root marks only that index.
        mark_stale_under(&fuzzy, &[a.join("sub/file.txt")]);
        assert!(fuzzy.get(&a).unwrap().stale.load(Ordering::Relaxed));
        assert!(!fuzzy.get(&b).unwrap().stale.load(Ordering::Relaxed));

        // An unrelated path marks none.
        let fuzzy2: DashMap<PathBuf, Arc<FuzzyIndex>> = DashMap::new();
        fuzzy2.insert(a.clone(), FuzzyIndex::new(a.clone(), 0, 0));
        mark_stale_under(&fuzzy2, &[PathBuf::from("/tmp/elsewhere/x")]);
        assert!(!fuzzy2.get(&a).unwrap().stale.load(Ordering::Relaxed));

        // The root itself counts as "under".
        mark_stale_under(&fuzzy2, std::slice::from_ref(&a));
        assert!(fuzzy2.get(&a).unwrap().stale.load(Ordering::Relaxed));
    }

    // -----------------------------------------------------------------------
    // Concurrency regressions (the beachball fix — plan Verification C)
    // -----------------------------------------------------------------------

    fn collect_events() -> (SendFn, Arc<Mutex<Vec<FuzzyEvent>>>) {
        let events: Arc<Mutex<Vec<FuzzyEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let send: SendFn = Arc::new(move |e| sink.lock().unwrap().push(e));
        (send, events)
    }

    fn done_count(events: &[FuzzyEvent]) -> usize {
        events.iter().filter(|e| matches!(e, FuzzyEvent::Done { .. })).count()
    }

    #[test]
    fn cancel_lock_touch_is_bounded_while_refinement_runs() {
        // The beachball regression: fuzzy_cancel's clear_active_if must
        // complete in bounded time while a refinement is mid-flight. The
        // refinement blocks inside its send — with the old guard-across-scan
        // code this deadlocks; with clone-out it must return immediately.
        let d = tmp("cancel-bounded");
        make_tree(&d);
        let idx = warm_sync(&d, &[], 1_000_000);
        let gen = idx.generation.load(Ordering::SeqCst);

        let entered = Arc::new(std::sync::Barrier::new(2));
        let release = Arc::new(std::sync::Barrier::new(2));
        let (entered2, release2) = (entered.clone(), release.clone());
        let send: SendFn = Arc::new(move |_| {
            entered2.wait();
            release2.wait();
        });
        assert!(idx.install_active(active_query("q1", 1, send, no_token())));

        let idx2 = idx.clone();
        let refine = std::thread::spawn(move || {
            refine_active(&idx2, gen, true);
        });
        entered.wait(); // the refinement is now mid-send, scan done, unlocked
        let t0 = Instant::now();
        idx.clear_active_if("q1");
        let waited = t0.elapsed();
        release.wait();
        refine.join().unwrap();
        assert!(
            waited < Duration::from_millis(100),
            "cancel blocked {waited:?} behind an in-flight refinement"
        );
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn cancelled_refinement_emits_nothing_and_tokens_stay_index_owned() {
        // Cancellation lands while the (unlocked) refinement is resolving
        // items: no event may follow, and any token already minted must be
        // owned by the index generation — never the query.
        let d = tmp("cancel-mid-refine");
        make_tree(&d);
        let idx = warm_sync(&d, &[], 1_000_000);
        let gen = idx.generation.load(Ordering::SeqCst);

        let (send, events) = collect_events();
        let mut q = active_query("q1", 1, send, no_token());
        let cancel = q.cancel.clone();
        let minted_owners: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let (owners2, cancel2) = (minted_owners.clone(), cancel.clone());
        q.icon_token = Arc::new(move |owner, _| {
            cancel2.store(true, Ordering::SeqCst); // cancel races build_items
            owners2.lock().unwrap().push(owner.to_string());
            String::new()
        });
        assert!(idx.install_active(q));

        assert!(refine_active(&idx, gen, false).is_none());
        assert!(events.lock().unwrap().is_empty(), "post-cancel events leaked");
        let owners = minted_owners.lock().unwrap();
        assert!(!owners.is_empty(), "test must exercise the minting path");
        assert!(
            owners.iter().all(|o| o == &idx.token_owner()),
            "tokens must be index-generation-owned, got {owners:?}"
        );
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn older_query_cannot_replace_or_clear_newer() {
        let d = tmp("seq-order");
        make_tree(&d);
        let idx = warm_sync(&d, &[], 1_000_000);
        let (send, _) = collect_events();

        assert!(idx.install_active(active_query("new", 2, send.clone(), no_token())));
        // A stale query finishing its scan late must not displace the slot…
        assert!(!idx.install_active(active_query("old", 1, send.clone(), no_token())));
        // …nor may equal-seq reinstall (idempotence against double-install).
        assert!(!idx.install_active(active_query("dup", 2, send, no_token())));
        // …and clearing by the old id must not touch the newer query.
        assert!(!idx.clear_active_if("old"));
        assert_eq!(idx.active_query_id().as_deref(), Some("new"));
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn final_index_cleanup_clears_only_the_query_it_refined() {
        let d = tmp("final-clear");
        make_tree(&d);
        let idx = warm_sync(&d, &[], 1_000_000);
        let gen = idx.generation.load(Ordering::SeqCst);
        let (send, events) = collect_events();

        assert!(idx.install_active(active_query("a", 1, send.clone(), no_token())));
        // build_index's tail: final refinement, then clear the refined query…
        let refined = refine_active(&idx, gen, false).expect("refined the live query");
        assert_eq!(refined, "a");
        assert_eq!(done_count(&events.lock().unwrap()), 1, "final refine sends Done");
        // …but a newer query installed in between must survive the cleanup.
        assert!(idx.install_active(active_query("b", 2, send, no_token())));
        assert!(!idx.clear_active_if(&refined));
        assert_eq!(idx.active_query_id().as_deref(), Some("b"));
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn query_crossing_index_completion_sends_done_and_leaves_no_stale_slot() {
        // The walk finishes while a live query's initial scan resolves items
        // (after it observed indexing == true). It must still terminate its
        // event stream with Done and must not occupy the active slot forever.
        let d = tmp("cross-completion");
        make_tree(&d);
        let idx = warm_sync(&d, &[], 1_000_000);
        idx.indexing.store(true, Ordering::SeqCst); // simulate mid-walk
        let (send, events) = collect_events();

        let idx_flip = idx.clone();
        let icon_token: IconTokenFn = Arc::new(move |_, _| {
            // Fires during build_items — after run_query, before install.
            idx_flip.indexing.store(false, Ordering::SeqCst);
            String::new()
        });
        execute_query(
            &idx,
            QuerySpec {
                query_id: "q1".into(),
                seq: idx.next_query_seq(),
                pattern: String::new(),
                max_results: 10,
                live: true,
                filters: FuzzyFilters::default(),
            },
            Arc::new(AtomicBool::new(false)),
            send,
            icon_token,
            no_revoke(),
        );

        let events = events.lock().unwrap();
        assert!(
            events.iter().any(|e| matches!(e, FuzzyEvent::Results { .. })),
            "initial results missing"
        );
        assert_eq!(done_count(&events), 1, "exactly one Done, got {events:?}");
        assert_eq!(idx.active_query_id(), None, "stale active slot left behind");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn rebuild_revokes_index_generation_tokens() {
        use crate::state::TokenTable;
        let d = tmp("owner-revoke");
        make_tree(&d);
        let idx = warm_sync(&d, &[], 1_000_000);
        let gen = idx.generation.load(Ordering::SeqCst);

        let table = Arc::new(TokenTable::default());
        let t2 = table.clone();
        let icon_token: IconTokenFn = Arc::new(move |owner, p| t2.register(owner, p));
        let outcome = run_query(
            &idx,
            "",
            100,
            &FuzzyFilters::default(),
            &AtomicBool::new(false),
            gen,
        )
        .unwrap();
        let items = build_items(&idx, outcome.hits, &icon_token, &no_revoke());
        assert!(!items.is_empty());
        assert!(items.iter().all(|i| table.resolve(&i.icon).is_some()));

        // What fuzzy_warm/fuzzy_drop do when the index is replaced/dropped:
        for owner in idx.take_owners() {
            table.drop_owner(&owner);
        }
        assert!(items.iter().all(|i| table.resolve(&i.icon).is_none()));
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn unchanged_results_keep_identical_icon_tokens_across_refines() {
        let d = tmp("stable-tokens");
        make_tree(&d);
        let idx = warm_sync(&d, &[], 1_000_000);
        let gen = idx.generation.load(Ordering::SeqCst);

        let mints = Arc::new(AtomicUsize::new(0));
        let m2 = mints.clone();
        let icon_token: IconTokenFn = Arc::new(move |_, p| {
            m2.fetch_add(1, Ordering::SeqCst);
            format!("tok-{}", p.display())
        });
        let run = || {
            let outcome = run_query(
                &idx,
                "",
                100,
                &FuzzyFilters::default(),
                &AtomicBool::new(false),
                gen,
            )
            .unwrap();
            build_items(&idx, outcome.hits, &icon_token, &no_revoke())
        };
        let first = run();
        let minted_once = mints.load(Ordering::SeqCst);
        let second = run();
        assert_eq!(
            first.iter().map(|i| (&i.path, &i.icon)).collect::<Vec<_>>(),
            second.iter().map(|i| (&i.path, &i.icon)).collect::<Vec<_>>(),
            "same results must keep identical icon URLs across refine ticks"
        );
        assert_eq!(
            mints.load(Ordering::SeqCst),
            minted_once,
            "second tick must be served entirely from the token cache"
        );
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn token_cache_is_bounded_and_evictions_revoke_individually() {
        use crate::state::TokenTable;
        let table = TokenTable::default();
        let mut lru = TokenLru::new(2);
        let owner = "fuzzy-index:test:0";

        let mut tokens = Vec::new();
        for rel in ["a", "b", "c"] {
            let (token, evicted) =
                lru.get_or_mint(rel, || table.register(owner, Path::new(rel)));
            if let Some(old) = evicted {
                table.revoke(owner, &old);
            }
            tokens.push(token);
        }
        assert_eq!(lru.len(), 2, "cache exceeded its cap");
        // "a" was the LRU entry: its token is gone, the survivors still resolve.
        assert!(table.resolve(&tokens[0]).is_none(), "evicted token must be revoked");
        assert!(table.resolve(&tokens[1]).is_some());
        assert!(table.resolve(&tokens[2]).is_some());

        // Touching "b" makes "c" the eviction victim next.
        let (b_again, evicted) = lru.get_or_mint("b", || unreachable!("b is cached"));
        assert!(evicted.is_none());
        assert_eq!(b_again, tokens[1]);
        let (_, evicted) = lru.get_or_mint("d", || table.register(owner, Path::new("d")));
        assert_eq!(evicted.as_deref(), Some(tokens[2].as_str()), "LRU order must respect touches");
    }
}
