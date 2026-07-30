pub mod fuzzy;
pub mod listing;
pub mod macos;
pub mod menu;
pub mod ops;
pub mod search;
pub mod watch;

use crate::error::{Error, Result};

/// Run blocking filesystem work off the AppKit main thread. Tauri 2 runs
/// sync commands on the main thread, so any command doing real disk I/O is
/// an `async fn` wrapping its work here. (A `#[tauri::command(async)]` sync
/// body would pin a Tokio worker instead — that's not the same thing.)
pub(crate) async fn blocking<T: Send + 'static>(
    name: &'static str,
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| Error::msg(format!("{name} worker failed: {e}")))
}
