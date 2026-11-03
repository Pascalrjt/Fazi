//! File icons: NSWorkspace `iconForFile:` rasterized to PNG at a requested
//! pixel size. Served over icon:// — never base64 over IPC.
//!
//! Cache strategy: most files share their icon by extension, so the PNG cache
//! keys on extension where safe and on full path for apps/packages/custom
//! icons/dirs-with-custom-looks.

// objc2 versions move methods between safe/unsafe; keep defensive `unsafe`
// blocks without churning every call site on upgrades.
#![allow(unused_unsafe)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use objc2::rc::Retained;
use objc2::AllocAnyThread;
use objc2_app_kit::{
    NSBitmapImageRep, NSCompositingOperation, NSGraphicsContext, NSImage, NSWorkspace,
};
use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString};

use crate::concurrency::SingleFlight;
use crate::core::entry::{ext_of, has_custom_icon, is_package_ext};

pub type IconCache = DashMap<(String, u32), Arc<Vec<u8>>>;

/// Directories at or above this component depth can carry distinct macOS
/// icons (/Applications, /Users/me, /Users/me/Desktop, volume roots…);
/// plain folders deeper than this all share the stock folder icon.
const SPECIAL_DIR_DEPTH: usize = 4;

/// Cache key: extension-shared where safe, per-path otherwise.
fn cache_key(path: &Path) -> String {
    let name = path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();
    let ext = ext_of(&name);
    let is_dir = path.is_dir();
    if has_custom_icon(path) {
        return format!("path:{}", path.display());
    }
    if is_dir {
        if ext.is_empty() {
            // Special folders (Desktop, Documents, volume roots…) all live
            // shallow; every deeper plain folder shares ONE generic icon so a
            // folder-heavy ⌘P result burst never rasterizes per-directory on
            // the main thread. Custom icons were already handled above.
            if path.components().count() <= SPECIAL_DIR_DEPTH {
                return format!("dir:{}", path.display());
            }
            return "dir:generic".to_string();
        }
        if is_package_ext(&ext) || ext == "app" {
            return format!("path:{}", path.display());
        }
        return format!("dirext:{}", ext);
    }
    if ext.is_empty() {
        return "file:generic".to_string();
    }
    format!("ext:{}", ext)
}

/// The item's current content revision (one lstat) — the same value
/// hydration puts in `Entry::rev` and the webview sends back as `v=`.
fn rev_of(path: &Path) -> Option<String> {
    path.symlink_metadata().ok().map(|m| crate::core::entry::content_rev(&m))
}

/// Per-path keys (custom icons, apps, packages) render from the item itself.
fn is_per_path(key: &str) -> bool {
    key.starts_with("path:")
}

/// Per-path icons can change without their root's revision moving (an
/// app's `Contents/Resources/*.icns` or a folder's `Icon\r` rewritten in
/// place), so their memo entries — and PNGs — are re-validated this often.
pub const PER_PATH_TTL: Duration = Duration::from_secs(300);

struct Memo {
    /// Revision the classification was validated against.
    rev: Option<String>,
    key: String,
    at: Instant,
}

type KeyMemo = DashMap<PathBuf, Memo>;

#[derive(Debug, PartialEq, Eq)]
struct KeyLookup {
    key: String,
    per_path: bool,
    /// A per-path entry outlived [`PER_PATH_TTL`]: drop its cached PNGs so
    /// the next render picks up in-bundle icon changes.
    expired: bool,
}

