//! File icons: NSWorkspace `iconForFile:` rasterized to PNG at a requested
//! pixel size. Served over icon:// — never base64 over IPC.
//!
//! Cache strategy: most files share their icon by extension, so the PNG cache
//! keys on extension where safe and on full path for apps/packages/custom
//! icons/dirs-with-custom-looks.

// objc2 versions move methods between safe/unsafe; keep defensive `unsafe`
// blocks without churning every call site on upgrades.
#![allow(unused_unsafe)]

use std::path::Path;
use std::sync::Arc;

use dashmap::DashMap;
use objc2::rc::Retained;
use objc2::AllocAnyThread;
use objc2_app_kit::{
    NSBitmapImageRep, NSCompositingOperation, NSGraphicsContext, NSImage, NSWorkspace,
};
use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString};

use crate::core::entry::{ext_of, has_custom_icon, is_package_ext};

pub type IconCache = DashMap<(String, u32), Arc<Vec<u8>>>;

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
            // Special folders (Desktop, Documents…) have distinct icons.
            return format!("dir:{}", path.display());
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
    let key = (cache_key(path), size);
    if let Some(hit) = cache.get(&key) {
        return Some(hit.clone());
    }
    let p = path.to_path_buf();
    let png = crate::macos::main_thread::on_main(app, move || icon_png_main_thread(&p, size))?;
    let arc = Arc::new(png);
    // Bound the cache crudely: icons are small, 4096 entries ≈ a few MB.
    if cache.len() > 4096 {
        cache.clear();
    }
    cache.insert(key, arc.clone());
    Some(arc)
}

// Keep Retained import used even if signatures shift during upgrades.
#[allow(dead_code)]
fn _retain_hint(i: Retained<NSImage>) -> Retained<NSImage> {
    i
}
