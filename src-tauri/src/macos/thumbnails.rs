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

use crate::concurrency::{Semaphore, SingleFlight};

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
    // Sub-second edits that keep the size must still miss.
    meta.mtime_nsec().hash(&mut h);
    meta.len().hash(&mut h);
    size.hash(&mut h);
    h.finish()
}

fn cache_file_for(cache_dir: &Path, hash: u64) -> PathBuf {
    cache_dir.join(format!("{hash:016x}.png"))
}

const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

/// A cache hit only if the file holds a PNG. Anything else (an empty or
/// truncated file left by a crash, or by an older non-atomic writer) is
/// deleted and treated as a miss so it can't become a permanent bad hit.
fn read_cached(cache_path: &Path) -> Option<Vec<u8>> {
    let bytes = std::fs::read(cache_path).ok()?;
    if bytes.len() > PNG_MAGIC.len() && bytes.starts_with(PNG_MAGIC) {
        return Some(bytes);
    }
    let _ = std::fs::remove_file(cache_path);
    None
}

/// Publish atomically: write a unique temp file in the cache dir, then
/// rename over the final name, so concurrent readers see either nothing or
/// the whole PNG. A failed write leaves no file behind.
fn write_cached(cache_dir: &Path, cache_path: &Path, png: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    std::fs::create_dir_all(cache_dir)?;
    let tmp = cache_dir.join(format!(
        ".{}.{}-{}.tmp",
        cache_path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(),
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let res = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(png)?;
        f.flush()?;
        drop(f);
        std::fs::rename(&tmp, cache_path)
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

/// Concurrent Quick Look generations (each can take seconds and hold files
/// open); further misses wait their turn.
static QL_PERMITS: Semaphore = Semaphore::new(3);

/// Per-cache-key single-flight: concurrent misses for the same thumbnail
/// (a grid and the preview overlay, a re-render racing a scroll) wait for
/// ONE generation instead of each taking a Quick Look permit.
fn flights() -> &'static SingleFlight<u64, Vec<u8>> {
    static FLIGHTS: OnceLock<SingleFlight<u64, Vec<u8>>> = OnceLock::new();
    FLIGHTS.get_or_init(SingleFlight::default)
}

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
    if let Some(bytes) = read_cached(&cache_path) {
        return Some(bytes);
    }
    if is_negative(hash) {
        return None;
    }
    flights().run(hash, || {
        // A flight that finished just before ours started already settled it.
        if let Some(bytes) = read_cached(&cache_path) {
            return Some(bytes);
        }
        if is_negative(hash) {
            return None;
        }
        // Only the leader holds a Quick Look permit; followers wait on the
        // flight without occupying one.
        let _permit = QL_PERMITS.acquire();
        let Some(png) = generate(path, size) else {
            record_negative(hash);
            return None;
        };
        // Best effort: an unwritable cache only costs a re-render later.
        let _ = write_cached(cache_dir, &cache_path, &png);
        Some(png)
    })
}

/// Disk-cache hit only — never asks Quick Look to open the file (used while
/// the file's volume is being ejected).
pub fn cached_thumbnail_png(cache_dir: &Path, path: &Path, size: u32) -> Option<Vec<u8>> {
    let size = size.clamp(32, 2048);
    let meta = path.symlink_metadata().ok()?;
    read_cached(&cache_file_for(cache_dir, cache_hash(path, &meta, size)))
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

    fn png(tag: u8) -> Vec<u8> {
        let mut v = PNG_MAGIC.to_vec();
        v.push(tag);
        v
    }

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
                Some(png(7))
            });
            assert_eq!(r, Some(png(7)));
        }
        assert_eq!(calls.get(), 1);
        assert_eq!(cached_thumbnail_png(&cache, &ok, 64), Some(png(7)));
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
        let r = thumbnail_png_with(&d.join("cache"), &pkg, 64, |_, _| Some(png(1)));
        assert_eq!(r, Some(png(1)), "packages may still have thumbnails");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn concurrent_misses_for_one_thumbnail_generate_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Barrier};
        let d = tmp("flight");
        let cache = d.join("cache");
        let f = d.join("pic.bin");
        std::fs::write(&f, b"z").unwrap();
        let renders = Arc::new(AtomicUsize::new(0));
        let n = 8;
        let barrier = Arc::new(Barrier::new(n));
        let handles: Vec<_> = (0..n)
            .map(|_| {
                let (cache, f, renders, barrier) =
                    (cache.clone(), f.clone(), renders.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    thumbnail_png_with(&cache, &f, 64, |_, _| {
                        renders.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(80));
                        Some(png(42))
                    })
                })
            })
            .collect();
        for h in handles {
            assert_eq!(h.join().unwrap(), Some(png(42)));
        }
        assert_eq!(renders.load(Ordering::SeqCst), 1, "one Quick Look render per key");
        assert_eq!(flights().in_flight(), 0);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn content_change_misses_the_cache() {
        let d = tmp("rev");
        let cache = d.join("cache");
        let f = d.join("pic.bin");
        std::fs::write(&f, b"one").unwrap();
        assert_eq!(thumbnail_png_with(&cache, &f, 64, |_, _| Some(png(1))), Some(png(1)));
        // Same size, different content, moments later.
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&f, b"two").unwrap();
        assert_eq!(thumbnail_png_with(&cache, &f, 64, |_, _| Some(png(2))), Some(png(2)));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn cache_writes_are_atomic_and_bad_files_are_not_hits() {
        let d = tmp("atomic");
        let cache = d.join("cache");
        let f = d.join("pic.bin");
        std::fs::write(&f, b"q").unwrap();
        let meta = f.symlink_metadata().unwrap();
        let final_path = cache_file_for(&cache, cache_hash(&f, &meta, 64));

        // An empty / truncated file at the final name (crash mid-write) is
        // rejected, removed, and regenerated.
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(&final_path, b"").unwrap();
        assert_eq!(cached_thumbnail_png(&cache, &f, 64), None);
        assert!(!final_path.exists());
        std::fs::write(&final_path, &PNG_MAGIC[..4]).unwrap();
        assert_eq!(thumbnail_png_with(&cache, &f, 64, |_, _| Some(png(5))), Some(png(5)));
        assert_eq!(std::fs::read(&final_path).unwrap(), png(5));
        // No temp files left behind after a successful publish.
        let names: Vec<String> = std::fs::read_dir(&cache)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 1, "{names:?}");

        // A failed write (destination is a directory) leaves neither a
        // partial final file nor a temp file.
        let blocked = cache.join("blocked.png");
        std::fs::create_dir(&blocked).unwrap();
        assert!(write_cached(&cache, &blocked, &png(1)).is_err());
        let tmps = std::fs::read_dir(&cache)
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(tmps, 0);
        std::fs::remove_dir_all(&d).ok();
    }
}