/// Path → classification memo: `cache_key` costs a stat + FinderInfo xattr
/// per request, and result bursts repeat the same paths (refine ticks,
/// scrolling).
///
/// Hit path: the request's `v=` equals the revision the memo was validated
/// against → no filesystem access at all (a dead network mount can't stall
/// a cache hit). Otherwise (no/old/forged `v`) one lstat revalidates; a
/// changed item — e.g. one that gained a custom icon — is re-classified, and
/// per-path keys embed the revision so its PNG cache entry is new too.
fn cached_key_in(
    keys: &KeyMemo,
    path: &Path,
    req_rev: &str,
    now: Instant,
    rev_of: impl FnOnce(&Path) -> Option<String>,
    classify: impl FnOnce(&Path) -> String,
) -> KeyLookup {
    let fresh = |m: &Memo| !is_per_path(&m.key) || now.duration_since(m.at) < PER_PATH_TTL;
    let mut was_expired = false;
    if let Some(m) = keys.get(path) {
        if fresh(&m) {
            if !req_rev.is_empty() && m.rev.as_deref() == Some(req_rev) {
                return KeyLookup { per_path: is_per_path(&m.key), key: m.key.clone(), expired: false };
            }
        } else {
            was_expired = true;
        }
    }
    let rev = rev_of(path);
    if !was_expired {
        if let Some(m) = keys.get(path) {
            if rev.is_some() && m.rev == rev {
                return KeyLookup { per_path: is_per_path(&m.key), key: m.key.clone(), expired: false };
            }
        }
    }
    let class = classify(path);
    let per_path = is_per_path(&class);
    let key = match &rev {
        Some(r) if per_path => format!("{class}@{r}"),
        _ => class,
    };
    if keys.len() > 16_384 {
        let victims: Vec<PathBuf> = keys.iter().take(4096).map(|e| e.key().clone()).collect();
        for v in victims {
            keys.remove(&v);
        }
    }
    keys.insert(path.to_path_buf(), Memo { rev, key: key.clone(), at: now });
    KeyLookup { key, per_path, expired: was_expired && per_path }
}

fn cached_key(path: &Path, req_rev: &str) -> KeyLookup {
    static KEYS: OnceLock<KeyMemo> = OnceLock::new();
    cached_key_in(KEYS.get_or_init(DashMap::new), path, req_rev, Instant::now(), rev_of, cache_key)
}

/// Render the icon PNG. MUST run on the main thread.
pub fn icon_png_main_thread(path: &Path, size: u32) -> Option<Vec<u8>> {
    encode_png(&icon_bitmap_main_thread(path, size)?.0)
}

/// A rasterized bitmap handed from the main thread to a worker for PNG
/// encoding. The main thread keeps no reference once drawing finished, so
/// the worker has exclusive use of it (the Quick Look path already encodes
/// NSBitmapImageReps off-main the same way).
pub struct DrawnBitmap(Retained<NSBitmapImageRep>);
// SAFETY: exclusively owned after the main-thread draw; only read (encoded)
// on the receiving thread; refcounting is atomic.
unsafe impl Send for DrawnBitmap {}

/// `iconForFile:` + draw into a bitmap — the only part that needs the main
/// thread. MUST run on the main thread.
pub fn icon_bitmap_main_thread(path: &Path, size: u32) -> Option<DrawnBitmap> {
    objc2::rc::autoreleasepool(|_| {
        let ws = unsafe { NSWorkspace::sharedWorkspace() };
        let image = unsafe { ws.iconForFile(&NSString::from_str(&path.to_string_lossy())) };
        draw_bitmap(&image, size).map(DrawnBitmap)
    })
}

/// PNG-encode a drawn bitmap (any thread, exclusive access).
pub fn encode_png(rep: &NSBitmapImageRep) -> Option<Vec<u8>> {
    let props = NSDictionary::new();
    let data = unsafe {
        rep.representationUsingType_properties(objc2_app_kit::NSBitmapImageFileType::PNG, &props)
    }?;
    Some(data.to_vec())
}

/// Rasterize an NSImage to a square PNG. MUST run on the main thread.
pub fn render_image_png(image: &NSImage, size: u32) -> Option<Vec<u8>> {
    let rep = draw_bitmap(image, size)?;
    encode_png(&rep)
}

