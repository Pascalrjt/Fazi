//! The `Entry` data contract — mirrors `src/types/ipc.ts` (manual lockstep).

use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::os::macos::fs::MetadataExt as MacMetadataExt;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::core::tags::{read_tags_c, FinderTag};

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
    /// Finder's custom-icon flag; such folders keep their own look rather
    /// than taking the accent tint.
    pub custom_icon: bool,
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
    let path = dir.join(file_name).to_string_lossy().into_owned();
    pass1_entry_owned(id, path, file_name.to_string(), d_kind, token)
}

/// `pass1_entry` without re-allocating: the caller already owns the joined
/// path and the name (the pass-1 hot loop).
pub fn pass1_entry_owned(
    id: u64,
    path: String,
    name: String,
    d_kind: EntryKind,
    token: String,
) -> Entry {
    let ext = ext_of(&name);
    Entry {
        id,
        hidden: name.starts_with('.'),
        is_package: d_kind == EntryKind::Dir && is_package_ext(&ext),
        name,
        path,
        kind: d_kind,
        icon: token,
        ext,
        hydrated: false,
        size: None,
        mtime: None,
        btime: None,
        is_alias: false,
        link_target: None,
        tags: Vec::new(),
        no_access: false,
        custom_icon: false,
    }
}

/// FinderInfo xattr flag bits (finderFlags is a big-endian u16 at offset 8).
const K_IS_ALIAS: u16 = 0x8000;
const K_IS_INVISIBLE: u16 = 0x4000;
/// The "package bit": NSWorkspace `isFilePackageAtPath:` answers true for
/// any directory carrying it, whatever its extension.
pub const K_HAS_BUNDLE: u16 = 0x2000;
const K_HAS_CUSTOM_ICON: u16 = 0x0400;

const FINDER_INFO: &CStr = c"com.apple.FinderInfo";

/// `getxattr(XATTR_NOFOLLOW)` into a caller buffer: ONE syscall (the xattr
/// crate probes the size first, then reads — two when the attribute exists).
/// Ok(len) on success, Err(errno) otherwise (ENOATTR, ERANGE, …).
pub fn getxattr_into(path: &CStr, name: &CStr, buf: &mut [u8]) -> Result<usize, i32> {
    let n = unsafe {
        libc::getxattr(
            path.as_ptr(),
            name.as_ptr(),
            buf.as_mut_ptr().cast(),
            buf.len(),
            0,
            libc::XATTR_NOFOLLOW,
        )
    };
    if n < 0 {
        Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(0))
    } else {
        Ok(n as usize)
    }
}

fn finder_flags_c(path: &CStr) -> u16 {
    // FinderInfo is exactly 32 bytes.
    let mut buf = [0u8; 32];
    match getxattr_into(path, FINDER_INFO, &mut buf) {
        Ok(n) if n >= 10 => u16::from_be_bytes([buf[8], buf[9]]),
        _ => 0,
    }
}

fn c_path(path: &Path) -> Option<CString> {
    use std::os::unix::ffi::OsStrExt;
    CString::new(path.as_os_str().as_bytes()).ok()
}

fn finder_flags(path: &Path) -> u16 {
    c_path(path).map(|c| finder_flags_c(&c)).unwrap_or(0)
}

pub fn has_custom_icon(path: &Path) -> bool {
    finder_flags(path) & K_HAS_CUSTOM_ICON != 0
}

// ---------------------------------------------------------------------------
// Package detection pre-check
// ---------------------------------------------------------------------------

/// `isFilePackageAtPath:` for a directory depends only on (a) the package
/// bit and (b) whether the extension's registered type conforms to
/// com.apple.package (case-insensitively; contents such as Contents/Info.plist
/// don't matter). Without the bit, the answer is therefore per extension —
/// cached here so only the first dir of each unknown extension pays the
/// main-thread trip. TTL bounds staleness when a newly installed app
/// registers a package type.
const PKG_EXT_TTL: Duration = Duration::from_secs(300);
const PKG_EXT_CAP: usize = 2048;

