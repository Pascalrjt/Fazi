//! Two-stage streamed directory listing (perf-critical, see plan).
//! Pass 1: readdir names + d_type hints, streamed in chunks of ~1000, in
//! directory order. Pass 2: background hydration batches (lstat, tags,
//! packages), streamed as delta updates over the same channel.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::core::entry::{hydrate, pass1_entry, Entry, EntryKind};
use crate::error::Result;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum ListEvent {
    #[serde(rename_all = "camelCase")]
    Chunk { entries: Vec<Entry> },
    #[serde(rename_all = "camelCase")]
    Listed { total: u64 },
    #[serde(rename_all = "camelCase")]
    Hydrate { entries: Vec<Entry> },
    Done,
    #[serde(rename_all = "camelCase")]
    Error { code: String, message: String },
}

const CHUNK: usize = 1000;
const HYDRATE_BATCH: usize = 256;

fn error_code(e: &std::io::Error) -> &'static str {
    match e.kind() {
        std::io::ErrorKind::NotFound => "notFound",
        std::io::ErrorKind::PermissionDenied => "permissionDenied",
        std::io::ErrorKind::NotADirectory => "notADirectory",
        _ => "io",
    }
}

#[tauri::command]
pub fn list_dir(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    listing_id: String,
    channel: Channel<ListEvent>,
) -> Result<()> {
    let cancel = Arc::new(AtomicBool::new(false));
    state.listings.insert(listing_id.clone(), cancel.clone());
    let tokens = state.tokens.clone();

    std::thread::spawn(move || {
        let dir = PathBuf::from(&path);
        let read = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(e) => {
                let _ = channel.send(ListEvent::Error {
                    code: error_code(&e).into(),
                    message: e.to_string(),
                });
                return;
            }
        };

        // ---- Pass 1: stream what readdir gives nearly free ----
        let mut all: Vec<Entry> = Vec::new();
        let mut chunk: Vec<Entry> = Vec::with_capacity(CHUNK);
        let mut next_id: u64 = 0;
        for dirent in read.flatten() {
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            let name = dirent.file_name().to_string_lossy().into_owned();
            // d_type is a hint only — DT_UNKNOWN on foreign filesystems.
            let kind = match dirent.file_type() {
                Ok(ft) if ft.is_dir() => EntryKind::Dir,
                Ok(ft) if ft.is_symlink() => EntryKind::Symlink,
                Ok(_) => EntryKind::File,
                Err(_) => EntryKind::Unknown,
            };
            let token = tokens.register(&listing_id, &dirent.path());
            let entry = pass1_entry(next_id, &dir, &name, kind, token);
            next_id += 1;
            chunk.push(entry.clone());
            all.push(entry);
            if chunk.len() >= CHUNK {
                if channel.send(ListEvent::Chunk { entries: std::mem::take(&mut chunk) }).is_err() {
                    return;
                }
            }
        }
        if !chunk.is_empty() {
            let _ = channel.send(ListEvent::Chunk { entries: chunk });
        }
        if channel.send(ListEvent::Listed { total: all.len() as u64 }).is_err() {
            return;
        }

        // ---- Pass 2: hydration in background batches ----
        for batch in all.chunks_mut(HYDRATE_BATCH) {
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            let mut pkg_candidates: Vec<usize> = Vec::new();
            for (i, entry) in batch.iter_mut().enumerate() {
                if hydrate(entry) {
                    pkg_candidates.push(i);
                }
            }
            // Ambiguous dirs (dir + extension): one main-thread batch.
            if !pkg_candidates.is_empty() {
                let paths: Vec<PathBuf> =
                    pkg_candidates.iter().map(|&i| PathBuf::from(&batch[i].path)).collect();
                let results = crate::macos::main_thread::on_main(&app, move || {
                    crate::macos::workspace::are_file_packages(&paths)
                });
                for (&i, is_pkg) in pkg_candidates.iter().zip(results) {
                    batch[i].is_package = is_pkg;
                }
            }
            if channel.send(ListEvent::Hydrate { entries: batch.to_vec() }).is_err() {
                return;
            }
        }
        let _ = channel.send(ListEvent::Done);
    });
    Ok(())
}

#[tauri::command]
pub fn cancel_listing(state: State<'_, AppState>, listing_id: String) {
    if let Some((_, flag)) = state.listings.remove(&listing_id) {
        flag.store(true, Ordering::Relaxed);
    }
    state.tokens.drop_owner(&listing_id);
}

/// Fully-hydrated entry for one path (watcher upserts, get-info).
/// Icon token is registered under `listing_id` so it lives with the listing.
#[tauri::command]
pub fn stat_path(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    listing_id: String,
) -> Option<Entry> {
    let p = PathBuf::from(&path);
    build_entry(&app, &state, &p, &listing_id)
}

pub fn build_entry<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    p: &Path,
    owner: &str,
) -> Option<Entry> {
    // Ids for ad-hoc entries (watcher upserts, get-info) come from a global
    // counter offset far above any listing sequence, so they never collide
    // with pass-1 ids inside the same listing session.
    static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1 << 40);
    p.symlink_metadata().ok()?;
    let dir = p.parent()?;
    let name = p.file_name()?.to_string_lossy().into_owned();
    let token = state.tokens.register(owner, p);
    let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut entry = pass1_entry(id, dir, &name, EntryKind::Unknown, token);
    let needs_pkg = hydrate(&mut entry);
    if needs_pkg {
        let path = p.to_path_buf();
        entry.is_package = crate::macos::main_thread::on_main(app, move || {
            crate::macos::workspace::is_file_package(&path)
        });
    }
    Some(entry)
}

/// Convenience used by other commands to mint conflict-side icons etc.
pub fn icon_token_for(app: &AppHandle, owner: &str, path: &Path) -> String {
    let state = app.state::<AppState>();
    state.tokens.register(owner, path)
}
