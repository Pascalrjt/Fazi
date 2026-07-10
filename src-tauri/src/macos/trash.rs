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

// ---------------------------------------------------------------------------
// Empty Trash
// ---------------------------------------------------------------------------
//
// There is no public API that empties the Trash; AppleScript via Finder adds
// a TCC prompt and offers no progress. Fazi is unsandboxed with FDA
// onboarding, so direct removal per top-level item is the honest option.
// Trade-off (documented): Finder's "Put Back" metadata is not consulted.

/// The current user's Trash directories: `~/.Trash` plus
/// `/Volumes/*/.Trashes/<uid>` for mounted volumes that have one.
pub fn user_trash_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        let t = PathBuf::from(home).join(".Trash");
        if t.is_dir() {
            dirs.push(t);
        }
    }
    let uid = unsafe { libc::getuid() };
    if let Ok(rd) = std::fs::read_dir("/Volumes") {
        for e in rd.flatten() {
            // Skip the boot-volume symlink (its trash is ~/.Trash above).
            if e.path().symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false) {
                continue;
            }
            let t = e.path().join(".Trashes").join(uid.to_string());
            if t.is_dir() {
                dirs.push(t);
            }
        }
    }
    dirs
}

/// Top-level items of one trash dir (never recurses — an item is deleted
/// whole, and the count matches what the user sees in the Trash).
pub fn trash_items(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            // .DS_Store isn't a trashed item; deleting it is pointless churn.
            if e.file_name().to_string_lossy() == ".DS_Store" {
                continue;
            }
            out.push(e.path());
        }
    }
    out
}

pub struct EmptyTrashOutcome {
    /// Top-level paths successfully deleted (drives undo-history purging
    /// even when the run finishes partially).
    pub deleted: Vec<PathBuf>,
    pub errors: Vec<(PathBuf, io::Error)>,
}

/// Permanently delete every top-level item in `dirs`, reporting progress via
/// `on_progress(deleted_so_far, total)` and collecting per-item errors.
pub fn empty_trash_dirs(
    dirs: &[PathBuf],
    on_progress: &mut dyn FnMut(u64, u64),
    cancel: &std::sync::atomic::AtomicBool,
) -> EmptyTrashOutcome {
    let items: Vec<PathBuf> = dirs.iter().flat_map(|d| trash_items(d)).collect();
    let total = items.len() as u64;
    let mut outcome = EmptyTrashOutcome { deleted: Vec::new(), errors: Vec::new() };
    on_progress(0, total);
    for item in items {
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            break;
        }
        let result = match item.symlink_metadata() {
            Ok(m) if m.is_dir() && !m.file_type().is_symlink() => std::fs::remove_dir_all(&item),
            Ok(_) => std::fs::remove_file(&item),
            Err(e) => Err(e),
        };
        match result {
            Ok(()) => {
                outcome.deleted.push(item);
                on_progress(outcome.deleted.len() as u64, total);
            }
            Err(e) => outcome.errors.push((item, e)),
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::AtomicBool;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fazi-trash-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn empty_trash_dirs_deletes_and_reports_progress() {
        let d = tmp("empty");
        let t1 = d.join("t1");
        let t2 = d.join("t2");
        fs::create_dir_all(t1.join("folder/sub")).unwrap();
        fs::write(t1.join("folder/sub/x.txt"), b"x").unwrap();
        fs::write(t1.join("a.txt"), b"a").unwrap();
        fs::write(t1.join(".DS_Store"), b"ds").unwrap();
        fs::create_dir_all(&t2).unwrap();
        fs::write(t2.join("b.txt"), b"b").unwrap();

        let mut progress: Vec<(u64, u64)> = Vec::new();
        let outcome = empty_trash_dirs(
            &[t1.clone(), t2.clone()],
            &mut |done, total| progress.push((done, total)),
            &AtomicBool::new(false),
        );
        assert_eq!(outcome.deleted.len(), 3, "{:?}", outcome.deleted);
        assert!(outcome.errors.is_empty());
        assert!(!t1.join("folder").exists());
        assert!(!t1.join("a.txt").exists());
        assert!(!t2.join("b.txt").exists());
        // .DS_Store is not a trashed item.
        assert!(t1.join(".DS_Store").exists());
        assert_eq!(progress.first(), Some(&(0, 3)));
        assert_eq!(progress.last(), Some(&(3, 3)));
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn empty_trash_dirs_collects_per_item_errors_and_continues() {
        let d = tmp("emptyerr");
        let t = d.join("t");
        fs::create_dir_all(&t).unwrap();
        fs::write(t.join("a.txt"), b"a").unwrap();
        // A dangling symlink whose target vanished mid-run still deletes fine,
        // so simulate an unremovable entry with a dir made read-only after
        // populating it (remove_dir_all fails on the child unlink).
        let locked = t.join("locked");
        fs::create_dir_all(&locked).unwrap();
        fs::write(locked.join("inner.txt"), b"i").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();

        let outcome =
            empty_trash_dirs(&[t.clone()], &mut |_, _| {}, &AtomicBool::new(false));
        // Restore perms for cleanup regardless of assertion outcomes.
        let _ = fs::set_permissions(&locked, fs::Permissions::from_mode(0o755));

        assert!(outcome.deleted.iter().any(|p| p.ends_with("a.txt")));
        assert_eq!(outcome.errors.len(), 1, "{:?}", outcome.errors);
        assert!(outcome.errors[0].0.ends_with("locked"));
        fs::remove_dir_all(&d).ok();
    }
}
