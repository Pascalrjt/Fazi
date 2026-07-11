//! File-operation commands: the thin layer over core/op_queue.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::core::archive::{spawn_compress, spawn_extract};
use crate::core::op_queue::{spawn_duplicate, spawn_op, OpArgs, OpEmitter, OpEvent, OpKind, Policy};
use crate::core::undo::UndoOp;
use crate::core::walker::{self, Resolution};
use crate::error::{Error, Result};
use crate::macos::trash::{self, trash_path};
use crate::state::AppState;

struct ChannelEmitter(Channel<OpEvent>);

impl OpEmitter for ChannelEmitter {
    fn emit(&self, e: OpEvent) {
        let _ = self.0.send(e);
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // signature mirrors the invoke wire contract
pub fn run_op(
    state: State<'_, AppState>,
    op_id: String,
    kind: String,
    sources: Vec<String>,
    dest_dir: String,
    policy: String,
    verify: Option<bool>,
    channel: Channel<OpEvent>,
) -> Result<()> {
    let kind = match kind.as_str() {
        "copy" => OpKind::Copy,
        "move" => OpKind::Move,
        other => return Err(Error::msg(format!("unknown op kind: {other}"))),
    };
    let dest = PathBuf::from(&dest_dir);
    if !dest.is_dir() {
        return Err(Error::msg("destination is not a directory"));
    }
    let args = OpArgs {
        op_id,
        kind,
        sources: sources.iter().map(PathBuf::from).collect(),
        dest_dir: dest,
        policy: Policy::from_wire(&policy),
        verify: verify.unwrap_or(false),
    };
    spawn_op(state.engine.clone(), args, Arc::new(ChannelEmitter(channel)));
    Ok(())
}

#[tauri::command]
pub fn duplicate_paths(
    state: State<'_, AppState>,
    op_id: String,
    paths: Vec<String>,
    channel: Channel<OpEvent>,
) -> Result<()> {
    spawn_duplicate(
        state.engine.clone(),
        op_id,
        paths.iter().map(PathBuf::from).collect(),
        Arc::new(ChannelEmitter(channel)),
    );
    Ok(())
}

#[tauri::command]
pub fn compress_paths(
    state: State<'_, AppState>,
    op_id: String,
    sources: Vec<String>,
    dest_dir: String,
    channel: Channel<OpEvent>,
) -> Result<()> {
    let dest = PathBuf::from(&dest_dir);
    if !dest.is_dir() {
        return Err(Error::msg("destination is not a directory"));
    }
    spawn_compress(
        state.engine.clone(),
        op_id,
        sources.iter().map(PathBuf::from).collect(),
        dest,
        Arc::new(ChannelEmitter(channel)),
    );
    Ok(())
}

#[tauri::command]
pub fn extract_paths(
    state: State<'_, AppState>,
    op_id: String,
    sources: Vec<String>,
    dest_dir: String,
    channel: Channel<OpEvent>,
) -> Result<()> {
    let dest = PathBuf::from(&dest_dir);
    if !dest.is_dir() {
        return Err(Error::msg("destination is not a directory"));
    }
    spawn_extract(
        state.engine.clone(),
        op_id,
        sources.iter().map(PathBuf::from).collect(),
        dest,
        Arc::new(ChannelEmitter(channel)),
    );
    Ok(())
}

#[tauri::command]
pub fn cancel_op(state: State<'_, AppState>, op_id: String) {
    state.engine.cancel_op(&op_id);
}

#[tauri::command]
pub fn respond_conflict(
    state: State<'_, AppState>,
    op_id: String,
    conflict_id: u64,
    response: String,
    apply_to_all: bool,
) {
    let resolution = match response.as_str() {
        "keepBoth" => Resolution::KeepBoth,
        "replace" => Resolution::Replace,
        "merge" => Resolution::Merge,
        "skip" => Resolution::Skip,
        _ => Resolution::Cancel,
    };
    state.engine.respond_conflict(&op_id, conflict_id, resolution, apply_to_all);
}

#[tauri::command]
pub fn trash_paths(state: State<'_, AppState>, paths: Vec<String>) -> Result<()> {
    let mut pairs = Vec::new();
    let mut errors = Vec::new();
    for p in &paths {
        let original = PathBuf::from(p);
        match trash_path(&original) {
            Ok(landed) => pairs.push((original, landed)),
            Err(e) => errors.push(format!("{p}: {e}")),
        }
    }
    if !pairs.is_empty() {
        state.engine.undo.lock().unwrap().push(UndoOp::Trash { pairs });
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(Error::msg(errors.join("\n")))
    }
}

// ---------------------------------------------------------------------------
// Empty Trash
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum EmptyTrashEvent {
    #[serde(rename_all = "camelCase")]
    Progress { deleted: u64, total: u64 },
    #[serde(rename_all = "camelCase")]
    Done { errors: Vec<crate::core::op_queue::OpError> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashStats {
    pub count: u64,
    pub external_count: u64,
}

/// Item counts across every user trash dir — the confirm dialog's source of
/// truth ("N items (M on external volumes)"). The sidebar row only browses
/// `~/.Trash`; the dialog copy covers the rest.
#[tauri::command]
pub fn trash_stats() -> TrashStats {
    let home_trash = std::env::var("HOME")
        .map(|h| PathBuf::from(h).join(".Trash"))
        .unwrap_or_default();
    let mut count = 0u64;
    let mut external = 0u64;
    for dir in trash::user_trash_dirs() {
        let n = trash::trash_items(&dir).len() as u64;
        count += n;
        if dir != home_trash {
            external += n;
        }
    }
    TrashStats { count, external_count: external }
}

/// Permanently delete everything in the Trash (all volumes), streaming
/// progress. Undo/redo records referencing the deleted content are purged —
/// even on a partial run, for every item that did delete.
#[tauri::command]
pub fn empty_trash(state: State<'_, AppState>, channel: Channel<EmptyTrashEvent>) {
    let engine = state.engine.clone();
    std::thread::spawn(move || {
        let dirs = trash::user_trash_dirs();
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let outcome = trash::empty_trash_dirs(
            &dirs,
            &mut |deleted, total| {
                let _ = channel.send(EmptyTrashEvent::Progress { deleted, total });
            },
            &cancel,
        );
        if !outcome.deleted.is_empty() {
            engine.undo.lock().unwrap().purge_records_under(&outcome.deleted);
        }
        let _ = channel.send(EmptyTrashEvent::Done {
            errors: outcome
                .errors
                .iter()
                .map(|(p, e)| crate::core::op_queue::OpError {
                    path: p.to_string_lossy().into_owned(),
                    message: e.to_string(),
                })
                .collect(),
        });
    });
}

#[tauri::command]
pub fn delete_permanent(paths: Vec<String>) -> Result<()> {
    let mut errors = Vec::new();
    for p in &paths {
        let path = Path::new(p);
        let outcome = match path.symlink_metadata() {
            Ok(m) if m.is_dir() && !m.file_type().is_symlink() => std::fs::remove_dir_all(path),
            Ok(_) => std::fs::remove_file(path),
            Err(e) => Err(e),
        };
        if let Err(e) = outcome {
            errors.push(format!("{p}: {e}"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(Error::msg(errors.join("\n")))
    }
}

/// Illegal characters in a macOS file name (POSIX layer).
fn validate_name(name: &str) -> Result<()> {
    crate::core::batch_rename::validate_name(name).map_err(Error::Io)
}

// ---------------------------------------------------------------------------
// Batch rename
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRenameItem {
    pub from: String,
    pub to_name: String,
}

/// All-or-nothing two-phase batch rename. Every `from` must share ONE parent
/// directory — enforced here at the boundary, not just by UI construction.
/// Returns the new absolute paths (same order); records a single undo entry.
#[tauri::command]
pub fn batch_rename(
    state: State<'_, AppState>,
    renames: Vec<BatchRenameItem>,
) -> Result<Vec<String>> {
    use crate::core::batch_rename::{std_rename, two_phase_rename, validate_batch};
    if renames.is_empty() {
        return Err(Error::msg("nothing to rename"));
    }
    let mut parent: Option<PathBuf> = None;
    let mut pairs: Vec<(String, String)> = Vec::new();
    for item in &renames {
        let from = PathBuf::from(&item.from);
        let dir = from
            .parent()
            .ok_or_else(|| Error::msg("can't rename this item"))?
            .to_path_buf();
        match &parent {
            None => parent = Some(dir),
            Some(p) if *p == dir => {}
            Some(_) => return Err(Error::msg("all items must be in the same folder")),
        }
        let from_name = from
            .file_name()
            .ok_or_else(|| Error::msg("can't rename this item"))?
            .to_string_lossy()
            .into_owned();
        pairs.push((from_name, item.to_name.clone()));
    }
    let parent = parent.expect("non-empty batch has a parent");
    // Skip no-op pairs (name unchanged) — they'd trip the collision check.
    pairs.retain(|(f, t)| f != t);
    if pairs.is_empty() {
        return Ok(renames.iter().map(|r| r.from.clone()).collect());
    }

    validate_batch(&parent, &pairs).map_err(Error::Io)?;
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let finals = two_phase_rename(&parent, &pairs, &tag, &std_rename).map_err(Error::Io)?;

    let undo_pairs: Vec<(PathBuf, PathBuf)> = pairs
        .iter()
        .zip(&finals)
        .map(|((from, _), to)| (parent.join(from), to.clone()))
        .collect();
    state
        .engine
        .undo
        .lock()
        .unwrap()
        .push(UndoOp::BatchRename { pairs: undo_pairs });
    Ok(finals.iter().map(|p| p.to_string_lossy().into_owned()).collect())
}

// ---------------------------------------------------------------------------
// Paste clipboard content as a new file
// ---------------------------------------------------------------------------

/// Create a new file in `dest_dir` from the clipboard: an image wins over
/// text; returns None when the pasteboard holds neither. Undo trashes the
/// created file and records the landed path, so redo restores it from the
/// Trash (the ProducedItems round-trip).
#[tauri::command]
pub fn pb_paste_new_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    dest_dir: String,
) -> Result<Option<String>> {
    use crate::core::undo::ProducedKind;
    use crate::core::walker::{exists_ci, keep_both_name};
    use crate::macos::main_thread::on_main;
    use crate::macos::pasteboard;

    let dest = PathBuf::from(&dest_dir);
    if !dest.is_dir() {
        return Err(Error::msg("destination is not a directory"));
    }
    let (bytes, base_name): (Vec<u8>, &str) =
        if let Some(png) = on_main(&app, pasteboard::read_image_png) {
            (png, "Pasted Image.png")
        } else if let Some(text) = on_main(&app, pasteboard::read_string) {
            (text.into_bytes(), "Pasted Text.txt")
        } else {
            return Ok(None);
        };

    let name = if exists_ci(&dest, base_name) {
        keep_both_name(&dest, base_name)
    } else {
        base_name.to_string()
    };
    let path = dest.join(&name);
    std::fs::write(&path, &bytes)?;
    state.engine.undo.lock().unwrap().push(UndoOp::ProducedItems {
        kind: ProducedKind::Paste,
        pairs: vec![(path.clone(), None)],
    });
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn rename_path(state: State<'_, AppState>, path: String, new_name: String) -> Result<String> {
    validate_name(&new_name)?;
    let from = PathBuf::from(&path);
    let parent = from
        .parent()
        .ok_or_else(|| Error::msg("can't rename this item"))?;
    let old_name = from
        .file_name()
        .ok_or_else(|| Error::msg("can't rename this item"))?
        .to_string_lossy()
        .into_owned();
    let to = parent.join(&new_name);

    if old_name == new_name {
        return Ok(to.to_string_lossy().into_owned());
    }
    // Case-only rename is allowed — self-collision compares names, not just
    // existence (APFS is case-insensitive: `to` "exists" during foo→Foo).
    let case_only = old_name.to_lowercase() == new_name.to_lowercase();
    if !case_only && walker::exists_ci(parent, &new_name) {
        return Err(Error::msg(format!("\"{new_name}\" already exists")));
    }
    std::fs::rename(&from, &to)?;
    state
        .engine
        .undo
        .lock()
        .unwrap()
        .push(UndoOp::Rename { from: from.clone(), to: to.clone() });
    Ok(to.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn new_folder(state: State<'_, AppState>, parent: String, name: String) -> Result<String> {
    let parent = PathBuf::from(&parent);
    let base = if name.is_empty() { "untitled folder".to_string() } else { name };
    validate_name(&base)?;
    let unique = walker::new_folder_name(&parent, &base);
    let path = parent.join(&unique);
    std::fs::create_dir(&path)?;
    state
        .engine
        .undo
        .lock()
        .unwrap()
        .push(UndoOp::NewFolder { path: path.clone() });
    Ok(path.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoResult {
    pub label: String,
    pub restored: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoDescription {
    pub label: String,
    pub kind: String,
}

#[tauri::command]
pub fn undo_last(state: State<'_, AppState>) -> Result<Option<UndoResult>> {
    let trasher = state.engine.trasher.clone();
    let outcome = state
        .engine
        .undo
        .lock()
        .unwrap()
        .undo(trasher.as_ref())
        .map_err(|e| Error::msg(format!("Can't undo: {e}")))?;
    Ok(outcome.map(|o| UndoResult {
        label: o.label,
        restored: o.restored.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
    }))
}

#[tauri::command]
pub fn redo_last(state: State<'_, AppState>) -> Result<Option<UndoResult>> {
    let trasher = state.engine.trasher.clone();
    let outcome = state
        .engine
        .undo
        .lock()
        .unwrap()
        .redo(trasher.as_ref())
        .map_err(|e| Error::msg(format!("Can't redo: {e}")))?;
    Ok(outcome.map(|o| UndoResult {
        label: o.label,
        restored: o.restored.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
    }))
}

#[tauri::command]
pub fn undo_stack_top(state: State<'_, AppState>) -> Option<UndoDescription> {
    state.engine.undo.lock().unwrap().undo_top().map(|op| UndoDescription {
        label: op.label(),
        kind: op.kind_wire().to_string(),
    })
}

#[tauri::command]
pub fn redo_stack_top(state: State<'_, AppState>) -> Option<UndoDescription> {
    state.engine.undo.lock().unwrap().redo_top().map(|op| UndoDescription {
        label: op.label(),
        kind: op.kind_wire().to_string(),
    })
}

#[tauri::command]
pub fn interrupted_ops(state: State<'_, AppState>) -> Vec<crate::core::journal::InterruptedOp> {
    state.interrupted.clone()
}
