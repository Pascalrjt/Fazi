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

fn hash_file(path: &Path, cancelled: &dyn Fn() -> bool) -> io::Result<Option<blake3::Hash>> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; CHUNK];
    loop {
        // Cancel checked per 4 MiB chunk within large files.
        if cancelled() {
            return Ok(None);
        }
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(Some(hasher.finalize()))
}

/// Compare `src` and `dst` (file, dir, or symlink) by content checksum.
pub fn checksum_compare(
    src: &Path,
    dst: &Path,
    cancelled: &dyn Fn() -> bool,
) -> ChecksumReport {
    let mut report = ChecksumReport { mismatches: Vec::new(), cancelled: false };
    compare_entry(src, dst, cancelled, &mut report);
    report
}

fn compare_entry(
    src: &Path,
    dst: &Path,
    cancelled: &dyn Fn() -> bool,
    report: &mut ChecksumReport,
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
            match (hash_file(src, cancelled), hash_file(dst, cancelled)) {
                (Ok(Some(a)), Ok(Some(b))) => {
                    if a != b {
                        report.mismatches.push(format!("{}: checksum mismatch", dst.display()));
                    }
                }
                (Ok(None), _) | (_, Ok(None)) => report.cancelled = true,
                (Err(e), _) | (_, Err(e)) => report
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
        (Kind::Dir, Kind::Dir) => compare_dir(src, dst, cancelled, report),
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
                compare_entry(&src.join(a), &dst.join(a), cancelled, report);
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
}
