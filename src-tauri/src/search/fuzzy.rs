//! Concurrent fuzzy path index for the ⌘P finder (and M4's walker fallback).
//!
//! Design (see plan): append-only completed blocks — the walk thread fills
//! 4096-entry blocks locally and appends each under a brief write lock;
//! queries clone the block list under a read lock (cheap Arc bumps) and scan
//! lock-free on that snapshot. A `live` query stored in `active` is re-run by
//! the walk thread every ~150 ms against the grown snapshot, so the overlay
//! refines while indexing. The index is a snapshot of the walk moment —
//! watchers are non-recursive, so external deep changes are NOT caught; the
//! UI shows the index age and offers an explicit Rebuild.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
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
/// How often the walk thread re-runs the live query.
const LIVE_REFINE_INTERVAL: Duration = Duration::from_millis(150);
/// Max stats spent on date/size filters per query (overflow → capped).
const STAT_BUDGET: usize = 50_000;
pub const DEFAULT_MAX_ENTRIES: u64 = 2_000_000;
pub const MAX_TOP_K: usize = 10_000;

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

pub struct ActiveQuery {
    pub query_id: String,
    pub pattern: String,
    pub max_results: usize,
    pub filters: FuzzyFilters,
    pub cancel: Arc<AtomicBool>,
    pub send: SendFn,
    pub icon_token: IconTokenFn,
}

pub struct FuzzyIndex {
    pub root: PathBuf,
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
    /// The ⌘P overlay's live query, re-run by the walk thread while indexing.
    /// One-shot (live: false) queries never occupy this slot.
    active: Mutex<Option<ActiveQuery>>,
    /// Live queryId icon-token owner scopes — revoked wholesale on drop/evict.
    pub owners: Mutex<Vec<String>>,
}

impl FuzzyIndex {
    pub fn new(root: PathBuf, config_hash: u64, now_ms: u64) -> Arc<Self> {
        Arc::new(FuzzyIndex {
            root,
            blocks: RwLock::new(Vec::new()),
            generation: AtomicU64::new(0),
            indexing: AtomicBool::new(true),
            indexed: AtomicU64::new(0),
            capped: AtomicBool::new(false),
            stale: AtomicBool::new(false),
            config_hash,
            built_at_ms: AtomicU64::new(now_ms),
            active: Mutex::new(None),
            owners: Mutex::new(Vec::new()),
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

    pub fn set_active(&self, q: Option<ActiveQuery>) {
        *self.active.lock().unwrap() = q;
    }

    /// Clear the active slot iff it belongs to `query_id` (cancel path).
    pub fn clear_active_if(&self, query_id: &str) {
        let mut slot = self.active.lock().unwrap();
        if slot.as_ref().is_some_and(|q| q.query_id == query_id) {
            *slot = None;
        }
    }

    pub fn record_owner(&self, query_id: &str) {
        let mut owners = self.owners.lock().unwrap();
        if !owners.iter().any(|o| o == query_id) {
            owners.push(query_id.to_string());
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
/// it. Re-runs the live query every ~150 ms and once more (plus Done) at the
/// end. Aborts when the index generation changes.
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

    let walk = jwalk::WalkDir::new(&root)
        .skip_hidden(false)
        .follow_links(false)
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
        if last_refine.elapsed() >= LIVE_REFINE_INTERVAL {
            last_refine = Instant::now();
            if !block.is_empty() {
                push_block(&index, &mut block);
            }
            refine_active(&index, generation, true);
        }
    }
    if !block.is_empty() {
        push_block(&index, &mut block);
    }

    if !aborted && index.generation.load(Ordering::SeqCst) == generation {
        index.indexing.store(false, Ordering::SeqCst);
        // Final refinement + Done for the live query, then clear the slot.
        refine_active(&index, generation, false);
        index.set_active(None);
    }
}

fn push_block(index: &FuzzyIndex, block: &mut Vec<IndexedPath>) {
    let filled: Block = std::mem::take(block).into_boxed_slice();
    let n = filled.len() as u64;
    index.blocks.write().unwrap().push(Arc::new(filled));
    index.indexed.fetch_add(n, Ordering::SeqCst);
    block.reserve(BLOCK_SIZE);
}

/// Re-run the stored live query against the current snapshot.
fn refine_active(index: &FuzzyIndex, generation: u64, still_indexing: bool) {
    let guard = index.active.lock().unwrap();
    let Some(q) = guard.as_ref() else { return };
    if q.cancel.load(Ordering::SeqCst) {
        return;
    }
    let outcome = run_query(index, &q.pattern, q.max_results, &q.filters, &q.cancel, generation);
    let Some(outcome) = outcome else { return };
    let items = build_items(index, &q.query_id, outcome.hits, &q.icon_token);
    (q.send)(FuzzyEvent::Results {
        query_id: q.query_id.clone(),
        items,
        indexed: index.indexed.load(Ordering::SeqCst),
        indexing: still_indexing,
    });
    if !still_indexing {
        (q.send)(FuzzyEvent::Done {
            query_id: q.query_id.clone(),
            capped: index.capped.load(Ordering::SeqCst) || outcome.filters_capped,
        });
    }
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

pub fn build_items(
    index: &FuzzyIndex,
    query_id: &str,
    hits: Vec<(u32, Arc<Block>, usize)>,
    icon_token: &IconTokenFn,
) -> Vec<FuzzyItem> {
    hits.into_iter()
        .map(|(score, block, i)| {
            let item = &block[i];
            let abs = index.root.join(&*item.rel);
            FuzzyItem {
                icon: icon_token(query_id, &abs),
                path: abs.to_string_lossy().into_owned(),
                name: item.name().to_string(),
                is_dir: item.is_dir,
                score,
            }
        })
        .collect()
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
        build_items(idx, "t", outcome.hits, &no_token())
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
        let items = build_items(&idx, "t", outcome.hits, &no_token());
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
        let items = build_items(&idx, "t", outcome.hits, &no_token());
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
        let files: Vec<_> = build_items(&idx, "t", outcome.hits, &no_token())
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
}
