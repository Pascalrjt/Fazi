//! Global search commands (streamed mdfind).

use std::path::PathBuf;
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

use crate::error::Result;
use crate::search::mdfind::{self, SearchEvent};
use crate::state::AppState;

#[tauri::command]
pub fn search(
    state: State<'_, AppState>,
    search_id: String,
    query: String,
    scope: Option<String>,
    contents: bool,
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
        scope.map(PathBuf::from),
        contents,
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