/// Draw an NSImage into a fresh square bitmap. MUST run on the main thread.
fn draw_bitmap(image: &NSImage, size: u32) -> Option<Retained<NSBitmapImageRep>> {
    unsafe {
        let rep = NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(),
            std::ptr::null_mut(),
            size as isize,
            size as isize,
            8,
            4,
            true,
            false,
            objc2_app_kit::NSCalibratedRGBColorSpace,
            0,
            0,
        )?;
        let ctx = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep)?;
        NSGraphicsContext::saveGraphicsState_class();
        NSGraphicsContext::setCurrentContext(Some(&ctx));
        image.drawInRect_fromRect_operation_fraction(
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(size as f64, size as f64)),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0)), // NSZeroRect = whole image
            NSCompositingOperation::SourceOver,
            1.0,
        );
        ctx.flushGraphics();
        NSGraphicsContext::restoreGraphicsState_class();
        Some(rep)
    }
}

pub type IconFlights = SingleFlight<(String, u32), Arc<Vec<u8>>>;

fn flights() -> &'static IconFlights {
    static FLIGHTS: OnceLock<IconFlights> = OnceLock::new();
    FLIGHTS.get_or_init(IconFlights::default)
}

/// Cache → single-flight → render. Concurrent misses for the same key (a
/// screenful of `.txt` rows) wait for ONE render instead of queueing one
/// main-thread trip each. Renderer-agnostic so it can be tested headless.
pub fn cached_or_render(
    cache: &IconCache,
    flights: &IconFlights,
    key: (String, u32),
    render: impl FnOnce() -> Option<Vec<u8>>,
) -> Option<Arc<Vec<u8>>> {
    if let Some(hit) = cache.get(&key) {
        return Some(hit.clone());
    }
    flights.run(key.clone(), || {
        // A flight that finished just before ours started already filled it.
        if let Some(hit) = cache.get(&key) {
            return Some(hit.clone());
        }
        let arc = Arc::new(render()?);
        // Bound the cache: icons are small, 4096 entries ≈ a few MB. Evict a
        // quarter (arbitrary victims) instead of clearing — a full clear made
        // every visible icon re-rasterize on the main thread at once.
        if cache.len() > 4096 {
            let victims: Vec<(String, u32)> =
                cache.iter().take(1024).map(|e| e.key().clone()).collect();
            for k in victims {
                cache.remove(&k);
            }
        }
        cache.insert(key, arc.clone());
        Some(arc)
    })
}

/// Cached icon lookup; on miss draws on the main thread and PNG-encodes on
/// the calling (worker) thread.
/// A served icon; `per_path` icons are item-specific and may change
/// without their URL changing, so they get a short HTTP cache lifetime.
pub struct IconPng {
    pub png: Arc<Vec<u8>>,
    pub per_path: bool,
}

pub fn icon_png<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    cache: &IconCache,
    path: &Path,
    size: u32,
    req_rev: &str,
) -> Option<IconPng> {
    let size = size.clamp(8, 1024);
    let lookup = cached_key(path, req_rev);
    if lookup.expired {
        cache.retain(|k, _| k.0 != lookup.key);
    }
    let per_path = lookup.per_path;
    let key = (lookup.key, size);
    let png = cached_or_render(cache, flights(), key, || {
        let p = path.to_path_buf();
        let bitmap =
            crate::macos::main_thread::on_main(app, move || icon_bitmap_main_thread(&p, size))?;
        encode_png(&bitmap.0)
    })?;
    Some(IconPng { png, per_path })
}

/// Extensions whose type icons ⌘P result bursts most commonly need.
const PREWARM_EXTS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "json", "md", "txt", "pdf", "png", "jpg", "jpeg", "gif",
    "webp", "heic", "svg", "mp4", "mov", "mp3", "m4a", "wav", "zip", "tar", "gz", "dmg", "doc",
    "docx", "xls", "xlsx", "ppt", "pptx", "csv", "html", "css", "py", "go", "java", "c", "cpp",
    "h", "swift", "toml", "yaml", "yml", "sh",
];
const PREWARM_SIZES: &[u32] = &[32, 64];

