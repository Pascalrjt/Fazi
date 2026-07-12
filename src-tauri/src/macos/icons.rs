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

/// Path → classification memo: `cache_key` costs a stat + FinderInfo xattr
/// per request, and result bursts repeat the same paths (refine ticks,
/// scrolling). Staleness envelope matches the PNG cache itself — a custom
/// icon added mid-session shows up after eviction or restart.
fn cached_key(path: &Path) -> String {
    static KEYS: OnceLock<DashMap<PathBuf, String>> = OnceLock::new();
    let keys = KEYS.get_or_init(DashMap::new);
    if let Some(k) = keys.get(path) {
        return k.clone();
    }
    let key = cache_key(path);
    if keys.len() > 16_384 {
        let victims: Vec<PathBuf> = keys.iter().take(4096).map(|e| e.key().clone()).collect();
        for v in victims {
            keys.remove(&v);
        }
    }
    keys.insert(path.to_path_buf(), key.clone());
    key
}

/// Render the icon PNG. MUST run on the main thread.
pub fn icon_png_main_thread(path: &Path, size: u32) -> Option<Vec<u8>> {
    let ws = unsafe { NSWorkspace::sharedWorkspace() };
    let image = unsafe { ws.iconForFile(&NSString::from_str(&path.to_string_lossy())) };
    render_image_png(&image, size)
}

/// Rasterize an NSImage to a square PNG. MUST run on the main thread.
pub fn render_image_png(image: &NSImage, size: u32) -> Option<Vec<u8>> {
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

        let props = NSDictionary::new();
        let data = rep.representationUsingType_properties(
            objc2_app_kit::NSBitmapImageFileType::PNG,
            &props,
        )?;
        Some(data.to_vec())
    }
}

/// Cached icon lookup; renders on the main thread on miss.
pub fn icon_png<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    cache: &IconCache,
    path: &Path,
    size: u32,
) -> Option<Arc<Vec<u8>>> {
    let size = size.clamp(8, 1024);
    let key = (cached_key(path), size);
    if let Some(hit) = cache.get(&key) {
        return Some(hit.clone());
    }
    let p = path.to_path_buf();
    let png = crate::macos::main_thread::on_main(app, move || icon_png_main_thread(&p, size))?;
    let arc = Arc::new(png);
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
