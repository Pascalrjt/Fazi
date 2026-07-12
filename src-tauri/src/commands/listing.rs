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
/// Listings above this skip pass 2 entirely: Done follows Listed immediately,
/// no Hydrate events ever arrive on the channel, and hydration flows through
/// `hydrate_paths` request/response (viewport-priority, frontend-scheduled).
const PASS2_MAX_ENTRIES: usize = 5_000;

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
        for (next_id, dirent) in read.flatten().enumerate() {
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
            let entry = pass1_entry(next_id as u64, &dir, &name, kind, token);
            chunk.push(entry.clone());
            all.push(entry);
            if chunk.len() >= CHUNK
                && channel.send(ListEvent::Chunk { entries: std::mem::take(&mut chunk) }).is_err()
            {
                return;
            }
        }
        if !chunk.is_empty() {
            let _ = channel.send(ListEvent::Chunk { entries: chunk });
        }
        if channel.send(ListEvent::Listed { total: all.len() as u64 }).is_err() {
            return;
        }

        // Big listings: ONE defined behavior — pass 2 never runs, the entry
        // vector is dropped (it exists only to feed pass 2), and the frontend
        // hydrates from the viewport outward via hydrate_paths.
        if all.len() > PASS2_MAX_ENTRIES {
            drop(all);
            let _ = channel.send(ListEvent::Done);
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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HydrateItem {
    pub id: u64,
    pub path: String,
    pub icon: String,
}

/// Hydrate one patch item, preserving the CALLER's row id and icon token —
/// never minted here, so responses flow through the standard hydrate merge
/// and the TokenTable doesn't grow on rehydrate. Returns the entry plus
/// whether it needs the main-thread package check; None when the path
/// vanished (the watcher will remove the row).
pub fn hydrate_item(item: &HydrateItem) -> Option<(Entry, bool)> {
    let p = PathBuf::from(&item.path);
    let (dir, name) = (p.parent()?, p.file_name()?);
    p.symlink_metadata().ok()?;
    let mut entry = pass1_entry(
        item.id,
        dir,
        &name.to_string_lossy(),
        EntryKind::Unknown,
        item.icon.clone(),
    );
    let needs_pkg = hydrate(&mut entry);
    Some((entry, needs_pkg))
}

/// Viewport-priority hydration patch API (big listings, where pass 2 never
/// ran). Responses are guarded by listingId on the frontend — the id is
/// threaded through for symmetry with the channel events.
#[tauri::command]
pub fn hydrate_paths(
    app: AppHandle,
    listing_id: String,
    items: Vec<HydrateItem>,
) -> Vec<Option<Entry>> {
    let _ = listing_id;
    let mut out: Vec<Option<Entry>> = Vec::with_capacity(items.len());
    let mut pkg_candidates: Vec<usize> = Vec::new();
    for item in &items {
        match hydrate_item(item) {
            Some((entry, needs_pkg)) => {
                if needs_pkg {
                    pkg_candidates.push(out.len());
                }
                out.push(Some(entry));
            }
            None => out.push(None),
        }
    }
    if !pkg_candidates.is_empty() {
        let paths: Vec<PathBuf> = pkg_candidates
            .iter()
            .filter_map(|&i| out[i].as_ref().map(|e| PathBuf::from(&e.path)))
            .collect();
        let results = crate::macos::main_thread::on_main(&app, move || {
            crate::macos::workspace::are_file_packages(&paths)
        });
        for (&i, is_pkg) in pkg_candidates.iter().zip(results) {
            if let Some(e) = out[i].as_mut() {
                e.is_package = is_pkg;
            }
        }
    }
    out
}

/// Bulk stat: fully-hydrated entries for many paths in one IPC round-trip
/// (watcher upsert batches, search-fallback hydration). `build_entry` mints
/// icon tokens, so the owner scope is an explicit argument: the listingId for
/// watcher upserts, the searchId for search hits.
#[tauri::command]
pub fn stat_paths(
    app: AppHandle,
    state: State<'_, AppState>,
    owner: String,
    paths: Vec<String>,
) -> Vec<Option<Entry>> {
    paths
        .iter()
        .map(|p| build_entry(&app, &state, Path::new(p), &owner))
        .collect()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("fazi-hydrate-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn hydrate_item_preserves_caller_id_and_token() {
        let d = tmp("preserve");
        std::fs::write(d.join("doc.txt"), b"hello").unwrap();
        let item = HydrateItem {
            id: 4242,
            path: d.join("doc.txt").to_string_lossy().into_owned(),
            icon: "existing-token-abc".into(),
        };
        let (entry, needs_pkg) = hydrate_item(&item).expect("file exists");
        // The whole point of the patch API: the row id and icon token are the
        // caller's — no new id counter, no TokenTable growth.
        assert_eq!(entry.id, 4242);
        assert_eq!(entry.icon, "existing-token-abc");
        assert!(entry.hydrated);
        assert_eq!(entry.size, Some(5));
        assert!(!needs_pkg);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn hydrate_item_mixed_existing_and_missing() {
        let d = tmp("mixed");
        std::fs::write(d.join("real.txt"), b"x").unwrap();
        let real = HydrateItem {
            id: 1,
            path: d.join("real.txt").to_string_lossy().into_owned(),
            icon: "t1".into(),
        };
        let gone = HydrateItem {
            id: 2,
            path: d.join("vanished.txt").to_string_lossy().into_owned(),
            icon: "t2".into(),
        };
        assert!(hydrate_item(&real).is_some());
        // Vanished between passes → None (the watcher removes the row).
        assert!(hydrate_item(&gone).is_none());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn hydrate_item_flags_ambiguous_package_dirs() {
        let d = tmp("pkg");
        std::fs::create_dir(d.join("Thing.weirdext")).unwrap();
        std::fs::create_dir(d.join("plain")).unwrap();
        let ambiguous = HydrateItem {
            id: 1,
            path: d.join("Thing.weirdext").to_string_lossy().into_owned(),
            icon: "t".into(),
        };
        let plain = HydrateItem {
            id: 2,
            path: d.join("plain").to_string_lossy().into_owned(),
            icon: "t".into(),
        };
        let (_, needs_pkg) = hydrate_item(&ambiguous).unwrap();
        assert!(needs_pkg, "dir with an unknown extension needs the NSWorkspace check");
        let (_, needs_pkg) = hydrate_item(&plain).unwrap();
        assert!(!needs_pkg);
        std::fs::remove_dir_all(&d).ok();
    }
}
