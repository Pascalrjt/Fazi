//! AppKit main-thread discipline: every objc2/AppKit call that requires the
//! main thread is marshaled through here. Getting this wrong = random crashes.

use tauri::{AppHandle, Runtime};

/// Run `f` on the main thread and wait for its result.
/// Executes inline when already on the main thread (never deadlocks).
pub fn on_main<R: Runtime, T, F>(app: &AppHandle<R>, f: F) -> T
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    if objc2::MainThreadMarker::new().is_some() {
        return f();
    }
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let _ = app.run_on_main_thread(move || {
        let _ = tx.send(f());
    });
    rx.recv().expect("main thread closure did not run")
}
