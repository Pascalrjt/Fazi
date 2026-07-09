//! Fazi — a keyboard-first macOS file manager.
//! Rust owns everything that touches disk or macOS APIs; the webview owns
//! presentation, selection, and input.

pub mod commands;
pub mod core;
pub mod error;
pub mod macos;
pub mod protocols;
pub mod search;
pub mod state;

use std::path::Path;
use std::sync::{Arc, Mutex};

use dashmap::DashMap;
use tauri::{Emitter, Manager};

use crate::core::journal::Journal;
use crate::core::op_queue::Engine;
use crate::core::undo::UndoStack;
use crate::macos::trash::SystemTrasher;
use crate::state::{AppState, TokenTable};

pub const VOLUMES_CHANGED: &str = "fazi://volumes-changed";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let cache_dir = app.path().app_cache_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            std::fs::create_dir_all(&cache_dir)?;

            // Durable journal + startup recovery (crash safety ≠ undo).
            let journal = Arc::new(Journal::new(data_dir.join("ops-journal"))?);
            let interrupted = journal.recover();

            let tokens = Arc::new(TokenTable::default());
            let engine_tokens = tokens.clone();
            let engine = Arc::new(Engine {
                trasher: Arc::new(SystemTrasher),
                journal,
                undo: Arc::new(Mutex::new(UndoStack::default())),
                ops: DashMap::new(),
                volume_locks: DashMap::new(),
                icon_token: Arc::new(move |owner: &str, path: &Path| {
                    engine_tokens.register(owner, path)
                }),
            });

            let thumb_cache_dir = cache_dir.join("thumbnails");
            std::fs::create_dir_all(&thumb_cache_dir)?;
            {
                let dir = thumb_cache_dir.clone();
                std::thread::spawn(move || macos::thumbnails::prune_cache(&dir));
            }

            app.manage(AppState {
                tokens,
                previews: DashMap::new(),
                listings: DashMap::new(),
                watchers: DashMap::new(),
                searches: DashMap::new(),
                engine,
                icon_cache: Arc::new(DashMap::new()),
                thumb_cache_dir,
                interrupted,
                pb_mark: Mutex::new(None),
            });

            // Volume mount/unmount: 2 s poll of the mounted-path set.
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let mut last = macos::volumes::volume_paths_snapshot();
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(2));
                        let now = macos::volumes::volume_paths_snapshot();
                        if now != last {
                            last = now;
                            let _ = handle.emit(VOLUMES_CHANGED, ());
                        }
                    }
                });
            }
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("icon", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || {
                responder.respond(protocols::handle_icon(&app, request));
            });
        })
        .register_asynchronous_uri_scheme_protocol("thumb", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || {
                responder.respond(protocols::handle_thumb(&app, request));
            });
        })
        .register_asynchronous_uri_scheme_protocol("preview", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || {
                responder.respond(protocols::handle_preview(&app, request));
            });
        })
        .invoke_handler(tauri::generate_handler![
            commands::listing::list_dir,
            commands::listing::cancel_listing,
            commands::listing::stat_path,
            commands::watch::watch_dir,
            commands::watch::unwatch,
            commands::ops::run_op,
            commands::ops::duplicate_paths,
            commands::ops::compress_paths,
            commands::ops::extract_paths,
            commands::ops::cancel_op,
            commands::ops::respond_conflict,
            commands::ops::trash_paths,
            commands::ops::delete_permanent,
            commands::ops::rename_path,
            commands::ops::new_folder,
            commands::ops::undo_last,
            commands::ops::redo_last,
            commands::ops::undo_stack_top,
            commands::ops::redo_stack_top,
            commands::ops::interrupted_ops,
            commands::search::search,
            commands::search::cancel_search,
            commands::macos::open_paths,
            commands::macos::open_with,
            commands::macos::open_with_apps,
            commands::macos::reveal_in_finder,
            commands::macos::quicklook_panel,
            commands::macos::get_tags,
            commands::macos::set_tags,
            commands::macos::get_info,
            commands::macos::dir_size,
            commands::macos::list_volumes,
            commands::macos::eject,
            commands::macos::default_folders,
            commands::macos::check_full_disk_access,
            commands::macos::open_full_disk_access_settings,
            commands::macos::pb_write_files,
            commands::macos::pb_read_files,
            commands::macos::pb_write_text,
            commands::macos::register_preview,
            commands::macos::revoke_preview,
            commands::macos::read_text_head,
            commands::macos::download_icloud,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
