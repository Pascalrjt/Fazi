//! Fuzzy-finder commands: warm/query/cancel/drop over the concurrent index.
//!
//! Session state: at most 2 warm roots (LRU); per-query cancel flags in
//! `AppState.fuzzy_queries` (the listing-cancel pattern). Icon tokens are
//! owned by queryId — a superseded/cancelled query's owner scope is revoked,
//! and dropping/evicting an index revokes every owner recorded on it.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

use crate::core::op_queue::{now_ms, IconTokenFn};
use crate::error::{Error, Result};
use crate::search::fuzzy::{
    build_index, build_items, config_hash, run_query, ActiveQuery, Excludes, FuzzyEvent,
    FuzzyFilters, FuzzyIndex, FuzzyIndexStatus, SendFn, DEFAULT_MAX_ENTRIES,
};
use crate::state::AppState;

const MAX_WARM_ROOTS: usize = 2;

fn revoke_index_owners(state: &AppState, index: &FuzzyIndex) {
    for owner in index.take_owners() {
        state.fuzzy_queries.remove(&owner);
        state.tokens.drop_owner(&owner);
    }
}

/// Build (or reuse) the index for `root`. Returns the current status snapshot
/// immediately; indexing continues on a background thread.
#[tauri::command]
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
    let cap = max_entries.unwrap_or(DEFAULT_MAX_ENTRIES).max(1);
    let hash = config_hash(&excludes, cap);

    if force != Some(true) {
        if let Some(existing) = state.fuzzy.get(&root) {
            if existing.config_hash == hash && !existing.stale.load(Ordering::Relaxed) {
                return Ok(existing.status());
            }
        }
    }

    // Replace (or insert) the index for this root.
    if let Some((_, old)) = state.fuzzy.remove(&root) {
        old.generation.fetch_add(1, Ordering::SeqCst); // aborts walk + queries
        revoke_index_owners(&state, &old);
    }
    let index = FuzzyIndex::new(root.clone(), hash, now_ms());
    state.fuzzy.insert(root.clone(), index.clone());

    // LRU: cap warm roots at 2.
    {
        let mut lru = state.fuzzy_lru.lock().unwrap();
        lru.retain(|p| p != &root);
        lru.push(root.clone());
        while lru.len() > MAX_WARM_ROOTS {
            let evict = lru.remove(0);
            if let Some((_, old)) = state.fuzzy.remove(&evict) {
                old.generation.fetch_add(1, Ordering::SeqCst);
                revoke_index_owners(&state, &old);
            }
        }
    }

    let status = index.status();
    std::thread::spawn(move || {
        build_index(index, Excludes::parse(&excludes), cap, now_ms());
    });
    Ok(status)
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
    index.record_owner(&query_id);

    let tokens = state.tokens.clone();
    let icon_token: IconTokenFn = Arc::new(move |owner, p| tokens.register(owner, p));
    let filters = filters.unwrap_or_default();
    let send_channel = channel.clone();
    let send: SendFn = Arc::new(move |e| {
        let _ = send_channel.send(e);
    });

    std::thread::spawn(move || {
        let generation = index.generation.load(Ordering::SeqCst);
        // One-shot queries (the search fallback) want COMPLETE results — wait
        // out the walk instead of scanning a partial snapshot. Live queries
        // scan immediately and refine via the active slot.
        if !live {
            while index.indexing.load(Ordering::SeqCst) {
                if cancel.load(Ordering::SeqCst)
                    || index.generation.load(Ordering::SeqCst) != generation
                {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
        let indexing = index.indexing.load(Ordering::SeqCst);
        let outcome = run_query(&index, &query, max_results, &filters, &cancel, generation);
        if let Some(outcome) = outcome {
            let items = build_items(&index, &query_id, outcome.hits, &icon_token);
            send(FuzzyEvent::Results {
                query_id: query_id.clone(),
                items,
                indexed: index.indexed.load(Ordering::SeqCst),
                indexing,
            });
            if !indexing || !live {
                send(FuzzyEvent::Done {
                    query_id: query_id.clone(),
                    capped: index.capped.load(Ordering::SeqCst) || outcome.filters_capped,
                });
            }
        }
        // Live queries occupy the active slot for refinement while the walk
        // runs; one-shot queries (M4 fallback) never do — they must coexist
        // with an open ⌘P session without evicting its live query.
        if live && indexing && !cancel.load(Ordering::SeqCst) {
            index.set_active(Some(ActiveQuery {
                query_id,
                pattern: query,
                max_results,
                filters,
                cancel,
                send,
                icon_token,
            }));
        }
    });
    Ok(())
}

#[tauri::command]
pub fn fuzzy_cancel(state: State<'_, AppState>, query_id: String) {
    if let Some((_, flag)) = state.fuzzy_queries.remove(&query_id) {
        flag.store(true, Ordering::SeqCst);
    }
    for entry in state.fuzzy.iter() {
        entry.value().clear_active_if(&query_id);
    }
    state.tokens.drop_owner(&query_id);
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
