//! macOS-integration commands: open/Open With/reveal, tags, Get Info,
//! volumes, pasteboard, Quick Look escape hatch, previews, FDA.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::core::tags::{read_tags, write_tags, FinderTag};
use crate::error::{Error, Result};
use crate::macos::main_thread::on_main;
use crate::macos::{pasteboard, share, volumes, workspace};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Open / reveal / Open With
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn open_paths(app: AppHandle, paths: Vec<String>) {
    let paths: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    on_main(&app, move || workspace::open_paths(&paths));
}

#[tauri::command]
pub fn open_with(app: AppHandle, paths: Vec<String>, app_path: String) {
    let paths: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    let target = PathBuf::from(app_path);
    on_main(&app, move || workspace::open_with(&paths, &target));
}

#[tauri::command]
pub fn open_with_apps(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Vec<workspace::AppCandidate> {
    let p = PathBuf::from(&path);
    let (candidates, default) = on_main(&app, move || workspace::apps_for_path(&p));
    candidates
        .into_iter()
        .map(|app_path| workspace::AppCandidate {
            name: workspace::display_name(&app_path)
                .trim_end_matches(".app")
                .to_string(),
            icon: state.tokens.register("openwith", &app_path),
            is_default: Some(&app_path) == default.as_ref(),
            path: app_path.to_string_lossy().into_owned(),
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragModifiers {
    pub alt: bool,
}

/// Current hardware modifier state. Read at drop time of a native drag
/// session — the webview receives no key events while AppKit runs the drag,
/// so the frontend's keydown/keyup tracker is blind then.
#[tauri::command]
pub fn drag_modifiers(app: AppHandle) -> DragModifiers {
    use objc2_app_kit::{NSEvent, NSEventModifierFlags};
    let flags = on_main(&app, || NSEvent::modifierFlags_class());
    DragModifiers {
        alt: flags.contains(NSEventModifierFlags::Option),
    }
}

#[tauri::command]
pub fn set_default_app(app: AppHandle, path: String, app_path: String) -> Result<()> {
    let p = PathBuf::from(&path);
    let target = PathBuf::from(app_path);
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    on_main(&app, move || workspace::set_default_app_for_type(&p, &target, tx));
    match rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(msg)) => Err(Error::msg(msg)),
        Err(_) => Err(Error::msg("timed out changing the default app")),
    }
}

#[tauri::command]
pub fn share_services(app: AppHandle, paths: Vec<String>) -> share::ShareServices {
    let paths: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    on_main(&app, move || share::share_services(&paths))
}

#[tauri::command]
pub fn share_perform(
    app: AppHandle,
    generation: u64,
    index: usize,
    paths: Vec<String>,
) -> Result<()> {
    let paths: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    let ok = on_main(&app, move || share::share_perform(generation, index, &paths));
    if ok {
        Ok(())
    } else {
        Err(Error::msg("the share menu went stale — try again"))
    }
}

#[tauri::command]
pub fn share_picker(
    window: tauri::WebviewWindow,
    paths: Vec<String>,
    x: f64,
    y: f64,
) -> Result<()> {
    use tauri::Manager;
    let paths: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    let view_ptr = window.ns_view().map_err(|e| Error::msg(e.to_string()))? as usize;
    // usize round-trip makes the closure Send; the view outlives the call
    // (the window is alive for the duration of the synchronous on_main).
    on_main(window.app_handle(), move || {
        let view = unsafe { &*(view_ptr as *const objc2_app_kit::NSView) };
        share::share_picker(view, &paths, x, y);
    });
    Ok(())
}

#[tauri::command]
pub fn reveal_in_finder(app: AppHandle, paths: Vec<String>) {
    let paths: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    on_main(&app, move || workspace::reveal_in_finder(&paths));
}

#[tauri::command]
pub fn quicklook_panel(paths: Vec<String>) -> Result<()> {
    // Escape hatch for exotica: qlmanage -p (detached).
    std::process::Command::new("/usr/bin/qlmanage")
        .arg("-p")
        .args(&paths)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(Error::Io)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tags & Get Info
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_tags(path: String) -> Vec<FinderTag> {
    read_tags(Path::new(&path))
}

#[tauri::command]
pub fn set_tags(path: String, tags: Vec<FinderTag>) -> Result<()> {
    write_tags(Path::new(&path), &tags).map_err(Error::Io)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetInfoResult {
    pub entry: crate::core::entry::Entry,
    pub permissions_octal: String,
    pub owner: String,
    pub group: String,
    pub where_from: Option<Vec<String>>,
    pub size_on_disk: Option<u64>,
    pub item_count: Option<u64>,
}

fn user_name(uid: u32) -> String {
    unsafe {
        let pw = libc::getpwuid(uid);
        if pw.is_null() {
            return uid.to_string();
        }
        std::ffi::CStr::from_ptr((*pw).pw_name).to_string_lossy().into_owned()
    }
}

fn group_name(gid: u32) -> String {
    unsafe {
        let gr = libc::getgrgid(gid);
        if gr.is_null() {
            return gid.to_string();
        }
        std::ffi::CStr::from_ptr((*gr).gr_name).to_string_lossy().into_owned()
    }
}

#[tauri::command]
pub fn get_info(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<GetInfoResult> {
    use std::os::unix::fs::MetadataExt;
    let p = PathBuf::from(&path);
    let meta = p.symlink_metadata().map_err(Error::Io)?;
    let entry = crate::commands::listing::build_entry(&app, &state, &p, "info")
        .ok_or_else(|| Error::msg("item no longer exists"))?;

    let where_from: Option<Vec<String>> =
        xattr::get(&p, "com.apple.metadata:kMDItemWhereFroms")
            .ok()
            .flatten()
            .and_then(|raw| plist::from_reader::<_, Vec<String>>(std::io::Cursor::new(raw)).ok());

    let item_count = if meta.is_dir() {
        std::fs::read_dir(&p).ok().map(|rd| rd.count() as u64)
    } else {
        None
    };

    Ok(GetInfoResult {
        permissions_octal: format!("{:o}", meta.mode() & 0o7777),
        owner: user_name(meta.uid()),
        group: group_name(meta.gid()),
        where_from,
        size_on_disk: if meta.is_dir() { None } else { Some(meta.blocks() * 512) },
        item_count,
        entry,
    })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DirSizeEvent {
    pub bytes: u64,
    pub entries: u64,
    pub done: bool,
}

/// Lazy folder size: streamed cumulative totals (Get Info panel).
#[tauri::command]
pub fn dir_size(path: String, channel: Channel<DirSizeEvent>) {
    std::thread::spawn(move || {
        let mut bytes = 0u64;
        let mut entries = 0u64;
        let mut last = Instant::now();
        for entry in jwalk::WalkDir::new(&path).skip_hidden(false) {
            let Ok(e) = entry else { continue };
            entries += 1;
            if e.file_type().is_file() {
                if let Ok(m) = e.metadata() {
                    bytes += m.len();
                }
            }
            if last.elapsed() > Duration::from_millis(120) {
                last = Instant::now();
                if channel.send(DirSizeEvent { bytes, entries, done: false }).is_err() {
                    return;
                }
            }
        }
        let _ = channel.send(DirSizeEvent { bytes, entries, done: true });
    });
}

// ---------------------------------------------------------------------------
// Volumes & default folders
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_volumes(app: AppHandle) -> Vec<volumes::Volume> {
    on_main(&app, volumes::list_volumes)
}

#[tauri::command]
pub fn eject(app: AppHandle, path: String) -> Result<()> {
    let p = PathBuf::from(&path);
    let ok = on_main(&app, move || workspace::eject(&p));
    if ok {
        Ok(())
    } else {
        Err(Error::msg("couldn't eject — the volume may be in use"))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultFolders {
    pub home: String,
    pub desktop: String,
    pub documents: String,
    pub downloads: String,
    pub pictures: String,
    pub music: String,
    pub movies: String,
    pub applications: String,
    pub trash: String,
}

#[tauri::command]
pub fn default_folders() -> DefaultFolders {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    DefaultFolders {
        desktop: format!("{home}/Desktop"),
        documents: format!("{home}/Documents"),
        downloads: format!("{home}/Downloads"),
        pictures: format!("{home}/Pictures"),
        music: format!("{home}/Music"),
        movies: format!("{home}/Movies"),
        applications: "/Applications".into(),
        trash: format!("{home}/.Trash"),
        home,
    }
}

// ---------------------------------------------------------------------------
// Full Disk Access
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn check_full_disk_access() -> bool {
    workspace::probe_full_disk_access()
}

#[tauri::command]
pub fn open_full_disk_access_settings(app: AppHandle) {
    on_main(&app, || {
        workspace::open_settings_url(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
        )
    });
}

// ---------------------------------------------------------------------------
// Pasteboard
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteboardContents {
    pub paths: Vec<String>,
    pub is_cut: bool,
}

#[tauri::command]
pub fn pb_write_files(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    is_cut: bool,
) {
    let pbs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    let _before = on_main(&app, move || pasteboard::write_files(&pbs));
    let after = on_main(&app, pasteboard::change_count);
    *state.pb_mark.lock().unwrap() = Some((after, is_cut));
}

#[tauri::command]
pub fn pb_read_files(app: AppHandle, state: State<'_, AppState>) -> Option<PasteboardContents> {
    let paths = pasteboard::existing(on_main(&app, pasteboard::read_files));
    if paths.is_empty() {
        return None;
    }
    let count = on_main(&app, pasteboard::change_count);
    // Cut applies only if the pasteboard still holds our own write.
    let is_cut = matches!(*state.pb_mark.lock().unwrap(), Some((c, true)) if c == count);
    Some(PasteboardContents {
        paths: paths.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
        is_cut,
    })
}

#[tauri::command]
pub fn pb_write_text(app: AppHandle, state: State<'_, AppState>, text: String) {
    let after = on_main(&app, move || pasteboard::write_text(&text));
    *state.pb_mark.lock().unwrap() = Some((after, false));
}

// ---------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn register_preview(state: State<'_, AppState>, path: String) -> String {
    let token = uuid::Uuid::new_v4().simple().to_string();
    state.previews.insert(token.clone(), PathBuf::from(&path));
    token
}

#[tauri::command]
pub fn revoke_preview(state: State<'_, AppState>, token: String) {
    state.previews.remove(&token);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPreview {
    pub text: String,
    pub truncated: bool,
    pub total_bytes: u64,
}

#[tauri::command]
pub fn read_text_head(path: String, max_bytes: u64) -> Result<TextPreview> {
    let max = max_bytes.clamp(1, 4 * 1024 * 1024) as usize;
    let mut file = std::fs::File::open(&path).map_err(Error::Io)?;
    let total = file.metadata().map_err(Error::Io)?.len();
    let mut buf = vec![0u8; max.min(total as usize)];
    file.read_exact(&mut buf).map_err(Error::Io)?;
    if buf.iter().take(8192).any(|&b| b == 0) {
        return Err(Error::msg("binary file"));
    }
    Ok(TextPreview {
        text: String::from_utf8_lossy(&buf).into_owned(),
        truncated: (buf.len() as u64) < total,
        total_bytes: total,
    })
}