fn pkg_ext_cache() -> &'static Mutex<HashMap<String, (bool, Instant)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (bool, Instant)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Cached NSWorkspace answer for directories with extension `ext` (lowercase)
/// and no package bit.
pub fn cached_package_ext(ext: &str) -> Option<bool> {
    let cache = pkg_ext_cache().lock().ok()?;
    match cache.get(ext) {
        Some(&(v, at)) if at.elapsed() < PKG_EXT_TTL => Some(v),
        _ => None,
    }
}

/// Record a main-thread answer for a directory WITHOUT the package bit.
pub fn record_package_ext(ext: &str, is_package: bool) {
    if ext.is_empty() {
        return;
    }
    let Ok(mut cache) = pkg_ext_cache().lock() else {
        return;
    };
    if cache.len() >= PKG_EXT_CAP {
        cache.retain(|_, (_, at)| at.elapsed() < PKG_EXT_TTL);
        if cache.len() >= PKG_EXT_CAP {
            cache.clear();
        }
    }
    cache.insert(ext.to_string(), (is_package, Instant::now()));
}

/// Off-main package answer for a directory, when one is possible: known
/// package extension or package bit → true; no extension → false; otherwise
/// the per-extension cache. None = must ask NSWorkspace.
pub fn package_precheck(ext: &str, finder_flags: u16) -> Option<bool> {
    if is_package_ext(ext) || finder_flags & K_HAS_BUNDLE != 0 {
        return Some(true);
    }
    if ext.is_empty() {
        return Some(false);
    }
    cached_package_ext(ext)
}

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

/// Hydrate an entry in place (pass 2). Cheap syscalls only — the NSWorkspace
/// package check for ambiguous dirs is batched separately by the caller.
/// Returns true when the dir needs an NSWorkspace `isFilePackageAtPath` check.
pub fn hydrate(entry: &mut Entry) -> bool {
    match std::fs::symlink_metadata(&entry.path) {
        Ok(meta) => hydrate_with_meta(entry, &meta),
        Err(_) => {
            // Vanished between passes — mark hydrated so the shimmer stops.
            entry.hydrated = true;
            false
        }
    }
}

/// `hydrate` for callers that already hold the entry's lstat result (no
/// second lstat).
pub fn hydrate_with_meta(entry: &mut Entry, meta: &std::fs::Metadata) -> bool {
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

    // One C path for every per-entry syscall below.
    let cpath = CString::new(entry.path.as_bytes()).ok();
    let flags = meta.st_flags();
    let fflags = cpath.as_deref().map(finder_flags_c).unwrap_or(0);
    entry.hidden = entry.name.starts_with('.')
        || flags & UF_HIDDEN != 0
        || fflags & K_IS_INVISIBLE != 0;

    // Pass 1 already read the target for d_type symlinks.
    if entry.kind == EntryKind::Symlink && entry.link_target.is_none() {
        entry.link_target = std::fs::read_link(&entry.path)
            .ok()
            .map(|t| t.to_string_lossy().into_owned());
    }

    // Finder aliases: regular files with the kIsAlias Finder flag.
    entry.is_alias = entry.kind == EntryKind::File && fflags & K_IS_ALIAS != 0;
    entry.custom_icon = fflags & K_HAS_CUSTOM_ICON != 0;

    entry.tags = match &cpath {
        Some(c) => read_tags_c(c, Path::new(&entry.path)),
        None => Vec::new(),
    };

    let mut needs_pkg_check = false;
    if entry.kind == EntryKind::Dir {
        match package_precheck(&entry.ext, fflags) {
            Some(is_pkg) => entry.is_package = is_pkg,
            None => needs_pkg_check = true, // ambiguous: ask NSWorkspace
        }
        // Readability probe for dirs (renders the lock badge).
        entry.no_access = !cpath.as_deref().is_some_and(is_readable_dir);
    }

    entry.hydrated = true;
    needs_pkg_check
}

