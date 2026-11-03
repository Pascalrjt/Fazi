//! Live directory watching commands.
//!
//! Both commands are async and do their blocking work on the blocking pool:
//! `watch` canonicalizes the root (can stall on a dead mount) and starts an
//! FSEvents stream; dropping a debouncer joins its thread. As sync commands
//! they ran on the AppKit main thread.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::commands::blocking;
use crate::core::watcher::{self, WatchEvent};
use crate::error::{Error, Result};
use crate::state::AppState;

/// Watch ids unwatched before their `watch_dir` finished registering (the
/// two commands now race on the async pool). Ids are fresh per watch, so a
/// small bounded memory is enough.
static TOMBSTONES: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
const TOMBSTONE_CAP: usize = 256;

#[tauri::command]
pub async fn watch_dir(
    app: AppHandle,
    path: String,
    watch_id: String,
    channel: Channel<WatchEvent>,
) -> Result<()> {
    blocking(move || {
        let debouncer = watcher::watch(PathBuf::from(&path), move |e| {
            let _ = channel.send(e);
        })
        .map_err(|e| Error::msg(format!("watch failed: {e}")))?;
        // The tombstone lock orders this against `unwatch`'s remove-or-mark.
        let cancelled = {
            let mut t = TOMBSTONES.lock().unwrap_or_else(|e| e.into_inner());
            match t.iter().position(|x| *x == watch_id) {
                Some(i) => {
                    t.remove(i);
                    Some(debouncer)
                }
                None => {
                    app.state::<AppState>().watchers.insert(watch_id, debouncer);
                    None
                }
            }
        };
        drop(cancelled); // unwatched while we were starting
        Ok(())
    })
    .await?
}

#[tauri::command]
pub async fn unwatch(app: AppHandle, watch_id: String) -> Result<()> {
    blocking(move || {
        let removed = {
            let mut t = TOMBSTONES.lock().unwrap_or_else(|e| e.into_inner());
            let removed = app.state::<AppState>().watchers.remove(&watch_id);
            if removed.is_none() {
                if t.len() >= TOMBSTONE_CAP {
                    t.pop_front();
                }
                t.push_back(watch_id);
            }
            removed
        };
        // Dropping stops the stream and joins the debouncer thread.
        drop(removed);
    })
    .await
}
