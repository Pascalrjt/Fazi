//! Auto-cleanup: per-folder "move to Trash N days after it arrived" rules.
//!
//! Pure scan logic lives here, parameterized on `now` so tests don't depend
//! on the clock. The command layer (`commands/cleanup.rs`) trashes what the
//! scan marks due. Only a rule folder's top-level items are considered;
//! nothing below them is inspected or touched.
//!
//! Age is measured from Date Added (`ATTR_CMN_ADDEDTIME`), the moment an item
//! arrived in its folder: downloads keep the server's mtime and unzipped
//! files keep their archived dates, so mtime would trash a fresh download.

use std::os::macos::fs::MetadataExt as MacMetadataExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::core::entry::UF_HIDDEN;

pub const DAY_MS: i64 = 86_400_000;

/// Written by LaunchServices whenever a document is opened (what Finder's
/// "Last opened" reads): 16 bytes, `tv_sec` then `tv_nsec`, little-endian.
const LAST_USED_XATTR: &str = "com.apple.lastuseddate#PS";

/// Suffixes of downloads still in flight (Safari, Chrome, Firefox, Opera).
const IN_PROGRESS_EXTS: &[&str] = &["download", "crdownload", "part", "partial", "opdownload"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupRule {
    /// Absolute, or `~`-relative (the default rule is `~/Downloads`).
    pub path: String,
    pub days: u32,
}

/// A user-kept item, identified by inode so it survives renames in place.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupPin {
    pub dev: u64,
    pub ino: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupOptions {
    pub rules: Vec<CleanupRule>,
    pub pins: Vec<CleanupPin>,
    /// Files opened within this many days stay until the window passes; 0 = off.
    pub skip_opened_days: u32,
    /// Name of a top-level subfolder that is never touched; "" = none.
    pub keep_folder: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemStatus {
    Scheduled,
    Kept,
    Excluded,
    InProgress,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupItem {
    pub path: String,
    pub name: String,
    pub dev: u64,
    pub ino: u64,
    pub is_dir: bool,
    /// Bytes for files; null for folders (not walked).
    pub size: Option<u64>,
    /// Date Added, epoch ms.
    pub added: i64,
    /// Last opened, epoch ms, when LaunchServices recorded one.
    pub last_used: Option<i64>,
    /// When the item becomes due, epoch ms. Set for `Scheduled` items only.
    pub expires: Option<i64>,
    pub status: ItemStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderReport {
    /// The rule's path exactly as configured (the frontend's key).
    pub rule_path: String,
    /// Absolute folder path after `~` expansion.
    pub folder: String,
    pub days: u32,
    pub items: Vec<CleanupItem>,
    pub error: Option<String>,
}

pub fn expand_tilde(path: &str) -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    if path == "~" {
        PathBuf::from(home)
    } else if let Some(rest) = path.strip_prefix("~/") {
        Path::new(&home).join(rest)
    } else {
        PathBuf::from(path)
    }
}

/// Folders a rule may never target: the filesystem root, the home folder and
/// its ancestors, and system locations whose top-level items are all old.
pub fn refusal_reason(folder: &Path, home: &Path) -> Option<&'static str> {
    if !folder.is_absolute() {
        return Some("Use an absolute folder path.");
    }
    if home.starts_with(folder) {
        return Some("Fazi won't clean up your home folder or anything above it.");
    }
    let protected = [
        PathBuf::from("/Applications"),
        PathBuf::from("/Library"),
        PathBuf::from("/System"),
        PathBuf::from("/Users"),
        PathBuf::from("/Volumes"),
        home.join("Library"),
        home.join(".Trash"),
    ];
    if protected.iter().any(|p| folder == p) {
        return Some("Fazi won't clean up this system folder.");
    }
    None
}

fn is_in_progress(name: &str) -> bool {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => {
            IN_PROGRESS_EXTS.iter().any(|e| ext.eq_ignore_ascii_case(e))
        }
        _ => false,
    }
}

fn ms(secs: i64, nsec: i64) -> i64 {
    secs * 1000 + nsec / 1_000_000
}

/// Date Added via getattrlist; None where the filesystem doesn't track it.
fn added_time(path: &Path) -> Option<i64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    #[repr(C)]
    struct Buf {
        length: u32,
        returned: libc::attribute_set_t,
        added: libc::timespec,
    }

    let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut list: libc::attrlist = unsafe { std::mem::zeroed() };
    list.bitmapcount = libc::ATTR_BIT_MAP_COUNT;
    list.commonattr = libc::ATTR_CMN_RETURNED_ATTRS | libc::ATTR_CMN_ADDEDTIME;
    let mut buf: Buf = unsafe { std::mem::zeroed() };
    // SAFETY: `buf` is a plain-old-data buffer sized for the requested
    // attributes; getattrlist writes at most `size_of::<Buf>()` bytes.
    let rc = unsafe {
        libc::getattrlist(
            c_path.as_ptr(),
            &mut list as *mut libc::attrlist as *mut libc::c_void,
            &mut buf as *mut Buf as *mut libc::c_void,
            std::mem::size_of::<Buf>(),
            libc::FSOPT_NOFOLLOW,
        )
    };
    if rc != 0 || buf.returned.commonattr & libc::ATTR_CMN_ADDEDTIME == 0 {
        return None;
    }
    Some(ms(buf.added.tv_sec, buf.added.tv_nsec))
}

