//! Global search commands (streamed mdfind).

use std::path::PathBuf;
use std::process::Child;
use std::sync::{Arc, Mutex};

use dashmap::DashMap;
use tauri::ipc::Channel;
use tauri::State;

use crate::error::Result;
use crate::search::mdfind::{self, SearchEvent, SearchFilters, MAX_RESULTS_CEILING};
use crate::state::{AppState, TokenTable};

/// Retire a search id: kill its mdfind child (if any) and revoke its icon
/// tokens. Shared by cancel and same-id replacement — dropping the tokens is
/// safe because the frontend clears hits synchronously and never reuses ids.
fn retire_search(
    searches: &DashMap<String, Arc<Mutex<Option<Child>>>>,
    tokens: &TokenTable,
    search_id: &str,
) {
    if let Some((_, handle)) = searches.remove(search_id) {
        mdfind::cancel(&handle);
    }
    tokens.drop_owner(search_id);
}

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
    retire_search(&state.searches, &state.tokens, &search_id);
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
    retire_search(&state.searches, &state.tokens, &search_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn retire_drops_the_ids_handle_and_icon_tokens() {
        // Same-id replacement: the old child is removed AND its icon tokens
        // are revoked — the tokens used to leak here.
        let searches: DashMap<String, Arc<Mutex<Option<Child>>>> = DashMap::new();
        let tokens = TokenTable::default();
        // An already-reaped slot (None) stands in for a real mdfind child.
        searches.insert("s1".into(), Arc::new(Mutex::new(None)));
        let tok = tokens.register("s1", Path::new("/tmp/hit.txt"));

        retire_search(&searches, &tokens, "s1");
        assert!(searches.get("s1").is_none(), "old handle removed");
        assert!(tokens.resolve(&tok).is_none(), "old id's icon tokens revoked");
    }

    #[test]
    fn retire_is_a_no_op_for_an_unknown_id() {
        let searches: DashMap<String, Arc<Mutex<Option<Child>>>> = DashMap::new();
        let tokens = TokenTable::default();
        let other = tokens.register("s2", Path::new("/tmp/other.txt"));
        retire_search(&searches, &tokens, "s1");
        assert!(tokens.resolve(&other).is_some(), "other owners untouched");
    }
}
