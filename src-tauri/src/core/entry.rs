//! The `Entry` data contract — mirrors `src/types/ipc.ts` (manual lockstep).

use std::os::macos::fs::MetadataExt as MacMetadataExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::core::tags::{read_tags, FinderTag};

/// BSD stat st_flags bits we care about.
pub const UF_HIDDEN: u32 = 0x0000_8000;
pub const SF_DATALESS: u32 = 0x4000_0000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: u64,
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub hidden: bool,
    /// Opaque token for icon:// and thumb:// — never a raw path.
    pub icon: String,
    pub ext: String,

    pub hydrated: bool,
    pub size: Option<u64>,
    pub mtime: Option<i64>,
    pub btime: Option<i64>,
    pub is_package: bool,
    pub is_alias: bool,
    pub link_target: Option<String>,
    pub tags: Vec<FinderTag>,
    pub no_access: bool,
}

/// Extensions treated as packages without asking NSWorkspace (fast path).
const PACKAGE_EXTS: &[&str] = &[
    "app", "bundle", "framework", "plugin", "kext", "prefpane", "qlgenerator", "xpc", "appex",
    "photoslibrary", "musiclibrary", "tvlibrary", "fcpbundle", "imovielibrary", "theater",
    "logicx", "band", "pkg", "mpkg", "playground", "xcodeproj", "xcworkspace", "scptd",
    "rtfd", "pages", "numbers", "key", "sketch", "textbundle", "download",
];

pub fn ext_of(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => ext.to_ascii_lowercase(),
        _ => String::new(),
    }
}

pub fn is_package_ext(ext: &str) -> bool {
    PACKAGE_EXTS.contains(&ext)
}

/// Build a pass-1 entry from what readdir gives us for free.
/// `d_kind` is the d_type hint (Unknown on network/foreign filesystems).
pub fn pass1_entry(id: u64, dir: &Path, file_name: &str, d_kind: EntryKind, token: String) -> Entry {
    let ext = ext_of(file_name);
    Entry {
        id,
        name: file_name.to_string(),
        path: dir.join(file_name).to_string_lossy().into_owned(),
        kind: d_kind,
        hidden: file_name.starts_with('.'),
        icon: token,
        ext: ext.clone(),
        hydrated: false,
        size: None,
        mtime: None,
        btime: None,
        is_package: d_kind == EntryKind::Dir && is_package_ext(&ext),
        is_alias: false,
        link_target: None,
        tags: Vec::new(),
        no_access: false,
    }
}

/// FinderInfo xattr flag bits (finderFlags is a big-endian u16 at offset 8).
const K_IS_ALIAS: u16 = 0x8000;
const K_HAS_CUSTOM_ICON: u16 = 0x0400;
const K_IS_INVISIBLE: u16 = 0x4000;

fn finder_flags(path: &Path) -> u16 {
    match xattr::get(path, "com.apple.FinderInfo") {
        Ok(Some(data)) if data.len() >= 10 => u16::from_be_bytes([data[8], data[9]]),
        _ => 0,
    }
}

pub fn has_custom_icon(path: &Path) -> bool {
    finder_flags(path) & K_HAS_CUSTOM_ICON != 0
}

/// Hydrate an entry in place (pass 2). Cheap syscalls only — the NSWorkspace
/// package check for ambiguous dirs is batched separately by the caller.
/// Returns true when the dir needs an NSWorkspace `isFilePackageAtPath` check.
pub fn hydrate(entry: &mut Entry) -> bool {
    let path = PathBuf::from(&entry.path);

    let meta = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(_) => {
            // Vanished between passes — mark hydrated so the shimmer stops.
            entry.hydrated = true;
            return false;
        }
    };

    let ft = meta.file_type();
    entry.kind = if ft.is_symlink() {
        EntryKind::Symlink
    } else if ft.is_dir() {
        EntryKind::Dir
    } else {
        EntryKind::File
    };

    entry.size = if ft.is_dir() { None } else { Some(meta.len()) };
    entry.mtime = Some(meta.mtime() * 1000 + meta.mtime_nsec() / 1_000_000);
    entry.btime = Some(meta.st_birthtime() * 1000 + meta.st_birthtime_nsec() / 1_000_000);

    let flags = meta.st_flags();
    let fflags = finder_flags(&path);
    entry.hidden = entry.name.starts_with('.')
        || flags & UF_HIDDEN != 0
        || fflags & K_IS_INVISIBLE != 0;

    if entry.kind == EntryKind::Symlink {
        entry.link_target = std::fs::read_link(&path)
            .ok()
            .map(|t| t.to_string_lossy().into_owned());
    }

    // Finder aliases: regular files with the kIsAlias Finder flag.
    entry.is_alias = entry.kind == EntryKind::File && fflags & K_IS_ALIAS != 0;

    entry.tags = read_tags(&path);

    let mut needs_pkg_check = false;
    if entry.kind == EntryKind::Dir {
        if is_package_ext(&entry.ext) {
            entry.is_package = true;
        } else if !entry.ext.is_empty() {
            needs_pkg_check = true; // ambiguous: dir with an extension
        }
        // Readability probe for dirs (renders the lock badge).
        entry.no_access = !is_readable_dir(&path);
    }

    entry.hydrated = true;
    needs_pkg_check
}

fn is_readable_dir(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    unsafe { libc::access(c.as_ptr(), libc::R_OK | libc::X_OK) == 0 }
}

/// Check whether a file is dataless (content not local, e.g. evicted by a
/// file provider) — copying one yields a per-item error.
pub fn is_dataless(meta: &std::fs::Metadata) -> bool {
    meta.st_flags() & SF_DATALESS != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ext_extraction() {
        assert_eq!(ext_of("foo.TXT"), "txt");
        assert_eq!(ext_of("archive.tar.gz"), "gz");
        assert_eq!(ext_of(".hidden"), ""); // dotfile, not an extension
        assert_eq!(ext_of("noext"), "");
        assert_eq!(ext_of(".config.json"), "json");
    }

    #[test]
    fn pass1_dotfile_hidden() {
        let e = pass1_entry(1, Path::new("/tmp"), ".zshrc", EntryKind::File, "t".into());
        assert!(e.hidden);
        assert_eq!(e.ext, ""); // ".zshrc" is a dotfile, not an extension
    }

    #[test]
    fn package_ext_fast_path() {
        let e = pass1_entry(1, Path::new("/Applications"), "Safari.app", EntryKind::Dir, "t".into());
        assert!(e.is_package);
    }

    #[test]
    fn hydrate_real_file() {
        let dir = std::env::temp_dir().join(format!("fazi-entry-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("hello.txt");
        std::fs::write(&f, b"hello").unwrap();
        let mut e = pass1_entry(1, &dir, "hello.txt", EntryKind::Unknown, "t".into());
        let needs_pkg = hydrate(&mut e);
        assert!(!needs_pkg);
        assert_eq!(e.kind, EntryKind::File);
        assert_eq!(e.size, Some(5));
        assert!(e.hydrated);
        assert!(e.mtime.is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn hydrate_symlink() {
        let dir = std::env::temp_dir().join(format!("fazi-entry-link-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("target.txt");
        std::fs::write(&target, b"x").unwrap();
        let link = dir.join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let mut e = pass1_entry(1, &dir, "link", EntryKind::Unknown, "t".into());
        hydrate(&mut e);
        assert_eq!(e.kind, EntryKind::Symlink);
        assert_eq!(e.link_target, Some(target.to_string_lossy().into_owned()));
        std::fs::remove_dir_all(&dir).ok();
    }
}
