//! Opt-in checksum verification for copies (`verifyCopies` setting) — BLAKE3
//! stream-hash of every regular file on both sides, compared post-promote.
//!
//! This ADDS to (never replaces) the mandatory cross-volume move gate
//! (`walker::verify_tree` — metadata/size/mtime), which stays non-configurable.
//!
//! Defined for trees, not just single files: both sides walk in byte-wise-
//! sorted relative-path order. Regular files stream-hash and compare;
//! symlinks compare by target string (never followed); special files
//! (fifos/sockets/devices) and directories themselves are excluded from
//! hashing — structure, names, and metadata are already covered by the
//! mandatory verify pass. A relative path present on one side only, a type
//! mismatch, or a hash/target mismatch fails that item.
//!
//! Cost control: equal-size files whose every extent maps to the same
//! physical blocks (APFS clones — the same-volume copy path) are identical by
//! construction and skip hashing (see `shares_all_extents`); a size mismatch
//! fails without hashing; files ≥ 1 MiB hash both sides concurrently; the
//! two 4 MiB chunk buffers are allocated once per compare, not per file.

use std::io::{self, Read};
use std::path::Path;

/// Cancel granularity within large files.
const CHUNK: usize = 4 * 1024 * 1024;

pub struct ChecksumReport {
    /// Human-readable per-path mismatches (empty = verified clean).
    pub mismatches: Vec<String>,
    /// The cancel token fired mid-verify — mismatches may be incomplete.
    pub cancelled: bool,
}

#[derive(PartialEq)]
enum Kind {
    File,
    Dir,
    Symlink,
    Special,
    Missing,
}

fn kind_of(path: &Path) -> Kind {
    match path.symlink_metadata() {
        Err(_) => Kind::Missing,
        Ok(m) => {
            let ft = m.file_type();
            if ft.is_symlink() {
                Kind::Symlink
            } else if ft.is_dir() {
                Kind::Dir
            } else if ft.is_file() {
                Kind::File
            } else {
                Kind::Special
            }
        }
    }
}

/// Files at least this large hash source and destination concurrently.
const PARALLEL_MIN: u64 = 1 << 20;

/// Two chunk buffers allocated once per `checksum_compare` (lazily, on the
/// first hashed file) and reused for every file in the tree.
#[derive(Default)]
struct Bufs {
    a: Vec<u8>,
    b: Vec<u8>,
}

impl Bufs {
    fn get(&mut self) -> (&mut [u8], &mut [u8]) {
        if self.a.is_empty() {
            self.a = vec![0u8; CHUNK];
            self.b = vec![0u8; CHUNK];
        }
        (&mut self.a, &mut self.b)
    }
}

fn hash_reader(
    file: &mut std::fs::File,
    buf: &mut [u8],
    stop: &dyn Fn() -> bool,
) -> io::Result<Option<blake3::Hash>> {
    let mut hasher = blake3::Hasher::new();
    loop {
        // Cancel checked per 4 MiB chunk within large files.
        if stop() {
            return Ok(None);
        }
        let n = match file.read(buf) {
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(Some(hasher.finalize()))
}

/// One logical→physical lookup (`fcntl(F_LOG2PHYS_EXT)`):
/// (device offset, contiguous bytes from there).
fn log2phys(file: &std::fs::File, offset: u64, want: u64) -> Option<(i64, i64)> {
    use std::os::unix::io::AsRawFd;
    let mut l = libc::log2phys {
        l2p_flags: 0,
        l2p_contigbytes: i64::try_from(want).ok()?,
        l2p_devoffset: i64::try_from(offset).ok()?,
    };
    // SAFETY: valid fd; `l` is the documented in/out struct for this fcntl.
    let rc = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_LOG2PHYS_EXT, &mut l) };
    if rc == -1 {
        return None;
    }
    let (dev_off, contig) = (l.l2p_devoffset, l.l2p_contigbytes);
    Some((dev_off, contig))
}

/// True when every byte of `a` and `b` (same device, same length) maps to
/// the SAME physical blocks — an APFS clone (`clonefile`) sharing its
/// source's extents. Hashing such a pair would read the same blocks twice
/// and can never find a difference (any corruption is shared too), so the
/// content check is skipped for it. Any lookup failure (compressed files,
/// filesystems without the fcntl, delayed allocation) means "not proven
/// shared" and the files are hashed as usual. A clone whose source changed
/// after the clone no longer shares those extents, so it is still hashed.
fn shares_all_extents(a: &std::fs::File, b: &std::fs::File, len: u64) -> bool {
    if len == 0 {
        return false;
    }
    let mut off = 0u64;
    // Bounded: a pathological extent map just falls back to hashing.
    for _ in 0..65_536 {
        if off >= len {
            return true;
        }
        let Some((pa, ca)) = log2phys(a, off, len - off) else { return false };
        let Some((pb, cb)) = log2phys(b, off, len - off) else { return false };
        if pa != pb || pa < 0 {
            return false;
        }
        let step = ca.min(cb);
        if step <= 0 {
            return false;
        }
        off = off.saturating_add(step as u64);
    }
    false
}