/// Render the shared ext/generic icons into the cache off the critical path,
/// paced so the AppKit main thread never sees a burst (each cold render costs
/// 1-17 ms there). NSWorkspace resolves type icons from real paths, so the
/// probes are scratch files created for the duration of the warm-up.
pub fn prewarm_common<R: tauri::Runtime>(app: &tauri::AppHandle<R>, cache: &IconCache) {
    let dir = std::env::temp_dir().join("fazi-icon-prewarm");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let mut paths: Vec<PathBuf> = Vec::new();
    // A deep plain folder resolves the shared "dir:generic" key.
    let generic_dir = dir.join("a/b/c/d/folder");
    if std::fs::create_dir_all(&generic_dir).is_ok() {
        paths.push(generic_dir);
    }
    let noext = dir.join("noext");
    if std::fs::write(&noext, b"").is_ok() {
        paths.push(noext);
    }
    for ext in PREWARM_EXTS {
        let p = dir.join(format!("f.{ext}"));
        if std::fs::write(&p, b"").is_ok() {
            paths.push(p);
        }
    }
    for &size in PREWARM_SIZES {
        for p in &paths {
            let _ = icon_png(app, cache, p, size, "");
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
}

// Keep Retained import used even if signatures shift during upgrades.
#[allow(dead_code)]
fn _retain_hint(i: Retained<NSImage>) -> Retained<NSImage> {
    i
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn concurrent_misses_for_one_key_render_once() {
        let cache: Arc<IconCache> = Arc::new(DashMap::new());
        let flights: Arc<IconFlights> = Arc::new(IconFlights::default());
        let renders = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(std::sync::Barrier::new(24));
        let handles: Vec<_> = (0..24)
            .map(|i| {
                let (cache, flights, renders, barrier) =
                    (cache.clone(), flights.clone(), renders.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    // Two distinct keys, 12 requesters each.
                    let key = (if i % 2 == 0 { "ext:txt" } else { "ext:pdf" }.to_string(), 32);
                    cached_or_render(&cache, &flights, key, || {
                        renders.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(30));
                        Some(vec![1, 2, 3])
                    })
                })
            })
            .collect();
        for h in handles {
            assert_eq!(h.join().unwrap().as_deref(), Some(&vec![1, 2, 3]));
        }
        assert_eq!(renders.load(Ordering::SeqCst), 2, "one render per key");
        // Later requests are plain cache hits.
        let hit = cached_or_render(&cache, &flights, ("ext:txt".into(), 32), || {
            unreachable!("cached")
        });
        assert!(hit.is_some());
    }

    #[test]
    fn failed_render_is_not_cached() {
        let cache = IconCache::new();
        let flights = IconFlights::default();
        assert!(cached_or_render(&cache, &flights, ("k".into(), 16), || None).is_none());
        assert!(cache.is_empty());
        assert!(cached_or_render(&cache, &flights, ("k".into(), 16), || Some(vec![9])).is_some());
    }

    #[test]
    fn per_path_keys_follow_the_items_revision_across_token_generations() {
        let d = std::env::temp_dir().join(format!("fazi-icon-id-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("doc.txt");
        std::fs::write(&f, b"x").unwrap();
        let memo = KeyMemo::new();
        let now = Instant::now();
        let classified = std::cell::Cell::new(0);
        let classify = |p: &Path| {
            classified.set(classified.get() + 1);
            cache_key(p)
        };
        let k = cached_key_in(&memo, &f, "", now, rev_of, classify);
        assert_eq!(k.key, "ext:txt");
        assert!(!k.per_path);
        assert_eq!(cached_key_in(&memo, &f, "", now, rev_of, classify).key, "ext:txt");
        assert_eq!(classified.get(), 1);

        // While away: the file gains a custom icon (FinderInfo flag).
        let mut info = [0u8; 32];
        info[8] = 0x04; // kHasCustomIcon
        set_finder_info(&f, &info);
        // Reopen (new owner/token, no URL revision): revalidation notices.
        let custom = cached_key_in(&memo, &f, "", now, rev_of, classify);
        assert!(custom.per_path && custom.key.contains('@'), "{custom:?}");
        assert_eq!(classified.get(), 2);

        // Editing a custom-icon item gives it a fresh PNG cache key.
        std::thread::sleep(Duration::from_millis(5));
        std::fs::write(&f, b"edited").unwrap();
        let edited = cached_key_in(&memo, &f, "", now, rev_of, classify);
        assert!(edited.per_path);
        assert_ne!(edited.key, custom.key);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn same_size_same_mtime_xattr_change_yields_a_new_rev() {
        let d = std::env::temp_dir().join(format!("fazi-icon-rev-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("doc.txt");
        std::fs::write(&f, b"x").unwrap();
        let before = f.symlink_metadata().unwrap();
        std::thread::sleep(Duration::from_millis(5));
        set_finder_info(&f, &[0u8; 32]);
        let after = f.symlink_metadata().unwrap();
        use std::os::unix::fs::MetadataExt;
        assert_eq!((before.size(), before.mtime(), before.mtime_nsec()), (after.size(), after.mtime(), after.mtime_nsec()));
        assert_ne!(crate::core::entry::content_rev(&before), crate::core::entry::content_rev(&after));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn matching_url_revision_is_a_hit_without_any_lstat() {
        let memo = KeyMemo::new();
        let p = Path::new("/Volumes/dead-mount/Foo.app");
        let now = Instant::now();
        let stats = std::cell::Cell::new(0);
        let rev = |_: &Path| {
            stats.set(stats.get() + 1);
            Some("r1".to_string())
        };
        let class = |_: &Path| "path:/Volumes/dead-mount/Foo.app".to_string();
        let first = cached_key_in(&memo, p, "", now, rev, class);
        assert_eq!(first.key, "path:/Volumes/dead-mount/Foo.app@r1");
        assert_eq!(stats.get(), 1);
        for _ in 0..5 {
            let hit = cached_key_in(&memo, p, "r1", now, rev, |_: &Path| unreachable!());
            assert_eq!(hit.key, first.key);
        }
        assert_eq!(stats.get(), 1, "v= matching the memo never touches the filesystem");
        // A forged / stale v only costs one revalidation.
        let again = cached_key_in(&memo, p, "bogus", now, rev, |_: &Path| unreachable!());
        assert_eq!(again.key, first.key);
        assert_eq!(stats.get(), 2);
    }

    #[test]
    fn per_path_entries_expire_so_in_bundle_icon_edits_show_up() {
        let memo = KeyMemo::new();
        let p = Path::new("/Applications/Foo.app");
        let t0 = Instant::now();
        let rev = |_: &Path| Some("r1".to_string());
        let class = |_: &Path| "path:/Applications/Foo.app".to_string();
        assert!(!cached_key_in(&memo, p, "r1", t0, rev, class).expired);
        assert!(!cached_key_in(&memo, p, "r1", t0 + Duration::from_secs(60), rev, class).expired);
        let late = cached_key_in(&memo, p, "r1", t0 + PER_PATH_TTL + Duration::from_secs(1), rev, class);
        assert!(late.expired, "stale per-path PNGs get purged and re-rendered");
        // Shared keys never expire.
        let txt = Path::new("/x/a.txt");
        let ext = |_: &Path| "ext:txt".to_string();
        cached_key_in(&memo, txt, "r1", t0, rev, ext);
        let shared = cached_key_in(&memo, txt, "r1", t0 + PER_PATH_TTL * 2, rev, |_: &Path| unreachable!());
        assert!(!shared.expired && !shared.per_path);
    }

    fn set_finder_info(path: &Path, info: &[u8; 32]) {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        let name = std::ffi::CString::new("com.apple.FinderInfo").unwrap();
        let rc = unsafe {
            libc::setxattr(c.as_ptr(), name.as_ptr(), info.as_ptr().cast(), info.len(), 0, 0)
        };
        assert_eq!(rc, 0, "setxattr");
    }

}
