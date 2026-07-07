//! Live directory watching commands.

use std::path::PathBuf;

use tauri::ipc::Channel;
use tauri::State;

use crate::core::watcher::{self, WatchEvent};
use crate::error::{Error, Result};
use crate::state::AppState;

#[tauri::command]
pub fn watch_dir(
    state: State<'_, AppState>,
    path: String,
    watch_id: String,
    channel: Channel<WatchEvent>,
) -> Result<()> {
    let debouncer = watcher::watch(PathBuf::from(&path), move |e| {
        let _ = channel.send(e);
    })
    .map_err(|e| Error::msg(format!("watch failed: {e}")))?;
    state.watchers.insert(watch_id, debouncer);
    Ok(())
}

#[tauri::command]
pub fn unwatch(state: State<'_, AppState>, watch_id: String) {
    state.watchers.remove(&watch_id);
}
