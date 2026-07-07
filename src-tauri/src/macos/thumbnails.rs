//! Thumbnails via QLThumbnailGenerator — the same renderer Quick Look uses,
//! so Office/Sketch/PSD/etc. produce real previews. Disk LRU-ish cache keyed
//! (path, mtime, size). Falls back to the plain icon when generation fails.

// objc2 versions move methods between safe/unsafe; keep defensive `unsafe`
// blocks without churning every call site on upgrades.
#![allow(unused_unsafe)]

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::AllocAnyThread;
use objc2_app_kit::NSBitmapImageRep;
use objc2_foundation::{NSDictionary, NSError, NSString, NSURL};
use objc2_quick_look_thumbnailing::{
    QLThumbnailGenerationRequest, QLThumbnailGenerationRequestRepresentationTypes,
    QLThumbnailGenerator, QLThumbnailRepresentation,
};

fn cache_file(cache_dir: &Path, path: &Path, size: u32) -> Option<PathBuf> {
    use std::os::unix::fs::MetadataExt;
    let meta = path.symlink_metadata().ok()?;
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    meta.mtime().hash(&mut h);
    meta.len().hash(&mut h);
    size.hash(&mut h);
    Some(cache_dir.join(format!("{:016x}.png", h.finish())))
}

/// Generate (or fetch cached) thumbnail PNG. Safe to call from any thread —
/// QLThumbnailGenerator dispatches internally; the CGImage→PNG conversion
/// happens on the completion queue.
pub fn thumbnail_png(cache_dir: &Path, path: &Path, size: u32) -> Option<Vec<u8>> {
    let size = size.clamp(32, 2048);
    let cache_path = cache_file(cache_dir, path, size);
    if let Some(cp) = &cache_path {
        if let Ok(bytes) = std::fs::read(cp) {
            return Some(bytes);
        }
    }

    let png = generate(path, size)?;

    if let Some(cp) = &cache_path {
        let _ = std::fs::create_dir_all(cache_dir);
        let _ = std::fs::write(cp, &png);
    }
    Some(png)
}

fn generate(path: &Path, size: u32) -> Option<Vec<u8>> {
    let url = unsafe { NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy())) };
    let request = unsafe {
        QLThumbnailGenerationRequest::initWithFileAtURL_size_scale_representationTypes(
            QLThumbnailGenerationRequest::alloc(),
            &url,
            objc2_foundation::NSSize::new(size as f64, size as f64),
            2.0,
            QLThumbnailGenerationRequestRepresentationTypes::Thumbnail,
        )
    };

    let (tx, rx) = mpsc::sync_channel::<Option<Vec<u8>>>(1);
    let block = RcBlock::new(
        move |rep: *mut QLThumbnailRepresentation, _err: *mut NSError| {
            let png = if rep.is_null() {
                None
            } else {
                let rep = unsafe { &*rep };
                cgimage_to_png(rep)
            };
            let _ = tx.send(png);
        },
    );

    let generator = unsafe { QLThumbnailGenerator::sharedGenerator() };
    unsafe { generator.generateBestRepresentationForRequest_completionHandler(&request, &block) };

    rx.recv_timeout(Duration::from_secs(6)).ok().flatten()
}

fn cgimage_to_png(rep: &QLThumbnailRepresentation) -> Option<Vec<u8>> {
    let cg = unsafe { rep.CGImage() };
    let bitmap = unsafe {
        NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &cg)
    };
    let props = NSDictionary::new();
    let data = unsafe {
        bitmap.representationUsingType_properties(objc2_app_kit::NSBitmapImageFileType::PNG, &props)
    }?;
    Some(data.to_vec())
}

/// Prune the thumbnail cache to ~300 MB, oldest-modified first.
pub fn prune_cache(cache_dir: &Path) {
    const LIMIT: u64 = 300 * 1024 * 1024;
    let Ok(rd) = std::fs::read_dir(cache_dir) else {
        return;
    };
    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = rd
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((e.path(), m.len(), m.modified().ok()?))
        })
        .collect();
    let total: u64 = files.iter().map(|(_, s, _)| s).sum();
    if total <= LIMIT {
        return;
    }
    files.sort_by_key(|(_, _, t)| *t);
    let mut freed = 0u64;
    for (p, s, _) in files {
        if total - freed <= LIMIT {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            freed += s;
        }
    }
}
