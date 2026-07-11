//! Global search commands (streamed mdfind).

use std::path::PathBuf;
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

use crate::error::Result;
use crate::search::mdfind::{self, SearchEvent, SearchFilters, MAX_RESULTS_CEILING};
use crate::state::AppState;

#[tauri::command]
#[allow(clippy::too_many_arguments)] // signature mirrors the invoke wire contract
pub fn search(
    state: State<'_, AppState>,
    search_id: String,
    query: String,
    scope: Option<String>,
    contents: bool,
    filters: Option<SearchFilters>,
    max_results: Option<u64>,
    channel: Channel<SearchEvent>,
) -> Result<()> {
    // Replace any previous search under this id.
    if let Some((_, old)) = state.searches.remove(&search_id) {
        mdfind::cancel(&old);
    }
    let tokens = state.tokens.clone();
    let owner = search_id.clone();
    let icon_token: Arc<dyn Fn(&std::path::Path) -> String + Send + Sync> =
        Arc::new(move |p| tokens.register(&owner, p));

    let handle = mdfind::spawn_search(
        query,
        filters.unwrap_or_default(),
        scope.map(PathBuf::from),
        contents,
        // Clamped server-side: the same 1..=10,000 ceiling every search mode
        // shares (fuzzy top-K uses the same bound).
        max_results.unwrap_or(MAX_RESULTS_CEILING).clamp(1, MAX_RESULTS_CEILING),
        icon_token,
        move |e| {
            let _ = channel.send(e);
        },
    )?;
    state.searches.insert(search_id, handle);
    Ok(())
}

#[tauri::command]
pub fn cancel_search(state: State<'_, AppState>, search_id: String) {
    if let Some((_, handle)) = state.searches.remove(&search_id) {
        mdfind::cancel(&handle);
    }
    state.tokens.drop_owner(&search_id);
}
