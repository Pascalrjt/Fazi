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

/// What an item looked like on disk when it was classified: one lstat.
/// Writing FinderInfo (a custom icon flag) or `Icon\r` bumps ctime/mtime,
/// replacing the item changes the inode — so any change that can alter its
/// icon changes this identity, whichever token or listing asks.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Identity {
    ino: u64,
    size: u64,
    mtime: (i64, i64),
    ctime: (i64, i64),
}

fn identity_of(path: &Path) -> Option<Identity> {
    use std::os::unix::fs::MetadataExt;
    let m = path.symlink_metadata().ok()?;
    Some(Identity {
        ino: m.ino(),
        size: m.size(),
        mtime: (m.mtime(), m.mtime_nsec()),
        ctime: (m.ctime(), m.ctime_nsec()),
    })
}

/// Per-path keys (custom icons, apps, packages) render from the item
/// itself, so they carry its identity: a changed item misses instead of
/// serving the PNG drawn before the change. Extension-, generic- and
/// special-folder keys don't depend on the item's content.
fn identity_key(key: String, id: Option<Identity>) -> String {
    match id {
        Some(id) if key.starts_with("path:") => {
            use std::hash::{BuildHasher, BuildHasherDefault};
            let h = BuildHasherDefault::<std::collections::hash_map::DefaultHasher>::default()
                .hash_one(id);
            format!("{key}@{h:016x}")
        }
        _ => key,
    }
}

type KeyMemo = DashMap<PathBuf, (Option<Identity>, String)>;

/// Path → classification memo: `cache_key` costs a stat + FinderInfo xattr
/// per request, and result bursts repeat the same paths (refine ticks,
/// scrolling). Entries are validated against the item's current identity
/// (one lstat), so an item that changed — e.g. just gained a custom icon —
/// is re-classified and re-rendered, independent of URL revisions or token
/// generations.
fn cached_key_in(
    keys: &KeyMemo,
    path: &Path,
    identity: impl FnOnce(&Path) -> Option<Identity>,
    classify: impl FnOnce(&Path) -> String,
) -> String {
    let id = identity(path);
    if let Some(k) = keys.get(path) {
        if id.is_some() && k.0 == id {
            return k.1.clone();
        }
    }
    let key = identity_key(classify(path), id);
    if keys.len() > 16_384 {
        let victims: Vec<PathBuf> = keys.iter().take(4096).map(|e| e.key().clone()).collect();
        for v in victims {
            keys.remove(&v);
        }
    }
    keys.insert(path.to_path_buf(), (id, key.clone()));
    key
}

fn cached_key(path: &Path) -> String {
    static KEYS: OnceLock<KeyMemo> = OnceLock::new();
    cached_key_in(KEYS.get_or_init(DashMap::new), path, identity_of, cache_key)
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
pub fn icon_png<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    cache: &IconCache,
    path: &Path,
    size: u32,
) -> Option<Arc<Vec<u8>>> {
    let size = size.clamp(8, 1024);
    let key = (cached_key(path), size);
    cached_or_render(cache, flights(), key, || {
        let p = path.to_path_buf();
        let bitmap =
            crate::macos::main_thread::on_main(app, move || icon_bitmap_main_thread(&p, size))?;
        encode_png(&bitmap.0)
    })
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
            let _ = icon_png(app, cache, p, size);
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
    fn per_path_keys_follow_the_items_identity_across_token_generations() {
        let d = std::env::temp_dir().join(format!("fazi-icon-id-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("doc.txt");
        std::fs::write(&f, b"x").unwrap();
        let memo = KeyMemo::new();
        let classified = std::cell::Cell::new(0);
        let classify = |p: &Path| {
            classified.set(classified.get() + 1);
            cache_key(p)
        };
        // First listing: shared ext icon; repeat requests are memo hits.
        assert_eq!(cached_key_in(&memo, &f, identity_of, classify), "ext:txt");
        assert_eq!(cached_key_in(&memo, &f, identity_of, classify), "ext:txt");
        assert_eq!(classified.get(), 1);

        // While away: the file gains a custom icon (FinderInfo flag).
        let mut info = [0u8; 32];
        info[8] = 0x04; // kHasCustomIcon
        set_finder_info(&f, &info);
        // Reopen (new owner, new token, no URL revision): the backend still
        // notices because the item's identity changed.
        let custom = cached_key_in(&memo, &f, identity_of, classify);
        assert!(custom.starts_with("path:") && custom.contains('@'), "{custom}");
        assert_eq!(classified.get(), 2);

        // Editing a custom-icon item gives it a fresh PNG cache key.
        std::thread::sleep(std::time::Duration::from_millis(5));
        std::fs::write(&f, b"edited").unwrap();
        let edited = cached_key_in(&memo, &f, identity_of, classify);
        assert!(edited.starts_with("path:"));
        assert_ne!(edited, custom);
        std::fs::remove_dir_all(&d).ok();
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

    #[test]
    fn shared_keys_ignore_identity() {
        let id = identity_of(Path::new("/")).unwrap();
        assert_eq!(identity_key("ext:txt".into(), Some(id)), "ext:txt");
        assert_eq!(identity_key("dir:generic".into(), Some(id)), "dir:generic");
        assert_eq!(identity_key("dir:/Users/me".into(), Some(id)), "dir:/Users/me");
        assert!(identity_key("path:/A.app".into(), Some(id)).starts_with("path:/A.app@"));
    }
}
