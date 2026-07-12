//! Fuzzy-finder commands: warm/query/cancel/drop over the concurrent index.
//!
//! Session state: at most 2 warm roots (LRU); per-query cancel flags in
//! `AppState.fuzzy_queries` (the listing-cancel pattern). Icon tokens are
//! owned by the INDEX GENERATION (`fuzzy-index:{instance}:{generation}`),
//! never by a queryId — cancelling one query must not 404 icons another live
//! view still shows. Dropping/evicting/rebuilding an index revokes every
//! owner scope recorded on it; the per-index token cache bounds growth and
//! revokes evicted tokens individually.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use dashmap::DashMap;
use tauri::ipc::Channel;
use tauri::State;

use crate::core::op_queue::{now_ms, IconTokenFn};
use crate::error::{Error, Result};
use crate::search::fuzzy::{
    build_index, config_hash, execute_query, trace_enabled, Excludes, FuzzyEvent, FuzzyFilters,
    FuzzyIndex, FuzzyIndexStatus, QuerySpec, RevokeTokenFn, SendFn,
};
use crate::search::persist;
use crate::state::{AppState, TokenTable};

const MAX_WARM_ROOTS: usize = 2;

fn revoke_index_owners(state: &AppState, index: &FuzzyIndex) {
    for owner in index.take_owners() {
        state.tokens.drop_owner(&owner);
    }
}

fn persist_completed(index: &FuzzyIndex, snapshot: &Path) {
    // `indexing` stays true when the walk aborted (generation bump) — never
    // persist a torn snapshot.
    if index.indexing.load(Ordering::SeqCst) {
        return;
    }
    if let Err(e) = persist::save(index, snapshot) {
        eprintln!("[fuzzy] persist failed for {}: {e}", index.root.display());
    }
    if let Some(dir) = snapshot.parent() {
        persist::prune(dir);
    }
}

/// Background same-config refresh: the OLD index keeps serving queries until
/// the replacement's walk completes, then the map entry is swapped (old
/// generation bumped + owners revoked, exactly like a drop). A one-file
/// rename must never cost ⌘P its results for a whole rewalk. The pending
/// guard dedupes concurrent refreshes per root; the swap is conditional on
/// the map still holding the index the refresh started from, so a config
/// change or drop mid-walk wins over the refresh.
#[allow(clippy::too_many_arguments)] // one-shot spawn helper, not an API
fn spawn_refresh(
    fuzzy: Arc<DashMap<PathBuf, Arc<FuzzyIndex>>>,
    pending: Arc<DashMap<PathBuf, u64>>,
    tokens: Arc<TokenTable>,
    old: Arc<FuzzyIndex>,
    root: PathBuf,
    excludes: Vec<String>,
    cap: u64,
    hash: u64,
    snapshot: PathBuf,
) {
    if pending.insert(root.clone(), hash).is_some() {
        return; // a refresh for this root is already walking
    }
    std::thread::spawn(move || {
        let fresh = FuzzyIndex::new(root.clone(), hash, now_ms());
        build_index(fresh.clone(), Excludes::parse(&excludes), cap, now_ms());
        if !fresh.indexing.load(Ordering::SeqCst) {
            let mut swapped = false;
            if let Some(mut entry) = fuzzy.get_mut(&root) {
                if Arc::ptr_eq(entry.value(), &old) {
                    if old.stale.load(Ordering::SeqCst) {
                        // An op landed under the root mid-walk — the fresh
                        // snapshot may already miss it; keep it re-warmable.
                        fresh.stale.store(true, Ordering::SeqCst);
                    }
                    *entry.value_mut() = fresh.clone();
                    swapped = true;
                }
            }
            if swapped {
                old.generation.fetch_add(1, Ordering::SeqCst);
                for owner in old.take_owners() {
                    tokens.drop_owner(&owner);
                }
                persist_completed(&fresh, &snapshot);
                if trace_enabled() {
                    eprintln!(
                        "[fuzzy] refreshed {} ({} entries) and swapped in",
                        root.display(),
                        fresh.indexed.load(Ordering::SeqCst),
                    );
                }
            }
        }
        pending.remove(&root);
    });
}

fn touch_lru(state: &AppState, root: &PathBuf) {
    let mut lru = state.fuzzy_lru.lock().unwrap();
    lru.retain(|p| p != root);
    lru.push(root.clone());
}

fn evict_over_cap(state: &AppState) {
    let mut lru = state.fuzzy_lru.lock().unwrap();
    while lru.len() > MAX_WARM_ROOTS {
        let evict = lru.remove(0);
        if let Some((_, old)) = state.fuzzy.remove(&evict) {
            old.generation.fetch_add(1, Ordering::SeqCst);
            revoke_index_owners(state, &old);
        }
    }
}

