//! iCloud integration: trigger downloads of placeholder (dataless) items.

// objc2 versions move methods between safe/unsafe; keep defensive `unsafe`
// blocks without churning every call site on upgrades.
#![allow(unused_unsafe)]

use std::path::Path;

use objc2_foundation::{NSFileManager, NSString, NSURL};

/// Kick off a download for a non-local iCloud item. Thread-safe.
pub fn start_download(path: &Path) -> Result<(), String> {
    // For `.name.icloud` placeholder files, downloading targets the real name.
    let effective = crate::core::entry::icloud_placeholder_name(
        &path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
    )
    .map(|real| path.with_file_name(real))
    .unwrap_or_else(|| path.to_path_buf());

    let fm = unsafe { NSFileManager::defaultManager() };
    let url =
        unsafe { NSURL::fileURLWithPath(&NSString::from_str(&effective.to_string_lossy())) };
    unsafe { fm.startDownloadingUbiquitousItemAtURL_error(&url) }
        .map_err(|e| e.localizedDescription().to_string())
}

/// Path of the user's iCloud Drive root, if present.
pub fn icloud_drive_path() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let p = format!("{home}/Library/Mobile Documents/com~apple~CloudDocs");
    std::fs::metadata(&p).ok().map(|_| p)
}
