//! Real macOS pasteboard interop, bidirectional: Fazi copies paste anywhere,
//! and files copied in Finder (or any app) paste into Fazi.
//!
//! Cut semantics: NSPasteboard has no native "cut" — Fazi remembers the
//! changeCount of its own writes; if the pasteboard's changeCount moved on,
//! another app wrote it and the cut marker no longer applies.
//! All functions MUST run on the main thread.

// objc2 versions move methods between safe/unsafe; keep defensive `unsafe`
// blocks without churning every call site on upgrades.
#![allow(unused_unsafe)]

use std::path::{Path, PathBuf};

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::ClassType;
use objc2_app_kit::{NSPasteboard, NSPasteboardURLReadingFileURLsOnlyKey};
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString, NSURL};

/// Write file URLs to the general pasteboard. Returns the new changeCount.
pub fn write_files(paths: &[PathBuf]) -> isize {
    let pb = unsafe { NSPasteboard::generalPasteboard() };
    let change = unsafe { pb.clearContents() };
    let urls: Vec<Retained<NSURL>> = paths
        .iter()
        .map(|p| unsafe { NSURL::fileURLWithPath(&NSString::from_str(&p.to_string_lossy())) })
        .collect();
    let writers: Vec<&ProtocolObject<dyn objc2_app_kit::NSPasteboardWriting>> = urls
        .iter()
        .map(|u| {
            let r: &NSURL = u;
            ProtocolObject::from_ref(r)
        })
        .collect();
    let array = NSArray::from_slice(&writers);
    unsafe { pb.writeObjects(&array) };
    change
}

/// Write plain text (Copy as Pathname). Returns the new changeCount.
pub fn write_text(text: &str) -> isize {
    let pb = unsafe { NSPasteboard::generalPasteboard() };
    let change = unsafe { pb.clearContents() };
    let s = NSString::from_str(text);
    let s_ref: &NSString = &s;
    let writers: Vec<&ProtocolObject<dyn objc2_app_kit::NSPasteboardWriting>> =
        vec![ProtocolObject::from_ref(s_ref)];
    let array = NSArray::from_slice(&writers);
    unsafe { pb.writeObjects(&array) };
    change
}

pub fn change_count() -> isize {
    let pb = unsafe { NSPasteboard::generalPasteboard() };
    unsafe { pb.changeCount() }
}

/// Read file URLs from the general pasteboard (from any app).
pub fn read_files() -> Vec<PathBuf> {
    let pb = unsafe { NSPasteboard::generalPasteboard() };
    let classes = NSArray::from_slice(&[NSURL::class()]);
    let key = unsafe { NSPasteboardURLReadingFileURLsOnlyKey };
    let options: Retained<NSDictionary<NSString, objc2::runtime::AnyObject>> = unsafe {
        NSDictionary::from_slices(
            &[key],
            &[NSNumber::new_bool(true).as_ref() as &objc2::runtime::AnyObject],
        )
    };
    let objects = unsafe { pb.readObjectsForClasses_options(&classes, Some(&options)) };
    let mut out = Vec::new();
    if let Some(objects) = objects {
        for obj in objects.iter() {
            if let Ok(url) = obj.downcast::<NSURL>() {
                if let Some(p) = unsafe { url.path() } {
                    out.push(PathBuf::from(p.to_string()));
                }
            }
        }
    }
    out
}

/// Filter to paths that still exist (pasteboards can hold stale URLs).
pub fn existing(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    paths
        .into_iter()
        .filter(|p: &PathBuf| Path::new(p).symlink_metadata().is_ok())
        .collect()
}
