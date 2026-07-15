//! Mounted volumes via NSFileManager + NSURL volume resource keys.
//! Mount/unmount detection: NSWorkspace notification observers for instant
//! updates, plus a 2 s poll of the volume path set as a fallback.

// objc2 versions move methods between safe/unsafe; keep defensive `unsafe`
// blocks without churning every call site on upgrades.
#![allow(unused_unsafe)]

use std::path::PathBuf;

use objc2_foundation::{
    NSArray, NSFileManager, NSNumber, NSString, NSVolumeEnumerationOptions,
};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    pub name: String,
    pub path: String,
    pub is_removable: bool,
    pub is_ejectable: bool,
    pub is_root: bool,
    pub total_bytes: Option<u64>,
    pub available_bytes: Option<u64>,
}

/// MUST run on the main thread (resource-value fetches are cheap but AppKit-adjacent).
pub fn list_volumes() -> Vec<Volume> {
    let fm = unsafe { NSFileManager::defaultManager() };

    let key_name = unsafe { objc2_foundation::NSURLVolumeLocalizedNameKey };
    let key_removable = unsafe { objc2_foundation::NSURLVolumeIsRemovableKey };
    let key_ejectable = unsafe { objc2_foundation::NSURLVolumeIsEjectableKey };
    let key_total = unsafe { objc2_foundation::NSURLVolumeTotalCapacityKey };
    let key_avail = unsafe { objc2_foundation::NSURLVolumeAvailableCapacityKey };
    let key_browsable = unsafe { objc2_foundation::NSURLVolumeIsBrowsableKey };
    let keys = NSArray::from_slice(&[
        key_name,
        key_removable,
        key_ejectable,
        key_total,
        key_avail,
        key_browsable,
    ]);

    let urls = unsafe {
        fm.mountedVolumeURLsIncludingResourceValuesForKeys_options(
            Some(&keys),
            NSVolumeEnumerationOptions::SkipHiddenVolumes,
        )
    };
    let Some(urls) = urls else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for url in urls.iter() {
        let Some(path) = (unsafe { url.path() }) else {
            continue;
        };
        let path = path.to_string();
        let values = unsafe { url.resourceValuesForKeys_error(&keys) };
        let Ok(values) = values else {
            continue;
        };

        let get_bool = |key: &NSString| -> bool {
            values
                .objectForKey(key)
                .and_then(|v| v.downcast::<NSNumber>().ok())
                .map(|n| n.boolValue())
                .unwrap_or(false)
        };
        let get_u64 = |key: &NSString| -> Option<u64> {
            values
                .objectForKey(key)
                .and_then(|v| v.downcast::<NSNumber>().ok())
                .map(|n| n.unsignedLongLongValue())
        };

        if !get_bool(key_browsable) {
            continue;
        }
        let name = values
            .objectForKey(key_name)
            .and_then(|v| v.downcast::<NSString>().ok())
            .map(|s| s.to_string())
            .unwrap_or_else(|| path.clone());

        out.push(Volume {
            is_root: path == "/",
            name,
            is_removable: get_bool(key_removable),
            is_ejectable: get_bool(key_ejectable),
            total_bytes: get_u64(key_total),
            available_bytes: get_u64(key_avail),
            path,
        });
    }
    // Root first, then alphabetical.
    out.sort_by(|a, b| b.is_root.cmp(&a.is_root).then(a.name.cmp(&b.name)));
    out
}

/// Install NSWorkspace mount/unmount/rename observers that fire `on_change`
/// the instant a volume set change is posted (the 2 s poll stays as a
/// fallback for mounts that post no workspace notification). MUST run on the
/// main thread. Observers live for the app's lifetime — their tokens are
/// intentionally leaked; dropping one would silently unregister it.
pub fn install_mount_observers(on_change: impl Fn() + Send + Sync + 'static) {
    use block2::RcBlock;
    use objc2_app_kit::{
        NSWorkspace, NSWorkspaceDidMountNotification, NSWorkspaceDidRenameVolumeNotification,
        NSWorkspaceDidUnmountNotification,
    };
    use objc2_foundation::NSNotification;
    use std::ptr::NonNull;
    use std::sync::Arc;

    let on_change = Arc::new(on_change);
    let center = unsafe { NSWorkspace::sharedWorkspace().notificationCenter() };
    let names = [
        unsafe { NSWorkspaceDidMountNotification },
        unsafe { NSWorkspaceDidUnmountNotification },
        unsafe { NSWorkspaceDidRenameVolumeNotification },
    ];
    for name in names {
        let cb = on_change.clone();
        let block = RcBlock::new(move |_: NonNull<NSNotification>| cb());
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block)
        };
        std::mem::forget(token);
    }
}

/// Cheap poll-key: the set of mounted volume paths (no AppKit needed).
pub fn volume_paths_snapshot() -> Vec<PathBuf> {
    let mut out = vec![PathBuf::from("/")];
    if let Ok(rd) = std::fs::read_dir("/Volumes") {
        for e in rd.flatten() {
            out.push(e.path());
        }
    }
    out.sort();
    out
}
