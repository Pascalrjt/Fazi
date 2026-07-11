//! Fuzzy-finder commands: warm/query/cancel/drop over the concurrent index.
//!
//! Session state: at most 2 warm roots (LRU); per-query cancel flags in
//! `AppState.fuzzy_queries` (the listing-cancel pattern). Icon tokens are
//! owned by the INDEX GENERATION (`fuzzy-index:{instance}:{generation}`),
//! never by a queryId — cancelling one query must not 404 icons another live
//! view still shows. Dropping/evicting/rebuilding an index revokes every
//! owner scope recorded on it; the per-index token cache bounds growth and
//! revokes evicted tokens individually.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use tauri::ipc::Channel;
use tauri::State;

use crate::core::op_queue::{now_ms, IconTokenFn};
use crate::error::{Error, Result};
use crate::search::fuzzy::{
    build_index, config_hash, execute_query, trace_enabled, Excludes, FuzzyEvent, FuzzyFilters,
    FuzzyIndex, FuzzyIndexStatus, QuerySpec, RevokeTokenFn, SendFn,
};
use crate::state::AppState;

const MAX_WARM_ROOTS: usize = 2;

fn revoke_index_owners(state: &AppState, index: &FuzzyIndex) {
    for owner in index.take_owners() {
        state.tokens.drop_owner(&owner);
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
    let cap = effective_cap(max_entries);
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