enum FileVerdict {
    Same,
    Differ,
    Cancelled,
    Error(io::Error),
}

/// Content-compare two regular files: size short-circuit, clone-extent
/// short-circuit, else BLAKE3 of both sides — concurrently (scoped thread)
/// for files ≥ 1 MiB, reusing the per-compare buffers.
fn compare_files(
    src: &Path,
    dst: &Path,
    cancelled: &dyn Fn() -> bool,
    bufs: &mut Bufs,
) -> FileVerdict {
    use std::os::unix::fs::MetadataExt;
    let open = |p: &Path| std::fs::File::open(p).and_then(|f| f.metadata().map(|m| (f, m)));
    let (mut fs, ms) = match open(src) {
        Ok(v) => v,
        Err(e) => return FileVerdict::Error(e),
    };
    let (mut fd, md) = match open(dst) {
        Ok(v) => v,
        Err(e) => return FileVerdict::Error(e),
    };
    if ms.len() != md.len() {
        return FileVerdict::Differ;
    }
    if ms.dev() == md.dev() && shares_all_extents(&fs, &fd, ms.len()) {
        return FileVerdict::Same;
    }
    let (buf_a, buf_b) = bufs.get();
    let (ra, rb) = if ms.len() >= PARALLEL_MIN {
        let stop = std::sync::atomic::AtomicBool::new(false);
        let halt = || stop.store(true, std::sync::atomic::Ordering::Relaxed);
        std::thread::scope(|scope| {
            let dst_side = scope.spawn(|| {
                hash_reader(&mut fd, buf_b, &|| stop.load(std::sync::atomic::Ordering::Relaxed))
            });
            // `cancelled` stays on this thread (it needn't be Sync); the
            // destination side follows via `stop`.
            let ra = hash_reader(&mut fs, buf_a, &|| {
                let c = cancelled();
                if c {
                    halt();
                }
                c
            });
            if !matches!(ra, Ok(Some(_))) {
                halt();
            }
            while !dst_side.is_finished() {
                if cancelled() {
                    halt();
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            let rb = dst_side
                .join()
                .unwrap_or_else(|_| Err(io::Error::other("hash thread panicked")));
            (ra, rb)
        })
    } else {
        let ra = hash_reader(&mut fs, buf_a, cancelled);
        let rb = match ra {
            Ok(Some(_)) => hash_reader(&mut fd, buf_b, cancelled),
            _ => Ok(None),
        };
        (ra, rb)
    };
    match (ra, rb) {
        (Err(e), _) => FileVerdict::Error(e),
        (Ok(None), _) => FileVerdict::Cancelled,
        (Ok(Some(_)), Err(e)) => FileVerdict::Error(e),
        (Ok(Some(_)), Ok(None)) => FileVerdict::Cancelled,
        (Ok(Some(a)), Ok(Some(b))) => {
            if a == b {
                FileVerdict::Same
            } else {
                FileVerdict::Differ
            }
        }
    }
}

/// Compare `src` and `dst` (file, dir, or symlink) by content checksum.
pub fn checksum_compare(
    src: &Path,
    dst: &Path,
    cancelled: &dyn Fn() -> bool,
) -> ChecksumReport {
    let mut report = ChecksumReport { mismatches: Vec::new(), cancelled: false };
    let mut bufs = Bufs::default();
    compare_entry(src, dst, cancelled, &mut report, &mut bufs);
    report
}

fn compare_entry(
    src: &Path,
    dst: &Path,
    cancelled: &dyn Fn() -> bool,
    report: &mut ChecksumReport,
    bufs: &mut Bufs,
) {
    if report.cancelled {
        return;
    }
    // Cancel checked per file/entry.
    if cancelled() {
        report.cancelled = true;
        return;
    }
    let (sk, dk) = (kind_of(src), kind_of(dst));
    match (sk, dk) {
        (Kind::Missing, Kind::Missing) => {}
        (_, Kind::Missing) => report
            .mismatches
            .push(format!("{}: missing at destination", dst.display())),
        (Kind::Missing, _) => report
            .mismatches
            .push(format!("{}: present only at destination", dst.display())),
        (Kind::File, Kind::File) => {
            match compare_files(src, dst, cancelled, bufs) {
                FileVerdict::Same => {}
                FileVerdict::Differ => {
                    report.mismatches.push(format!("{}: checksum mismatch", dst.display()))
                }
                FileVerdict::Cancelled => report.cancelled = true,
                FileVerdict::Error(e) => report
                    .mismatches
                    .push(format!("{}: couldn't hash ({})", dst.display(), e)),
            }
        }
        (Kind::Symlink, Kind::Symlink) => {
            // Compared by target string — never followed.
            let a = std::fs::read_link(src).ok();
            let b = std::fs::read_link(dst).ok();
            if a != b {
                report
                    .mismatches
                    .push(format!("{}: symlink target differs", dst.display()));
            }
        }
        (Kind::Dir, Kind::Dir) => compare_dir(src, dst, cancelled, report, bufs),
        // Specials are excluded from hashing; matching special kinds pass.
        (Kind::Special, Kind::Special) => {}
        _ => report.mismatches.push(format!("{}: type differs", dst.display())),
    }
}

fn compare_dir(
    src: &Path,
    dst: &Path,
    cancelled: &dyn Fn() -> bool,
    report: &mut ChecksumReport,
    bufs: &mut Bufs,
) {
    let read_names = |dir: &Path| -> Vec<std::ffi::OsString> {
        let mut names: Vec<_> = std::fs::read_dir(dir)
            .map(|rd| rd.flatten().map(|e| e.file_name()).collect())
            .unwrap_or_default();
        // Byte-wise sort — the defined walk order.
        names.sort();
        names
    };
    let src_names = read_names(src);
    let dst_names = read_names(dst);

    // Merge-walk the two sorted name lists.
    let (mut i, mut j) = (0, 0);
    while i < src_names.len() || j < dst_names.len() {
        if report.cancelled {
            return;
        }
        match (src_names.get(i), dst_names.get(j)) {
            (Some(a), Some(b)) if a == b => {
                compare_entry(&src.join(a), &dst.join(a), cancelled, report, bufs);
                i += 1;
                j += 1;
            }
            (Some(a), Some(b)) if a < b => {
                report
                    .mismatches
                    .push(format!("{}: missing at destination", dst.join(a).display()));
                i += 1;
            }
            (Some(_), Some(b)) => {
                report
                    .mismatches
                    .push(format!("{}: present only at destination", dst.join(b).display()));
                j += 1;
            }
            (Some(a), None) => {
                report
                    .mismatches
                    .push(format!("{}: missing at destination", dst.join(a).display()));
                i += 1;
            }
            (None, Some(b)) => {
                report
                    .mismatches
                    .push(format!("{}: present only at destination", dst.join(b).display()));
                j += 1;
            }
            (None, None) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fazi-verify-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn never() -> impl Fn() -> bool {
        || false
    }

    #[test]
    fn identical_trees_verify_clean() {
        let d = tmp("clean");
        for side in ["a", "b"] {
            fs::create_dir_all(d.join(side).join("sub")).unwrap();
            fs::write(d.join(side).join("f.txt"), b"hello").unwrap();
            fs::write(d.join(side).join("sub/g.bin"), vec![7u8; 5000]).unwrap();
            std::os::unix::fs::symlink("f.txt", d.join(side).join("link")).unwrap();
        }
        let r = checksum_compare(&d.join("a"), &d.join("b"), &never());
        assert!(r.mismatches.is_empty(), "{:?}", r.mismatches);
        assert!(!r.cancelled);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn corrupted_byte_missing_entry_and_type_mismatch_flagged() {
        let d = tmp("dirty");
        for side in ["a", "b"] {
            fs::create_dir_all(d.join(side)).unwrap();
            fs::write(d.join(side).join("same.txt"), b"ok").unwrap();
        }
        // Same size, one flipped byte — size/mtime verify can't see this.
        fs::write(d.join("a/corrupt.bin"), b"AAAA").unwrap();
        fs::write(d.join("b/corrupt.bin"), b"AAAB").unwrap();
        // Missing at destination + extra at destination.
        fs::write(d.join("a/only-src.txt"), b"x").unwrap();
        fs::write(d.join("b/only-dst.txt"), b"y").unwrap();
        // Type mismatch: file vs dir.
        fs::write(d.join("a/thing"), b"file").unwrap();
        fs::create_dir(d.join("b/thing")).unwrap();

        let r = checksum_compare(&d.join("a"), &d.join("b"), &never());
        let joined = r.mismatches.join("\n");
        assert!(joined.contains("corrupt.bin: checksum mismatch"), "{joined}");
        assert!(joined.contains("only-src.txt: missing at destination"), "{joined}");
        assert!(joined.contains("only-dst.txt: present only at destination"), "{joined}");
        assert!(joined.contains("thing: type differs"), "{joined}");
        // The clean file produced no mismatch.
        assert!(!joined.contains("same.txt"), "{joined}");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn symlink_targets_compared_never_followed() {
        let d = tmp("links");
        fs::create_dir_all(d.join("a")).unwrap();
        fs::create_dir_all(d.join("b")).unwrap();
        // Both dangle — that's fine, targets are compared as strings.
        std::os::unix::fs::symlink("/nonexistent/one", d.join("a/l")).unwrap();
        std::os::unix::fs::symlink("/nonexistent/two", d.join("b/l")).unwrap();
        let r = checksum_compare(&d.join("a"), &d.join("b"), &never());
        assert_eq!(r.mismatches.len(), 1);
        assert!(r.mismatches[0].contains("symlink target differs"));
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn cancellation_stops_early() {
        let d = tmp("cancelv");
        fs::create_dir_all(d.join("a")).unwrap();
        fs::create_dir_all(d.join("b")).unwrap();
        for i in 0..20 {
            fs::write(d.join("a").join(format!("f{i:02}")), b"x").unwrap();
            fs::write(d.join("b").join(format!("f{i:02}")), b"x").unwrap();
        }
        let count = std::cell::Cell::new(0);
        let cancelled = move || {
            count.set(count.get() + 1);
            count.get() > 5
        };
        let r = checksum_compare(&d.join("a"), &d.join("b"), &cancelled);
        assert!(r.cancelled);
        fs::remove_dir_all(&d).ok();
    }

    fn byte_copy(from: &Path, to: &Path) {
        // Explicit read/write: std::fs::copy would clone on APFS.
        fs::write(to, fs::read(from).unwrap()).unwrap();
    }

    #[test]
    fn clones_are_proven_identical_without_hashing_byte_copies_are_not() {
        let d = tmp("clone");
        let src = d.join("src.bin");
        fs::write(&src, (0..3_000_000u32).map(|i| (i % 251) as u8).collect::<Vec<_>>()).unwrap();
        let byte = d.join("byte.bin");
        byte_copy(&src, &byte);
        let open = |p: &Path| fs::File::open(p).unwrap();
        let len = fs::metadata(&src).unwrap().len();
        assert!(!shares_all_extents(&open(&src), &open(&byte), len), "byte copy owns its blocks");

        let clone = d.join("clone.bin");
        if crate::core::copier::clone_entry(&src, &clone).is_ok() {
            // APFS clone: same physical extents end to end.
            assert!(shares_all_extents(&open(&src), &open(&clone), len));
            let r = checksum_compare(&src, &clone, &never());
            assert!(r.mismatches.is_empty(), "{:?}", r.mismatches);
        }
        let r = checksum_compare(&src, &byte, &never());
        assert!(r.mismatches.is_empty(), "{:?}", r.mismatches);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn large_files_hash_concurrently_and_still_catch_a_late_flip() {
        let d = tmp("bigflip");
        let mut data = vec![9u8; 3 * 1024 * 1024 + 17];
        fs::write(d.join("a.bin"), &data).unwrap();
        *data.last_mut().unwrap() = 8; // same size, last byte differs
        fs::write(d.join("b.bin"), &data).unwrap();
        let r = checksum_compare(&d.join("a.bin"), &d.join("b.bin"), &never());
        assert_eq!(r.mismatches.len(), 1, "{:?}", r.mismatches);
        assert!(r.mismatches[0].contains("checksum mismatch"));
        // Size mismatch short-circuits to the same verdict.
        fs::write(d.join("c.bin"), &data[..10]).unwrap();
        let r = checksum_compare(&d.join("a.bin"), &d.join("c.bin"), &never());
        assert!(r.mismatches[0].contains("checksum mismatch"));
        // Cancellation reaches the concurrent path too.
        byte_copy(&d.join("a.bin"), &d.join("e.bin"));
        let r = checksum_compare(&d.join("a.bin"), &d.join("e.bin"), &|| true);
        assert!(r.cancelled);
        fs::remove_dir_all(&d).ok();
    }
}
