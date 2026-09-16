use crate::{
    core::downloads_cleanup::{Cleanup, Config, Preview, Snapshot},
    error::{Error, Result},
    state::AppState,
};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::State;
pub struct CleanupState(pub Arc<Mutex<Cleanup>>);
async fn with_cleanup<T: Send + 'static>(
    state: Arc<Mutex<Cleanup>>,
    f: impl FnOnce(&mut Cleanup) -> std::io::Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut c = state
            .lock()
            .map_err(|_| Error::msg("Cleanup state is unavailable"))?;
        f(&mut c).map_err(Error::from)
    })
    .await
    .map_err(|e| Error::msg(e.to_string()))?
}
#[tauri::command]
pub async fn downloads_cleanup_status(state: State<'_, CleanupState>) -> Result<Snapshot> {
    with_cleanup(state.0.clone(), |c| c.snapshot()).await
}
#[tauri::command]
pub async fn downloads_cleanup_preview(
    state: State<'_, CleanupState>,
    config: Config,
) -> Result<Preview> {
    with_cleanup(state.0.clone(), move |c| c.preview(config)).await
}
#[tauri::command]
pub async fn downloads_cleanup_apply(
    state: State<'_, CleanupState>,
    token: String,
) -> Result<Snapshot> {
    with_cleanup(state.0.clone(), move |c| c.apply(&token)).await
}
#[tauri::command]
pub async fn downloads_cleanup_disable(state: State<'_, CleanupState>) -> Result<Snapshot> {
    with_cleanup(state.0.clone(), |c| c.disable()).await
}
#[tauri::command]
pub async fn downloads_cleanup_item(
    state: State<'_, CleanupState>,
    path: PathBuf,
    identity: String,
    action: String,
    days: u32,
) -> Result<Snapshot> {
    with_cleanup(state.0.clone(), move |c| {
        c.item_action(&path, &identity, &action, days)
    })
    .await
}
#[tauri::command]
pub async fn downloads_cleanup_restore(
    state: State<'_, CleanupState>,
    app: State<'_, AppState>,
    id: String,
) -> Result<Snapshot> {
    let engine = app.engine.clone();
    with_cleanup(state.0.clone(), move |c| c.restore(&id, &engine)).await
}