fn last_used_time(path: &Path) -> Option<i64> {
    let raw = xattr::get(path, LAST_USED_XATTR).ok().flatten()?;
    if raw.len() < 16 {
        return None;
    }
    let secs = i64::from_le_bytes(raw[0..8].try_into().ok()?);
    let nsec = i64::from_le_bytes(raw[8..16].try_into().ok()?);
    Some(ms(secs, nsec))
}

/// When a scheduled item becomes due: `days` after it was added, or, if it
/// was opened recently, `skip_opened_days` after it was last opened.
pub fn expiry(added: i64, last_used: Option<i64>, days: u32, skip_opened_days: u32) -> i64 {
    let by_age = added + i64::from(days) * DAY_MS;
    match last_used {
        Some(used) if skip_opened_days > 0 => by_age.max(used + i64::from(skip_opened_days) * DAY_MS),
        _ => by_age,
    }
}

/// Scan one rule folder's top-level items. Hidden items (dotfiles and
/// UF_HIDDEN, e.g. `.DS_Store`, `.localized`, Fazi's own staging) are left
/// out entirely.
pub fn scan_folder(rule: &CleanupRule, opts: &CleanupOptions) -> FolderReport {
    let folder = expand_tilde(&rule.path);
    let mut report = FolderReport {
        rule_path: rule.path.clone(),
        folder: folder.to_string_lossy().into_owned(),
        days: rule.days,
        items: Vec::new(),
        error: None,
    };
    let home = expand_tilde("~");
    if let Some(reason) = refusal_reason(&folder, &home) {
        report.error = Some(reason.into());
        return report;
    }
    if rule.days == 0 {
        report.error = Some("The rule needs at least 1 day.".into());
        return report;
    }
    let read = match std::fs::read_dir(&folder) {
        Ok(r) => r,
        Err(e) => {
            report.error = Some(e.to_string());
            return report;
        }
    };
    for dirent in read.flatten() {
        let name = dirent.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = dirent.path();
        let Ok(meta) = path.symlink_metadata() else { continue };
        if meta.st_flags() & UF_HIDDEN != 0 {
            continue;
        }
        let is_dir = meta.is_dir();
        let dev = meta.dev();
        let ino = meta.ino();
        let added = added_time(&path)
            .or_else(|| Some(ms(meta.st_birthtime(), meta.st_birthtime_nsec())))
            .unwrap_or_else(|| ms(meta.mtime(), meta.mtime_nsec()));
        let last_used = last_used_time(&path);
        let status = if is_dir && !opts.keep_folder.is_empty() && name == opts.keep_folder {
            ItemStatus::Excluded
        } else if opts.pins.iter().any(|p| p.dev == dev && p.ino == ino) {
            ItemStatus::Kept
        } else if is_in_progress(&name) {
            ItemStatus::InProgress
        } else {
            ItemStatus::Scheduled
        };
        let expires = (status == ItemStatus::Scheduled)
            .then(|| expiry(added, last_used, rule.days, opts.skip_opened_days));
        report.items.push(CleanupItem {
            path: path.to_string_lossy().into_owned(),
            name,
            dev,
            ino,
            is_dir,
            size: (!is_dir).then_some(meta.len()),
            added,
            last_used,
            expires,
            status,
        });
    }
    report
}

pub fn scan(opts: &CleanupOptions) -> Vec<FolderReport> {
    opts.rules.iter().map(|r| scan_folder(r, opts)).collect()
}

