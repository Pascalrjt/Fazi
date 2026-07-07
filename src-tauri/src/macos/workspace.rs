//! NSWorkspace integration: open, Open With, reveal, package detection,
//! eject, Full Disk Access probing. All calls marshaled to the main thread
//! by the callers via `main_thread::on_main`.

// objc2 versions move methods between safe/unsafe; keep defensive `unsafe`
// blocks without churning every call site on upgrades.
#![allow(unused_unsafe)]

use std::path::{Path, PathBuf};

use objc2::rc::Retained;
use objc2_app_kit::{NSWorkspace, NSWorkspaceOpenConfiguration};
use objc2_foundation::{NSArray, NSString, NSURL};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppCandidate {
    pub name: String,
    pub path: String,
    pub icon: String,
    pub is_default: bool,
}

fn file_url(path: &Path) -> Retained<NSURL> {
    unsafe { NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy())) }
}

fn url_path(url: &NSURL) -> Option<PathBuf> {
    unsafe { url.path() }.map(|p| PathBuf::from(p.to_string()))
}

/// MUST run on the main thread.
pub fn open_paths(paths: &[PathBuf]) {
    let ws = unsafe { NSWorkspace::sharedWorkspace() };
    for p in paths {
        unsafe { ws.openURL(&file_url(p)) };
    }
}

/// MUST run on the main thread.
pub fn open_with(paths: &[PathBuf], app_path: &Path) {
    let ws = unsafe { NSWorkspace::sharedWorkspace() };
    let urls: Vec<Retained<NSURL>> = paths.iter().map(|p| file_url(p)).collect();
    let refs: Vec<&NSURL> = urls.iter().map(|u| u.as_ref()).collect();
    let array = NSArray::from_slice(&refs);
    let app_url = file_url(app_path);
    let config = unsafe { NSWorkspaceOpenConfiguration::configuration() };
    unsafe {
        ws.openURLs_withApplicationAtURL_configuration_completionHandler(
            &array, &app_url, &config, None,
        )
    };
}

/// MUST run on the main thread. Returns (candidates, default_app_path).
pub fn apps_for_path(path: &Path) -> (Vec<PathBuf>, Option<PathBuf>) {
    let ws = unsafe { NSWorkspace::sharedWorkspace() };
    let url = file_url(path);
    let default = unsafe { ws.URLForApplicationToOpenURL(&url) }.and_then(|u| url_path(&u));
    let candidates = unsafe { ws.URLsForApplicationsToOpenURL(&url) };
    let mut out = Vec::new();
    for u in candidates.iter() {
        if let Some(p) = url_path(&u) {
            out.push(p);
        }
    }
    (out, default)
}

/// MUST run on the main thread.
pub fn reveal_in_finder(paths: &[PathBuf]) {
    let ws = unsafe { NSWorkspace::sharedWorkspace() };
    let urls: Vec<Retained<NSURL>> = paths.iter().map(|p| file_url(p)).collect();
    let refs: Vec<&NSURL> = urls.iter().map(|u| u.as_ref()).collect();
    let array = NSArray::from_slice(&refs);
    unsafe { ws.activateFileViewerSelectingURLs(&array) };
}

/// MUST run on the main thread.
pub fn is_file_package(path: &Path) -> bool {
    let ws = unsafe { NSWorkspace::sharedWorkspace() };
    unsafe { ws.isFilePackageAtPath(&NSString::from_str(&path.to_string_lossy())) }
}

/// MUST run on the main thread. Batched variant for hydration.
pub fn are_file_packages(paths: &[PathBuf]) -> Vec<bool> {
    let ws = unsafe { NSWorkspace::sharedWorkspace() };
    paths
        .iter()
        .map(|p| unsafe { ws.isFilePackageAtPath(&NSString::from_str(&p.to_string_lossy())) })
        .collect()
}

/// MUST run on the main thread.
pub fn eject(path: &Path) -> bool {
    let ws = unsafe { NSWorkspace::sharedWorkspace() };
    unsafe { ws.unmountAndEjectDeviceAtPath(&NSString::from_str(&path.to_string_lossy())) }
}

/// MUST run on the main thread.
pub fn open_settings_url(url: &str) {
    let ws = unsafe { NSWorkspace::sharedWorkspace() };
    if let Some(u) = unsafe { NSURL::URLWithString(&NSString::from_str(url)) } {
        unsafe { ws.openURL(&u) };
    }
}

/// Display name for an app bundle (thread-safe: NSFileManager).
pub fn display_name(path: &Path) -> String {
    use objc2_foundation::NSFileManager;
    let fm = unsafe { NSFileManager::defaultManager() };
    let name =
        unsafe { fm.displayNameAtPath(&NSString::from_str(&path.to_string_lossy())) }.to_string();
    if name.is_empty() {
        path.file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default()
    } else {
        name
    }
}

/// FDA can't be requested programmatically — probe TCC-gated paths instead.
/// Readable ⇒ we have Full Disk Access.
pub fn probe_full_disk_access() -> bool {
    let home = std::env::var("HOME").unwrap_or_default();
    let gated = [
        format!("{home}/Library/Safari"),
        "/Library/Application Support/com.apple.TCC".to_string(),
    ];
    gated.iter().any(|p| std::fs::read_dir(p).is_ok())
}