fn is_readable_dir(path: &CStr) -> bool {
    unsafe { libc::access(path.as_ptr(), libc::R_OK | libc::X_OK) == 0 }
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
    fn pass1_owned_matches_join() {
        let a = pass1_entry(3, Path::new("/tmp/x"), "a.TXT", EntryKind::File, "t".into());
        let b = pass1_entry_owned(3, "/tmp/x/a.TXT".into(), "a.TXT".into(), EntryKind::File, "t".into());
        assert_eq!((a.path, a.name, a.ext), (b.path, b.name, b.ext));
    }

    #[test]
    fn package_ext_fast_path() {
        let e = pass1_entry(1, Path::new("/Applications"), "Safari.app", EntryKind::Dir, "t".into());
        assert!(e.is_package);
    }

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("fazi-entry-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn hydrate_real_file() {
        let dir = tmpdir("test");
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
        let dir = tmpdir("link");
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

    #[test]
    fn hydrate_reads_finder_flags_and_tags_with_raw_getxattr() {
        let dir = tmpdir("flags");
        let f = dir.join("alias-ish");
        std::fs::write(&f, b"x").unwrap();
        let mut fi = vec![0u8; 32];
        fi[8] = 0xC4; // kIsAlias | kIsInvisible | kHasCustomIcon
        xattr::set(&f, "com.apple.FinderInfo", &fi).unwrap();
        crate::core::tags::write_tags(&f, &[FinderTag { name: "Red".into(), color: 6 }]).unwrap();
        let mut e = pass1_entry(1, &dir, "alias-ish", EntryKind::Unknown, "t".into());
        hydrate(&mut e);
        assert!(e.is_alias && e.hidden && e.custom_icon);
        assert_eq!(e.tags, vec![FinderTag { name: "Red".into(), color: 6 }]);
        assert!(has_custom_icon(&f));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn package_precheck_answers_off_main_when_possible() {
        assert_eq!(package_precheck("app", 0), Some(true));
        assert_eq!(package_precheck("", 0), Some(false));
        assert_eq!(package_precheck("", K_HAS_BUNDLE), Some(true));
        assert_eq!(package_precheck("fazi-unknown-ext-a", K_HAS_BUNDLE), Some(true));
        assert_eq!(package_precheck("fazi-unknown-ext-a", 0), None, "ambiguous until asked");
        record_package_ext("fazi-unknown-ext-a", false);
        assert_eq!(package_precheck("fazi-unknown-ext-a", 0), Some(false));
        record_package_ext("fazi-unknown-ext-b", true);
        assert_eq!(package_precheck("fazi-unknown-ext-b", 0), Some(true));
    }

    #[test]
    fn hydrate_package_bit_dir_needs_no_main_thread_check() {
        let dir = tmpdir("bundlebit");
        let plain = dir.join("Thing.fazi-bundlebit-ext");
        let bundled = dir.join("Other.fazi-bundlebit-ext");
        std::fs::create_dir(&plain).unwrap();
        std::fs::create_dir(&bundled).unwrap();
        let mut fi = vec![0u8; 32];
        fi[8] = 0x20; // kHasBundle (0x2000, big-endian)
        xattr::set(&bundled, "com.apple.FinderInfo", &fi).unwrap();

        let mut b = pass1_entry(1, &dir, "Other.fazi-bundlebit-ext", EntryKind::Unknown, "t".into());
        assert!(!hydrate(&mut b), "package bit answers without NSWorkspace");
        assert!(b.is_package);

        let mut p = pass1_entry(2, &dir, "Thing.fazi-bundlebit-ext", EntryKind::Unknown, "t".into());
        assert!(hydrate(&mut p), "unknown extension without the bit stays ambiguous");
        assert!(!p.is_package);
        std::fs::remove_dir_all(&dir).ok();
    }
}