/// Scheduled items whose expiry has passed.
pub fn due_items(reports: &[FolderReport], now: i64) -> Vec<&CleanupItem> {
    reports
        .iter()
        .flat_map(|r| r.items.iter())
        .filter(|i| i.status == ItemStatus::Scheduled && i.expires.is_some_and(|e| e <= now))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fazi-cleanup-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn opts(folder: &Path, days: u32) -> CleanupOptions {
        CleanupOptions {
            rules: vec![CleanupRule { path: folder.to_string_lossy().into_owned(), days }],
            pins: Vec::new(),
            skip_opened_days: 3,
            keep_folder: "Keep".into(),
        }
    }

    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    #[test]
    fn expiry_uses_the_later_of_age_and_recent_use() {
        assert_eq!(expiry(0, None, 10, 3), 10 * DAY_MS);
        // Opened on day 9: stays until day 12.
        assert_eq!(expiry(0, Some(9 * DAY_MS), 10, 3), 12 * DAY_MS);
        // Opened long ago: the age rule wins.
        assert_eq!(expiry(0, Some(DAY_MS), 10, 3), 10 * DAY_MS);
        // Skip disabled: last use is ignored.
        assert_eq!(expiry(0, Some(9 * DAY_MS), 10, 0), 10 * DAY_MS);
    }

    #[test]
    fn classifies_top_level_items() {
        let d = tmp("classify");
        fs::write(d.join("installer.dmg"), b"x").unwrap();
        fs::write(d.join("movie.mp4.crdownload"), b"x").unwrap();
        fs::write(d.join(".DS_Store"), b"x").unwrap();
        fs::create_dir_all(d.join("Keep/inner")).unwrap();
        fs::create_dir_all(d.join("unzipped")).unwrap();
        fs::write(d.join("unzipped/old.txt"), b"x").unwrap();

        let report = scan_folder(&opts(&d, 10).rules[0], &opts(&d, 10));
        assert!(report.error.is_none());
        let status = |n: &str| report.items.iter().find(|i| i.name == n).map(|i| i.status);
        assert_eq!(status("installer.dmg"), Some(ItemStatus::Scheduled));
        assert_eq!(status("movie.mp4.crdownload"), Some(ItemStatus::InProgress));
        assert_eq!(status("Keep"), Some(ItemStatus::Excluded));
        assert_eq!(status("unzipped"), Some(ItemStatus::Scheduled));
        assert_eq!(status(".DS_Store"), None, "hidden items are left out");
        assert_eq!(status("old.txt"), None, "only top-level items are scanned");
        assert_eq!(report.items.len(), 4);
    }

    #[test]
    fn fresh_items_are_not_due_and_expire_after_the_rule() {
        let d = tmp("fresh");
        fs::write(d.join("a.pdf"), b"x").unwrap();
        let o = opts(&d, 10);
        let reports = scan(&o);
        let item = &reports[0].items[0];
        let added = item.added;
        assert!(added_time(&d.join("a.pdf")).is_some(), "APFS reports Date Added");
        assert!((now_ms() - added).abs() < 60_000, "Date Added is roughly now");
        assert_eq!(item.expires, Some(added + 10 * DAY_MS));
        assert!(due_items(&reports, now_ms()).is_empty());
        assert_eq!(due_items(&reports, added + 10 * DAY_MS).len(), 1);
    }

    #[test]
    fn pins_match_by_inode_across_renames() {
        let d = tmp("pins");
        fs::write(d.join("a.pdf"), b"x").unwrap();
        let meta = fs::metadata(d.join("a.pdf")).unwrap();
        fs::rename(d.join("a.pdf"), d.join("b.pdf")).unwrap();
        let mut o = opts(&d, 1);
        o.pins.push(CleanupPin { dev: meta.dev(), ino: meta.ino() });
        let reports = scan(&o);
        assert_eq!(reports[0].items[0].status, ItemStatus::Kept);
        assert_eq!(reports[0].items[0].expires, None);
        assert!(due_items(&reports, i64::MAX).is_empty());
    }

    #[test]
    fn refuses_home_root_and_system_folders() {
        let home = PathBuf::from("/Users/me");
        for bad in ["/", "/Users", "/Users/me", "/Applications", "/Users/me/Library"] {
            assert!(refusal_reason(Path::new(bad), &home).is_some(), "{bad}");
        }
        for ok in ["/Users/me/Downloads", "/Users/me/Desktop/Screenshots", "/Volumes/Disk/tmp"] {
            assert!(refusal_reason(Path::new(ok), &home).is_none(), "{ok}");
        }
    }

    #[test]
    fn expands_tilde() {
        let home = std::env::var("HOME").unwrap();
        assert_eq!(expand_tilde("~/Downloads"), Path::new(&home).join("Downloads"));
        assert_eq!(expand_tilde("/tmp/x"), PathBuf::from("/tmp/x"));
    }

    #[test]
    fn missing_folder_reports_an_error() {
        let d = tmp("missing").join("nope");
        let reports = scan(&opts(&d, 5));
        assert!(reports[0].error.is_some());
        assert!(reports[0].items.is_empty());
    }
}
