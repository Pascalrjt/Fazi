//! Auto-cleanup commands. The frontend schedules sweeps (at launch and hourly
//! while Fazi runs); Rust rescans at sweep time so nothing is trashed on the
//! strength of a stale listing.
//!
//! Sweeps deliberately stay off the undo stack: they aren't something the
//! user just did, and ⌘Z meant for their last rename must not resurrect a
//! background sweep. The sweep toast restores through `cleanup_restore`.

use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::core::cleanup::{self, CleanupOptions, FolderReport};
use crate::core::undo::{move_back, validate_absent, validate_exists};
use crate::macos::trash::trash_path;
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SweptItem {
    /// Where the item lived.
    pub original: String,
    /// Where it landed in the Trash.
    pub trashed: String,
    pub name: String,
    pub size: Option<u64>,
    pub is_dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepResult {
    pub swept: Vec<SweptItem>,
    pub errors: Vec<String>,
    /// A fresh scan taken after the sweep.
    pub reports: Vec<FolderReport>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePair {
    pub original: String,
    pub trashed: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredItem {
    pub path: String,
    /// Identity after the move, so the frontend can keep the item (an
    /// overdue item put back would otherwise go again in the next sweep).
    pub dev: u64,
    pub ino: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub restored: Vec<RestoredItem>,
    pub errors: Vec<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command(async)]
pub fn cleanup_scan(opts: CleanupOptions) -> Vec<FolderReport> {
    cleanup::scan(&opts)
}

#[tauri::command(async)]
pub fn cleanup_sweep(state: State<'_, AppState>, opts: CleanupOptions) -> SweepResult {
    let reports = cleanup::scan(&opts);
    let mut swept = Vec::new();
    let mut errors = Vec::new();
    for item in cleanup::due_items(&reports, now_ms()) {
        let original = PathBuf::from(&item.path);
        // Same inode as scanned, or it was replaced a moment ago: leave it.
        match original.symlink_metadata() {
            Ok(m) if m.dev() == item.dev && m.ino() == item.ino => {}
            _ => continue,
        }
        match trash_path(&original) {
            Ok(landed) => swept.push(SweptItem {
                original: item.path.clone(),
                trashed: landed.to_string_lossy().into_owned(),
                name: item.name.clone(),
                size: item.size,
                is_dir: item.is_dir,
            }),
            Err(e) => errors.push(format!("{}: {e}", item.name)),
        }
    }
    if !swept.is_empty() {
        let touched: Vec<PathBuf> = swept
            .iter()
            .flat_map(|s| [PathBuf::from(&s.original), PathBuf::from(&s.trashed)])
            .collect();
        (state.engine.invalidate_fuzzy)(&touched);
    }
    let reports = if swept.is_empty() { reports } else { cleanup::scan(&opts) };
    SweepResult { swept, errors, reports }
}

/// Put swept items back where they were. Each item restores independently;
/// one whose name was reused meanwhile stays in the Trash and is reported.
#[tauri::command(async)]
pub fn cleanup_restore(state: State<'_, AppState>, pairs: Vec<RestorePair>) -> RestoreResult {
    let mut restored = Vec::new();
    let mut errors = Vec::new();
    for pair in pairs {
        let original = PathBuf::from(&pair.original);
        let trashed = PathBuf::from(&pair.trashed);
        let outcome = validate_exists(&trashed)
            .and_then(|()| validate_absent(&original))
            .and_then(|()| move_back(&trashed, &original));
        match outcome.and_then(|()| original.symlink_metadata()) {
            Ok(m) => restored.push(RestoredItem { path: pair.original, dev: m.dev(), ino: m.ino() }),
            Err(e) => errors.push(e.to_string()),
        }
    }
    if !restored.is_empty() {
        let touched: Vec<PathBuf> = restored.iter().map(|r| PathBuf::from(&r.path)).collect();
        (state.engine.invalidate_fuzzy)(&touched);
    }
    RestoreResult { restored, errors }
}
