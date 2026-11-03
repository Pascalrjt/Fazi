//! Thumbnails via QLThumbnailGenerator — the same renderer Quick Look uses,
//! so Office/Sketch/PSD/etc. produce real previews. Disk LRU-ish cache keyed
//! (path, mtime, size). Falls back to the plain icon when generation fails.

// objc2 versions move methods between safe/unsafe; keep defensive `unsafe`
// blocks without churning every call site on upgrades.
#![allow(unused_unsafe)]

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::concurrency::Semaphore;

use block2::RcBlock;
use objc2::AllocAnyThread;
use objc2_app_kit::NSBitmapImageRep;
use objc2_foundation::{NSDictionary, NSError, NSString, NSURL};
use objc2_quick_look_thumbnailing::{
    QLThumbnailGenerationRequest, QLThumbnailGenerationRequestRepresentationTypes,
    QLThumbnailGenerator, QLThumbnailRepresentation,
};

/// (path, mtime, size, pixel size) hash — names the disk cache file and keys
/// the negative cache.
fn cache_hash(path: &Path, meta: &std::fs::Metadata, size: u32) -> u64 {
    use std::os::unix::fs::MetadataExt;
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    meta.mtime().hash(&mut h);
    meta.len().hash(&mut h);
    size.hash(&mut h);
    h.finish()
}

fn cache_file_for(cache_dir: &Path, hash: u64) -> PathBuf {
    cache_dir.join(format!("{hash:016x}.png"))
}

/// Concurrent Quick Look generations (each can take seconds and hold files
/// open); further misses wait their turn.
static QL_PERMITS: Semaphore = Semaphore::new(3);

/// Failed generations, so a file Quick Look can't thumbnail isn't retried on
/// every scroll. Keyed like the disk cache (a modified file retries); entries
/// expire so transient failures (timeouts under load) recover.
const NEGATIVE_TTL: Duration = Duration::from_secs(600);
const NEGATIVE_CAP: usize = 4096;

fn negatives() -> &'static Mutex<HashMap<u64, Instant>> {
    static NEG: OnceLock<Mutex<HashMap<u64, Instant>>> = OnceLock::new();
    NEG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn is_negative(hash: u64) -> bool {
    let Ok(mut neg) = negatives().lock() else {
        return false;
    };
    match neg.get(&hash) {
        Some(at) if at.elapsed() < NEGATIVE_TTL => true,
        Some(_) => {
            neg.remove(&hash);
            false
        }
        None => false,
    }
}

fn record_negative(hash: u64) {
    let Ok(mut neg) = negatives().lock() else {
        return;
    };
    if neg.len() >= NEGATIVE_CAP {
        neg.retain(|_, at| at.elapsed() < NEGATIVE_TTL);
        if neg.len() >= NEGATIVE_CAP {
            neg.clear();
        }
    }
    neg.insert(hash, Instant::now());
}

/// Plain folders have no Quick Look thumbnail — answer before touching QL
/// (the caller falls back to the icon). Package dirs (.app, .key, …) keep
/// going: Quick Look can render those.
fn is_plain_dir(path: &Path, meta: &std::fs::Metadata) -> bool {
    meta.is_dir()
        && crate::core::entry::ext_of(&path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default())
            .is_empty()
}

/// Generate (or fetch cached) thumbnail PNG. Safe to call from any thread —
/// QLThumbnailGenerator dispatches internally; the CGImage→PNG conversion
/// happens on the completion queue.
pub fn thumbnail_png(cache_dir: &Path, path: &Path, size: u32) -> Option<Vec<u8>> {
    thumbnail_png_with(cache_dir, path, size, generate)
}

/// `thumbnail_png` with the generator injected (tests).
fn thumbnail_png_with(
    cache_dir: &Path,
    path: &Path,
    size: u32,
    generate: impl FnOnce(&Path, u32) -> Option<Vec<u8>>,
) -> Option<Vec<u8>> {
    let size = size.clamp(32, 2048);
    let meta = path.symlink_metadata().ok()?;
    if is_plain_dir(path, &meta) {
        return None;
    }
    let hash = cache_hash(path, &meta, size);
    let cache_path = cache_file_for(cache_dir, hash);
    if let Ok(bytes) = std::fs::read(&cache_path) {
        return Some(bytes);
    }
    if is_negative(hash) {
        return None;
    }
    let _permit = QL_PERMITS.acquire();
    // Another request may have produced it while we waited for a permit.
    if let Ok(bytes) = std::fs::read(&cache_path) {
        return Some(bytes);
    }
    if is_negative(hash) {
        return None;
    }
    let Some(png) = generate(path, size) else {
        record_negative(hash);
        return None;
    };
    let _ = std::fs::create_dir_all(cache_dir);
    let _ = std::fs::write(&cache_path, &png);
    Some(png)
}

/// Disk-cache hit only — never asks Quick Look to open the file (used while
/// the file's volume is being ejected).
pub fn cached_thumbnail_png(cache_dir: &Path, path: &Path, size: u32) -> Option<Vec<u8>> {
    let size = size.clamp(32, 2048);
    let meta = path.symlink_metadata().ok()?;
    std::fs::read(cache_file_for(cache_dir, cache_hash(path, &meta, size))).ok()
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fazi-thumb-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn failures_are_negatively_cached_and_successes_disk_cached() {
        let d = tmp("neg");
        let cache = d.join("cache");
        let f = d.join("weird.bin");
        std::fs::write(&f, b"x").unwrap();
        let calls = Cell::new(0);
        for _ in 0..5 {
            let r = thumbnail_png_with(&cache, &f, 64, |_, _| {
                calls.set(calls.get() + 1);
                None
            });
            assert!(r.is_none());
        }
        assert_eq!(calls.get(), 1, "a failed thumbnail is not retried per request");

        let ok = d.join("ok.bin");
        std::fs::write(&ok, b"y").unwrap();
        let calls = Cell::new(0);
        for _ in 0..3 {
            let r = thumbnail_png_with(&cache, &ok, 64, |_, _| {
                calls.set(calls.get() + 1);
                Some(vec![7])
            });
            assert_eq!(r, Some(vec![7]));
        }
        assert_eq!(calls.get(), 1);
        assert_eq!(cached_thumbnail_png(&cache, &ok, 64), Some(vec![7]));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn plain_dirs_are_refused_without_quick_look() {
        let d = tmp("dir");
        let plain = d.join("folder");
        let pkg = d.join("Deck.key");
        std::fs::create_dir(&plain).unwrap();
        std::fs::create_dir(&pkg).unwrap();
        let r = thumbnail_png_with(&d.join("cache"), &plain, 64, |_, _| unreachable!("no QL"));
        assert!(r.is_none());
        let r = thumbnail_png_with(&d.join("cache"), &pkg, 64, |_, _| Some(vec![1]));
        assert_eq!(r, Some(vec![1]), "packages may still have thumbnails");
        std::fs::remove_dir_all(&d).ok();
    }
}