/// `maxEntries` semantics: 0 (or absent) = UNCAPPED — the default. The index
/// must serve the whole tree; silently omitting entries past an arbitrary cap
/// is only acceptable when the user explicitly configured one.
fn effective_cap(max_entries: Option<u64>) -> u64 {
    match max_entries {
        None | Some(0) => u64::MAX,
        Some(n) => n,
    }
}

/// Build (or reuse) the index for `root`. Returns a status snapshot
/// immediately; walking always continues on a background thread.
///
/// Same-config force/stale requests keep serving the existing (complete)
/// index while a refresh walks in the background and swaps in on completion.
/// A cold root first tries the persisted snapshot (~0.1 s load vs ~10-15 s
/// walk) and then converges the same way.
///
/// Async command: the snapshot fast path reads a few hundred MB from disk —
/// never on the AppKit main thread.
#[tauri::command(async)]
pub fn fuzzy_warm(
    state: State<'_, AppState>,
    root: String,
    excludes: Vec<String>,
    max_entries: Option<u64>,
    force: Option<bool>,
) -> Result<FuzzyIndexStatus> {
    let root = PathBuf::from(&root);
    if !root.is_dir() {
        return Err(Error::msg("not a directory"));
    }
    let cap = effective_cap(max_entries);
    let hash = config_hash(&excludes, cap);
    let snapshot = persist::snapshot_path(&state.fuzzy_cache_dir, &root, hash);

    if let Some(existing) = state.fuzzy.get(&root).map(|e| e.clone()) {
        if existing.config_hash == hash {
            if force == Some(true) || existing.stale.load(Ordering::Relaxed) {
                spawn_refresh(
                    state.fuzzy.clone(),
                    state.fuzzy_pending.clone(),
                    state.tokens.clone(),
                    existing.clone(),
                    root.clone(),
                    excludes,
                    cap,
                    hash,
                    snapshot,
                );
            }
            touch_lru(&state, &root);
            return Ok(existing.status());
        }
    }

    // Config changed or nothing in memory: replace the map entry now. A
    // valid persisted snapshot serves instantly and converges via refresh;
    // otherwise the fresh walk IS the visible index build.
    if let Some((_, old)) = state.fuzzy.remove(&root) {
        old.generation.fetch_add(1, Ordering::SeqCst); // aborts walk + queries
        revoke_index_owners(&state, &old);
    }
    let restored = persist::load(&snapshot, &root, hash);
    let index = restored
        .clone()
        .unwrap_or_else(|| FuzzyIndex::new(root.clone(), hash, now_ms()));
    state.fuzzy.insert(root.clone(), index.clone());
    touch_lru(&state, &root);
    evict_over_cap(&state);

    if restored.is_some() {
        if trace_enabled() {
            eprintln!(
                "[fuzzy] restored {} from snapshot ({} entries)",
                root.display(),
                index.indexed.load(Ordering::SeqCst),
            );
        }
        spawn_refresh(
            state.fuzzy.clone(),
            state.fuzzy_pending.clone(),
            state.tokens.clone(),
            index.clone(),
            root,
            excludes,
            cap,
            hash,
            snapshot,
        );
    } else {
        let idx = index.clone();
        std::thread::spawn(move || {
            build_index(idx.clone(), Excludes::parse(&excludes), cap, now_ms());
            persist_completed(&idx, &snapshot);
        });
    }
    Ok(index.status())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // signature mirrors the invoke wire contract
pub fn fuzzy_query(
    state: State<'_, AppState>,
    root: String,
    query: String,
    query_id: String,
    max_results: usize,
    live: bool,
    filters: Option<FuzzyFilters>,
    channel: Channel<FuzzyEvent>,
) -> Result<()> {
    let root = PathBuf::from(&root);
    let Some(index) = state.fuzzy.get(&root).map(|i| i.clone()) else {
        return Err(Error::msg("index not warmed for this root"));
    };
    // Mark the root most-recently-used.
    {
        let mut lru = state.fuzzy_lru.lock().unwrap();
        lru.retain(|p| p != &root);
        lru.push(root);
    }

    let cancel = Arc::new(AtomicBool::new(false));
    state.fuzzy_queries.insert(query_id.clone(), cancel.clone());
    // Assigned here (IPC thread) so install order == keystroke order.
    let seq = index.next_query_seq();

    let tokens = state.tokens.clone();
    let icon_token: IconTokenFn = Arc::new(move |owner, p| tokens.register(owner, p));
    let tokens = state.tokens.clone();
    let icon_revoke: RevokeTokenFn = Arc::new(move |owner, t| tokens.revoke(owner, t));
    let send_channel = channel.clone();
    let send: SendFn = Arc::new(move |e| {
        let _ = send_channel.send(e);
    });
    let spec = QuerySpec {
        query_id,
        seq,
        pattern: query,
        max_results,
        live,
        filters: filters.unwrap_or_default(),
    };

    std::thread::spawn(move || {
        execute_query(&index, spec, cancel, send, icon_token, icon_revoke);
    });
    Ok(())
}

/// Async: runs on Tauri's thread pool, not the AppKit main thread. Belt and
/// suspenders — the active-slot lock is only ever held for O(µs) now, but
/// the main thread must not take even that wait while the UI pumps events.
#[tauri::command(async)]
pub fn fuzzy_cancel(state: State<'_, AppState>, query_id: String) {
    let t0 = Instant::now();
    if let Some((_, flag)) = state.fuzzy_queries.remove(&query_id) {
        flag.store(true, Ordering::SeqCst);
    }
    for entry in state.fuzzy.iter() {
        entry.value().clear_active_if(&query_id);
    }
    // No token revocation: fuzzy icon tokens are index-generation-owned, and
    // revoking per query would 404 icons still visible in other live views.
    if trace_enabled() {
        eprintln!(
            "[fuzzy] cancel {} in {:.2}ms",
            query_id,
            t0.elapsed().as_secs_f64() * 1000.0
        );
    }
}

#[tauri::command]
pub fn fuzzy_drop(state: State<'_, AppState>, root: String) {
    let root = PathBuf::from(&root);
    state.fuzzy_lru.lock().unwrap().retain(|p| p != &root);
    if let Some((_, index)) = state.fuzzy.remove(&root) {
        index.generation.fetch_add(1, Ordering::SeqCst);
        revoke_index_owners(&state, &index);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fazi-warm-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn wait_idle(pending: &DashMap<PathBuf, u64>) {
        for _ in 0..500 {
            if pending.is_empty() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("refresh never completed");
    }

    #[test]
    fn refresh_swaps_in_completed_walk_and_retires_the_old_index() {
        let d = tmp("refresh-swap");
        fs::write(d.join("a.txt"), b"x").unwrap();
        fs::write(d.join("b.txt"), b"x").unwrap();
        let hash = config_hash(&[], u64::MAX);
        // A complete-but-empty index stands in for a stale one.
        let old = FuzzyIndex::restore(d.clone(), hash, vec![], false, 0);
        old.stale.store(true, Ordering::SeqCst);
        old.record_owner("fuzzy-index:test:0");
        let tokens = Arc::new(TokenTable::default());
        let tok = tokens.register("fuzzy-index:test:0", Path::new("/x"));

        let fuzzy: Arc<DashMap<PathBuf, Arc<FuzzyIndex>>> = Arc::new(DashMap::new());
        fuzzy.insert(d.clone(), old.clone());
        let pending: Arc<DashMap<PathBuf, u64>> = Arc::new(DashMap::new());
        let snapshot = d.join("snap.fzidx");

        spawn_refresh(
            fuzzy.clone(),
            pending.clone(),
            tokens.clone(),
            old.clone(),
            d.clone(),
            vec![],
            u64::MAX,
            hash,
            snapshot.clone(),
        );
        wait_idle(&pending);

        let now = fuzzy.get(&d).unwrap().clone();
        assert!(!Arc::ptr_eq(&now, &old), "map must hold the fresh index");
        assert!(now.indexed.load(Ordering::SeqCst) >= 2, "fresh walk saw the files");
        assert!(!now.indexing.load(Ordering::SeqCst));
        assert!(now.stale.load(Ordering::SeqCst), "old stale mark must carry over");
        assert_eq!(old.generation.load(Ordering::SeqCst), 1, "old scans must abort");
        assert!(tokens.resolve(&tok).is_none(), "old owners revoked at swap");
        assert!(snapshot.exists(), "completed refresh persists a snapshot");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn refresh_discards_when_the_map_entry_changed_mid_walk() {
        // A config change (or drop) replaced the entry while the refresh
        // walked: the refresh must not clobber the newer index.
        let d = tmp("refresh-discard");
        fs::write(d.join("a.txt"), b"x").unwrap();
        let hash = config_hash(&[], u64::MAX);
        let old = FuzzyIndex::restore(d.clone(), hash, vec![], false, 0);
        let winner = FuzzyIndex::restore(d.clone(), hash.wrapping_add(1), vec![], false, 0);
        let fuzzy: Arc<DashMap<PathBuf, Arc<FuzzyIndex>>> = Arc::new(DashMap::new());
        fuzzy.insert(d.clone(), winner.clone()); // `old` is no longer installed
        let pending: Arc<DashMap<PathBuf, u64>> = Arc::new(DashMap::new());
        let snapshot = d.join("snap.fzidx");

        spawn_refresh(
            fuzzy.clone(),
            pending.clone(),
            Arc::new(TokenTable::default()),
            old,
            d.clone(),
            vec![],
            u64::MAX,
            hash,
            snapshot.clone(),
        );
        wait_idle(&pending);

        assert!(
            Arc::ptr_eq(&fuzzy.get(&d).unwrap(), &winner),
            "refresh must not replace a newer index"
        );
        assert!(!snapshot.exists(), "discarded refresh must not persist");
        fs::remove_dir_all(&d).ok();
    }
}
