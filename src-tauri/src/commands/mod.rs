pub mod cleanup;
pub mod fuzzy;
pub mod listing;
pub mod macos;
pub mod menu;
pub mod ops;
pub mod search;
pub mod watch;

/// Run blocking command work on Tauri's blocking pool. Note
/// `#[tauri::command(async)]` on a *sync* fn only moves the body onto an
/// async worker (no spawn_blocking), so disk/statfs/unmount work there
/// stalls the shared tokio workers; async commands await this instead.
pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> crate::error::Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| crate::error::Error::msg(format!("worker failed: {e}")))
}
