//! System Trash via NSFileManager — Finder's "Put Back" works, and the
//! resulting URL enables undo. Never `rm`.
//! NSFileManager is documented thread-safe; no main-thread marshal needed.

// objc2 versions move methods between safe/unsafe; keep defensive `unsafe`
// blocks without churning every call site on upgrades.
#![allow(unused_unsafe)]

use std::io;
use std::path::{Path, PathBuf};

use objc2_foundation::{NSFileManager, NSString, NSURL};

use crate::core::walker::Trasher;

pub fn trash_path(path: &Path) -> io::Result<PathBuf> {
    let fm = unsafe { NSFileManager::defaultManager() };
    let url = unsafe { NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy())) };
    let mut resulting: Option<objc2::rc::Retained<NSURL>> = None;
    let outcome = unsafe { fm.trashItemAtURL_resultingItemURL_error(&url, Some(&mut resulting)) };
    match outcome {
        Ok(()) => {
            let landed = resulting
                .and_then(|u| unsafe { u.path() }.map(|p| PathBuf::from(p.to_string())))
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::Other, "trash succeeded but no resulting URL")
                })?;
            Ok(landed)
        }
        Err(e) => Err(io::Error::new(
            io::ErrorKind::Other,
            format!("couldn't move to Trash: {}", e.localizedDescription()),
        )),
    }
}

/// The production `Trasher` for the ops engine.
pub struct SystemTrasher;

impl Trasher for SystemTrasher {
    fn trash(&self, path: &Path) -> io::Result<PathBuf> {
        trash_path(path)
    }
}
