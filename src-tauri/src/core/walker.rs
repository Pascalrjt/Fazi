//! Custom recursive walker: per-entry clone-then-copy ladder, cancellation
//! checks between entries, per-entry error collection, lazy conflict
//! resolution, symlink-aware (links are copied as links, never followed).
//!
//! Staging tiers (see plan):
//! - fresh copy/replace of an item: copy to `.<name>.fazi-partial-<opid>` in
//!   the destination dir, then one atomic promote.
//! - directory merge: per-entry staging — each file stages and promotes
//!   atomically; a crash leaves a partially-merged dir but never a
//!   half-written file.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};

use crate::core::copier::{self, CopyEnd};
use crate::core::entry::is_dataless;
use crate::core::tags::TAGS_XATTR;

// ---------------------------------------------------------------------------
// Sink: how the walker talks to the op engine (and to tests)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictKind {
    FileFile,
    DirDir,
    FileDir,
    DirFile,
}

impl ConflictKind {
    pub fn wire(&self) -> &'static str {
        match self {
            ConflictKind::FileFile => "fileFile",
            ConflictKind::DirDir => "dirDir",
            ConflictKind::FileDir => "fileDir",
            ConflictKind::DirFile => "dirFile",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolution {
    KeepBoth,
    Replace,
    Merge,
    Skip,
    Cancel,
}

/// Abstraction over the system Trash so the engine is unit-testable.
pub trait Trasher: Send + Sync {
    /// Move `path` to the Trash, returning where it landed.
    fn trash(&self, path: &Path) -> io::Result<PathBuf>;
}

/// Test/fallback trasher: moves items into a designated directory.
pub struct DirTrasher(pub PathBuf);

impl Trasher for DirTrasher {
    fn trash(&self, path: &Path) -> io::Result<PathBuf> {
        std::fs::create_dir_all(&self.0)?;
        let name = path
            .file_name()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no file name"))?;
        let mut dst = self.0.join(name);
        let mut n = 1;
        while dst.symlink_metadata().is_ok() {
            n += 1;
            dst = self.0.join(format!("{} {}", name.to_string_lossy(), n));
        }
        std::fs::rename(path, &dst)?;
        Ok(dst)
    }
}

pub trait WalkSink {
    fn cancelled(&self) -> bool;
    fn progress(&mut self, bytes_delta: u64, entries_delta: u64, current: &Path, cloned: bool);
    fn item_error(&mut self, path: &Path, err: &io::Error);
    fn skipped_dataless(&mut self, path: &Path);
    /// Resolve a conflict. May block on the user (op engine) or return a
    /// canned policy (tests). `dst` is the existing destination item.
    fn resolve(&mut self, kind: ConflictKind, src: &Path, dst: &Path) -> Resolution;
}

/// Minimal sink for internal steps that cannot conflict.
pub struct SilentSink;
impl WalkSink for SilentSink {
    fn cancelled(&self) -> bool {
        false
    }
    fn progress(&mut self, _: u64, _: u64, _: &Path, _: bool) {}
    fn item_error(&mut self, _: &Path, _: &io::Error) {}
    fn skipped_dataless(&mut self, _: &Path) {}
    fn resolve(&mut self, _: ConflictKind, _: &Path, _: &Path) -> Resolution {
        Resolution::Skip
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Done,
    Cancelled,
}

// ---------------------------------------------------------------------------
// Naming helpers
// ---------------------------------------------------------------------------

pub fn staging_name(name: &str, op_id: &str) -> String {
    format!(".{}.fazi-partial-{}", name, op_id)
}

pub fn is_staging_name(name: &str, op_id: &str) -> bool {
    name.ends_with(&format!(".fazi-partial-{}", op_id))
}

fn split_name(name: &str) -> (&str, String) {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => (stem, format!(".{}", ext)),
        _ => (name, String::new()),
    }
}

/// Case-insensitive existence check (APFS default semantics on every volume).
pub fn exists_ci(dir: &Path, name: &str) -> bool {
    if dir.join(name).symlink_metadata().is_ok() {
        return true;
    }
    let lower = name.to_lowercase();
    match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .flatten()
            .any(|e| e.file_name().to_string_lossy().to_lowercase() == lower),
        Err(_) => false,
    }
}

/// "name.ext" → "name 2.ext", "name 3.ext", … first available (Keep Both).
pub fn keep_both_name(dir: &Path, name: &str) -> String {
    let (stem, ext) = split_name(name);
    for n in 2..10_000 {
        let candidate = format!("{} {}{}", stem, n, ext);
        if !exists_ci(dir, &candidate) {
            return candidate;
        }
    }
    format!("{} {}{}", stem, uuid::Uuid::new_v4().simple(), ext)
}

/// "name.ext" → "name copy.ext", "name copy 2.ext", … (Duplicate).
pub fn duplicate_name(dir: &Path, name: &str) -> String {
    let (stem, ext) = split_name(name);
    let first = format!("{} copy{}", stem, ext);
    if !exists_ci(dir, &first) {
        return first;
    }
    for n in 2..10_000 {
        let candidate = format!("{} copy {}{}", stem, n, ext);
        if !exists_ci(dir, &candidate) {
            return candidate;
        }
    }
    format!("{} copy {}{}", stem, uuid::Uuid::new_v4().simple(), ext)
}

/// "untitled folder", "untitled folder 2", …
pub fn new_folder_name(dir: &Path, base: &str) -> String {
    if !exists_ci(dir, base) {
        return base.to_string();
    }
    for n in 2..10_000 {
        let candidate = format!("{} {}", base, n);
        if !exists_ci(dir, &candidate) {
            return candidate;
        }
    }
    format!("{} {}", base, uuid::Uuid::new_v4().simple())
}

pub fn remove_tree_best_effort(path: &Path) {
    let _ = match path.symlink_metadata() {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(_) => Ok(()),
    };
}

// ---------------------------------------------------------------------------
// Fresh copy (into a non-existing destination — staging tier 1)
// ---------------------------------------------------------------------------

/// Copy `src` (file, dir, or symlink) to `dst`, which must not exist.
/// Per-entry clone-then-copy ladder with cancellation between entries.
pub fn copy_fresh(src: &Path, dst: &Path, sink: &mut dyn WalkSink) -> io::Result<Outcome> {
    if sink.cancelled() {
        return Ok(Outcome::Cancelled);
    }
    let meta = src.symlink_metadata()?;

    if meta.file_type().is_dir() {
        std::fs::create_dir(dst)?;
        let mut children: Vec<_> = std::fs::read_dir(src)?.flatten().collect();
        children.sort_by_key(|e| e.file_name());
        for child in children {
            if sink.cancelled() {
                return Ok(Outcome::Cancelled);
            }
            let name = child.file_name();
            let cdst = dst.join(&name);
            match copy_fresh(&child.path(), &cdst, sink) {
                Ok(Outcome::Cancelled) => return Ok(Outcome::Cancelled),
                Ok(Outcome::Done) => {}
                Err(e) => sink.item_error(&child.path(), &e),
            }
        }
        // Directory metadata (perms, times, xattrs/tags) after children.
        if let Err(e) = copier::copy_metadata(src, dst) {
            sink.item_error(src, &e);
        }
        sink.progress(0, 1, src, true);
        return Ok(Outcome::Done);
    }

    // File or symlink.
    if meta.file_type().is_file() && is_dataless(&meta) {
        sink.skipped_dataless(src);
        return Ok(Outcome::Done);
    }
    let size = if meta.file_type().is_file() { meta.len() } else { 0 };

    match copier::clone_entry(src, dst) {
        Ok(()) => {
            // man copyfile: no progress callbacks on the clone path — count entries.
            sink.progress(size, 1, src, true);
            Ok(Outcome::Done)
        }
        Err(_) => {
            // Any clone failure degrades honestly to a byte copy.
            let mut last = 0u64;
            let end = {
                let sink_cell = std::cell::RefCell::new(&mut *sink);
                copier::copy_file_all(src, dst, &mut |bytes| {
                    let mut s = sink_cell.borrow_mut();
                    let delta = bytes.saturating_sub(last);
                    last = bytes;
                    s.progress(delta, 0, src, false);
                    !s.cancelled()
                })?
            };
            match end {
                CopyEnd::Done => {
                    sink.progress(size.saturating_sub(last), 1, src, false);
                    Ok(Outcome::Done)
                }
                CopyEnd::Cancelled => Ok(Outcome::Cancelled),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Verification (cross-volume moves; plan §engine)
// ---------------------------------------------------------------------------

/// Xattrs that legitimately differ between source and copy.
const VOLATILE_XATTRS: &[&str] = &[
    "com.apple.provenance",
    "com.apple.quarantine",
    "com.apple.lastuseddate#PS",
    "com.apple.macl",
];

/// mtime tolerance for a destination volume, per filesystem (ms).
pub fn mtime_tolerance_ms(dst: &Path) -> i64 {
    match copier::fs_type_name(dst).as_str() {
        "apfs" | "hfs" => 2,          // exact (allow ns→ms rounding)
        "msdos" | "exfat" => 2_000,   // FAT stores 2 s granularity
        "smbfs" | "nfs" | "webdav" => 5_000,
        _ => 2_000,
    }
}

pub struct VerifyReport {
    pub mismatches: Vec<String>,
    pub entries_checked: u64,
}

/// Re-lstat every copied entry: size, entry count, mtime (with tolerance);
/// plus metadata spot-checks (full xattr name-set + Finder-tag value) for a
/// sample of files (all files if ≤ 20).
pub fn verify_tree(
    src: &Path,
    dst: &Path,
    skipped: &HashSet<PathBuf>,
    tol_ms: i64,
) -> io::Result<VerifyReport> {
    let mut files: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut mismatches = Vec::new();
    let mut entries = 0u64;
    collect_verify(src, dst, skipped, tol_ms, &mut files, &mut mismatches, &mut entries)?;

    // Metadata spot-checks: all files if ≤ 20, else every ceil(n/20)-th.
    let step = (files.len() / 20).max(1);
    for (s, d) in files.iter().step_by(step) {
        verify_metadata(s, d, &mut mismatches);
    }
    Ok(VerifyReport { mismatches, entries_checked: entries })
}

fn collect_verify(
    src: &Path,
    dst: &Path,
    skipped: &HashSet<PathBuf>,
    tol_ms: i64,
    files: &mut Vec<(PathBuf, PathBuf)>,
    mismatches: &mut Vec<String>,
    entries: &mut u64,
) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    if skipped.contains(src) {
        return Ok(());
    }
    let sm = src.symlink_metadata()?;
    let dm = match dst.symlink_metadata() {
        Ok(m) => m,
        Err(_) => {
            mismatches.push(format!("{}: missing at destination", dst.display()));
            return Ok(());
        }
    };
    *entries += 1;

    if sm.file_type().is_dir() {
        if !dm.file_type().is_dir() {
            mismatches.push(format!("{}: expected directory", dst.display()));
            return Ok(());
        }
        let mut src_children: Vec<_> = std::fs::read_dir(src)?
            .flatten()
            .map(|e| e.file_name())
            .collect();
        src_children.sort();
        for name in src_children {
            let s = src.join(&name);
            if skipped.contains(&s) {
                continue;
            }
            collect_verify(&s, &dst.join(&name), skipped, tol_ms, files, mismatches, entries)?;
        }
        return Ok(());
    }

    if sm.file_type().is_file() {
        if sm.len() != dm.len() {
            mismatches.push(format!(
                "{}: size {} ≠ {}",
                dst.display(),
                dm.len(),
                sm.len()
            ));
        }
        let delta = ((sm.mtime() * 1000 + sm.mtime_nsec() / 1_000_000)
            - (dm.mtime() * 1000 + dm.mtime_nsec() / 1_000_000))
            .abs();
        if delta > tol_ms {
            mismatches.push(format!("{}: mtime drift {} ms", dst.display(), delta));
        }
        files.push((src.to_path_buf(), dst.to_path_buf()));
    }
    Ok(())
}

fn xattr_names(path: &Path) -> HashSet<String> {
    xattr::list(path)
        .map(|it| {
            it.map(|n| n.to_string_lossy().into_owned())
                .filter(|n| !VOLATILE_XATTRS.contains(&n.as_str()))
                .collect()
        })
        .unwrap_or_default()
}

fn verify_metadata(src: &Path, dst: &Path, mismatches: &mut Vec<String>) {
    let sn = xattr_names(src);
    let dn = xattr_names(dst);
    if sn != dn {
        mismatches.push(format!(
            "{}: xattr set differs (src {:?} vs dst {:?})",
            dst.display(),
            sn,
            dn
        ));
        return;
    }
    if sn.contains(TAGS_XATTR) {
        let s = xattr::get(src, TAGS_XATTR).ok().flatten();
        let d = xattr::get(dst, TAGS_XATTR).ok().flatten();
        if s != d {
            mismatches.push(format!("{}: Finder tags differ", dst.display()));
        }
    }
}

// ---------------------------------------------------------------------------
// Replace transaction (file vs file / whole-dir replace)
// ---------------------------------------------------------------------------

/// Replace `dst` with fully-staged `staged`: swap atomically on APFS
/// (`renamex_np(RENAME_SWAP)`), then trash the swapped-out original.
/// On filesystems without swap: trash original → promote → on promote
/// failure restore the original from the Trash.
/// Returns the trashed location of the old destination.
pub fn replace_with_staged(
    staged: &Path,
    dst: &Path,
    trasher: &dyn Trasher,
) -> io::Result<PathBuf> {
    match copier::rename_swap(staged, dst) {
        Ok(()) => {
            // staged path now holds the old original.
            let trashed = trasher.trash(staged)?;
            Ok(trashed)
        }
        Err(e) if matches!(e.raw_os_error(), Some(libc::ENOTSUP) | Some(libc::ENOSYS) | Some(libc::EINVAL)) => {
            let trashed = trasher.trash(dst)?;
            match copier::rename_excl(staged, dst) {
                Ok(()) => Ok(trashed),
                Err(promote_err) => {
                    // Restore the original from the Trash — never leave the
                    // destination path empty.
                    let _ = std::fs::rename(&trashed, dst);
                    Err(promote_err)
                }
            }
        }
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------------------
// Merge (per-entry staging tier)
// ---------------------------------------------------------------------------

pub struct MergeCtx<'a> {
    pub op_id: &'a str,
    pub trasher: &'a dyn Trasher,
    /// True for moves (rename fast path per entry, prune emptied source dirs).
    pub moving: bool,
    /// Verify+delete-source tolerance for cross-volume moved entries.
    pub tol_ms: i64,
}

/// Merge the contents of `src` dir into existing `dst` dir.
/// Per-entry staging: each file stages and promotes atomically.
/// For moves, verified entries are removed from the source as they land.
pub fn merge_into(
    src: &Path,
    dst: &Path,
    ctx: &MergeCtx,
    sink: &mut dyn WalkSink,
) -> io::Result<Outcome> {
    // Build the case-insensitive name map for this destination dir once.
    let mut existing: HashMap<String, String> = HashMap::new();
    for e in std::fs::read_dir(dst)?.flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        existing.insert(n.to_lowercase(), n);
    }

    let mut children: Vec<_> = std::fs::read_dir(src)?.flatten().collect();
    children.sort_by_key(|e| e.file_name());

    for child in children {
        if sink.cancelled() {
            return Ok(Outcome::Cancelled);
        }
        let spath = child.path();
        let name = child.file_name().to_string_lossy().into_owned();
        let smeta = match spath.symlink_metadata() {
            Ok(m) => m,
            Err(e) => {
                sink.item_error(&spath, &e);
                continue;
            }
        };
        let src_is_dir = smeta.file_type().is_dir();

        if smeta.file_type().is_file() && is_dataless(&smeta) {
            sink.skipped_dataless(&spath);
            continue;
        }

        let existing_name = existing.get(&name.to_lowercase()).cloned();
        match existing_name {
            None => {
                // No conflict: stage + promote (or plain rename for moves).
                let dpath = dst.join(&name);
                match transfer_entry(&spath, &dpath, ctx, sink)? {
                    Outcome::Cancelled => return Ok(Outcome::Cancelled),
                    Outcome::Done => {
                        existing.insert(name.to_lowercase(), name);
                    }
                }
            }
            Some(actual) => {
                let dpath = dst.join(&actual);
                let dmeta = match dpath.symlink_metadata() {
                    Ok(m) => m,
                    Err(_) => {
                        // Vanished — treat as no conflict.
                        match transfer_entry(&spath, &dpath, ctx, sink)? {
                            Outcome::Cancelled => return Ok(Outcome::Cancelled),
                            Outcome::Done => {}
                        }
                        continue;
                    }
                };
                let dst_is_dir = dmeta.file_type().is_dir();

                if src_is_dir && dst_is_dir {
                    // Sub-dirs merge recursively without prompting (file-level
                    // policy applies lazily inside).
                    match merge_into(&spath, &dpath, ctx, sink)? {
                        Outcome::Cancelled => return Ok(Outcome::Cancelled),
                        Outcome::Done => {}
                    }
                    if ctx.moving {
                        let _ = std::fs::remove_dir(&spath); // only if emptied
                    }
                    continue;
                }

                let kind = match (src_is_dir, dst_is_dir) {
                    (false, false) => ConflictKind::FileFile,
                    (false, true) => ConflictKind::FileDir,
                    (true, false) => ConflictKind::DirFile,
                    (true, true) => unreachable!(),
                };
                match sink.resolve(kind, &spath, &dpath) {
                    Resolution::Skip => continue,
                    Resolution::Cancel => return Ok(Outcome::Cancelled),
                    Resolution::KeepBoth => {
                        let kb = keep_both_name(dst, &name);
                        let dpath = dst.join(&kb);
                        match transfer_entry(&spath, &dpath, ctx, sink)? {
                            Outcome::Cancelled => return Ok(Outcome::Cancelled),
                            Outcome::Done => {
                                existing.insert(kb.to_lowercase(), kb);
                            }
                        }
                    }
                    Resolution::Replace | Resolution::Merge => {
                        // Stage the replacement fully, then swap+trash.
                        let stage = dst.join(staging_name(&name, ctx.op_id));
                        remove_tree_best_effort(&stage);
                        let staged = if ctx.moving {
                            match copier::rename(&spath, &stage) {
                                Ok(()) => Ok(Outcome::Done),
                                Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
                                    stage_cross_volume(&spath, &stage, ctx, sink)
                                }
                                Err(e) => Err(e),
                            }
                        } else {
                            copy_fresh(&spath, &stage, sink)
                        };
                        match staged {
                            Ok(Outcome::Cancelled) => {
                                remove_tree_best_effort(&stage);
                                return Ok(Outcome::Cancelled);
                            }
                            Ok(Outcome::Done) => match replace_with_staged(&stage, &dpath, ctx.trasher) {
                                Ok(_trashed) => {
                                    if ctx.moving && spath.symlink_metadata().is_ok() {
                                        remove_tree_best_effort(&spath);
                                    }
                                }
                                Err(e) => {
                                    remove_tree_best_effort(&stage);
                                    sink.item_error(&spath, &e);
                                }
                            },
                            Err(e) => {
                                remove_tree_best_effort(&stage);
                                sink.item_error(&spath, &e);
                            }
                        }
                    }
                }
            }
        }
    }

    if ctx.moving {
        let _ = std::fs::remove_dir(src); // only if emptied
    }
    Ok(Outcome::Done)
}

/// Move (fast path) or copy one non-conflicting entry into place, staged.
fn transfer_entry(
    src: &Path,
    dst: &Path,
    ctx: &MergeCtx,
    sink: &mut dyn WalkSink,
) -> io::Result<Outcome> {
    if ctx.moving {
        match copier::rename(src, dst) {
            Ok(()) => {
                sink.progress(0, 1, src, true);
                return Ok(Outcome::Done);
            }
            Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
                // fall through to staged copy + verify + delete
            }
            Err(e) => {
                sink.item_error(src, &e);
                return Ok(Outcome::Done);
            }
        }
    }

    let dir = dst.parent().unwrap_or_else(|| Path::new("/"));
    let name = dst
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stage = dir.join(staging_name(&name, ctx.op_id));
    remove_tree_best_effort(&stage);

    match copy_fresh(src, &stage, sink)? {
        Outcome::Cancelled => {
            remove_tree_best_effort(&stage);
            return Ok(Outcome::Cancelled);
        }
        Outcome::Done => {}
    }

    if ctx.moving {
        // Verify before the source is deleted — a crash mid-move never loses data.
        let report = verify_tree(src, &stage, &HashSet::new(), ctx.tol_ms)?;
        if !report.mismatches.is_empty() {
            remove_tree_best_effort(&stage);
            let e = io::Error::new(
                io::ErrorKind::InvalidData,
                format!("verification failed: {}", report.mismatches.join("; ")),
            );
            sink.item_error(src, &e);
            return Ok(Outcome::Done);
        }
    }

    match copier::rename_excl(&stage, dst) {
        Ok(()) => {}
        Err(e) => {
            remove_tree_best_effort(&stage);
            sink.item_error(src, &e);
            return Ok(Outcome::Done);
        }
    }
    if ctx.moving {
        remove_tree_best_effort(src);
    }
    Ok(Outcome::Done)
}

/// Cross-volume staging for a move-replace: staged copy + verify.
fn stage_cross_volume(
    src: &Path,
    stage: &Path,
    ctx: &MergeCtx,
    sink: &mut dyn WalkSink,
) -> io::Result<Outcome> {
    match copy_fresh(src, stage, sink)? {
        Outcome::Cancelled => Ok(Outcome::Cancelled),
        Outcome::Done => {
            let report = verify_tree(src, stage, &HashSet::new(), ctx.tol_ms)?;
            if report.mismatches.is_empty() {
                Ok(Outcome::Done)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("verification failed: {}", report.mismatches.join("; ")),
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct TestSink {
        cancel: AtomicBool,
        cancel_after_entries: Option<u64>,
        entries: u64,
        bytes: u64,
        errors: Vec<String>,
        skipped: Vec<PathBuf>,
        canned: Resolution,
        conflicts_seen: Vec<ConflictKind>,
    }

    impl TestSink {
        fn new(canned: Resolution) -> Self {
            TestSink {
                cancel: AtomicBool::new(false),
                cancel_after_entries: None,
                entries: 0,
                bytes: 0,
                errors: Vec::new(),
                skipped: Vec::new(),
                canned,
                conflicts_seen: Vec::new(),
            }
        }
    }

    impl WalkSink for TestSink {
        fn cancelled(&self) -> bool {
            self.cancel.load(Ordering::Relaxed)
        }
        fn progress(&mut self, b: u64, e: u64, _c: &Path, _cloned: bool) {
            self.bytes += b;
            self.entries += e;
            if let Some(limit) = self.cancel_after_entries {
                if self.entries >= limit {
                    self.cancel.store(true, Ordering::Relaxed);
                }
            }
        }
        fn item_error(&mut self, p: &Path, e: &io::Error) {
            self.errors.push(format!("{}: {}", p.display(), e));
        }
        fn skipped_dataless(&mut self, p: &Path) {
            self.skipped.push(p.to_path_buf());
        }
        fn resolve(&mut self, kind: ConflictKind, _s: &Path, _d: &Path) -> Resolution {
            self.conflicts_seen.push(kind);
            self.canned
        }
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fazi-walker-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn make_tree(root: &Path) {
        fs::create_dir_all(root.join("sub/deep")).unwrap();
        fs::write(root.join("a.txt"), b"alpha").unwrap();
        fs::write(root.join("sub/b.txt"), b"beta-beta").unwrap();
        fs::write(root.join("sub/deep/c.bin"), vec![9u8; 1024]).unwrap();
        std::os::unix::fs::symlink("a.txt", root.join("link")).unwrap();
        xattr::set(root.join("a.txt"), "com.fazi.mark", b"1").unwrap();
    }

    #[test]
    fn copy_fresh_full_tree() {
        let d = tmp("fresh");
        let src = d.join("src");
        make_tree(&src);
        let dst = d.join("dst");
        let mut sink = TestSink::new(Resolution::Skip);
        assert_eq!(copy_fresh(&src, &dst, &mut sink).unwrap(), Outcome::Done);
        assert_eq!(fs::read(dst.join("a.txt")).unwrap(), b"alpha");
        assert_eq!(fs::read(dst.join("sub/deep/c.bin")).unwrap().len(), 1024);
        assert!(fs::symlink_metadata(dst.join("link")).unwrap().file_type().is_symlink());
        assert_eq!(
            xattr::get(dst.join("a.txt"), "com.fazi.mark").unwrap().as_deref(),
            Some(b"1".as_ref())
        );
        // 4 files/links + 3 dirs
        assert_eq!(sink.entries, 7);
        assert!(sink.errors.is_empty());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn cancel_mid_walk_stops_cleanly() {
        let d = tmp("cancelwalk");
        let src = d.join("src");
        fs::create_dir_all(&src).unwrap();
        for i in 0..50 {
            fs::write(src.join(format!("f{:03}.txt", i)), b"data").unwrap();
        }
        let dst = d.join("dst");
        let mut sink = TestSink::new(Resolution::Skip);
        sink.cancel_after_entries = Some(10);
        assert_eq!(copy_fresh(&src, &dst, &mut sink).unwrap(), Outcome::Cancelled);
        // Caller removes staging; here we just assert the walk stopped early.
        assert!(sink.entries < 50);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn verify_catches_corruption_and_stripped_xattr() {
        let d = tmp("verify");
        let src = d.join("src");
        make_tree(&src);
        let dst = d.join("dst");
        let mut sink = TestSink::new(Resolution::Skip);
        copy_fresh(&src, &dst, &mut sink).unwrap();

        let clean = verify_tree(&src, &dst, &HashSet::new(), 2_000).unwrap();
        assert!(clean.mismatches.is_empty(), "{:?}", clean.mismatches);

        // Corrupt a copied file (size change) → verify must flag it.
        fs::write(dst.join("sub/b.txt"), b"short").unwrap();
        let bad = verify_tree(&src, &dst, &HashSet::new(), 60_000).unwrap();
        assert!(bad.mismatches.iter().any(|m| m.contains("b.txt")));

        // Strip an xattr from the copy → spot-check must flag it.
        fs::copy(src.join("sub/b.txt"), dst.join("sub/b.txt")).unwrap();
        xattr::remove(dst.join("a.txt"), "com.fazi.mark").unwrap();
        let bad2 = verify_tree(&src, &dst, &HashSet::new(), 60_000).unwrap();
        assert!(bad2.mismatches.iter().any(|m| m.contains("xattr")));
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn merge_copy_no_conflicts_promotes_all_and_leaves_no_staging() {
        let d = tmp("mergecopy");
        let src = d.join("src");
        make_tree(&src);
        let dst = d.join("dst");
        fs::create_dir_all(&dst).unwrap();
        fs::write(dst.join("existing.txt"), b"keep me").unwrap();

        let trash = DirTrasher(d.join("trash"));
        let ctx = MergeCtx { op_id: "op1", trasher: &trash, moving: false, tol_ms: 2_000 };
        let mut sink = TestSink::new(Resolution::Skip);
        assert_eq!(merge_into(&src, &dst, &ctx, &mut sink).unwrap(), Outcome::Done);

        assert_eq!(fs::read(dst.join("existing.txt")).unwrap(), b"keep me");
        assert_eq!(fs::read(dst.join("a.txt")).unwrap(), b"alpha");
        assert_eq!(fs::read(dst.join("sub/deep/c.bin")).unwrap().len(), 1024);
        // Source untouched by a copy-merge.
        assert!(src.join("a.txt").exists());
        // No staging artifacts anywhere.
        assert_staging_free(&dst, "op1");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn merge_file_conflict_policies() {
        let cases: Vec<(Resolution, fn(&Path))> = vec![
            (Resolution::Skip, |dst: &Path| {
                assert_eq!(fs::read(dst.join("a.txt")).unwrap(), b"old");
            }),
            (Resolution::Replace, |dst: &Path| {
                assert_eq!(fs::read(dst.join("a.txt")).unwrap(), b"alpha");
            }),
            (Resolution::KeepBoth, |dst: &Path| {
                assert_eq!(fs::read(dst.join("a.txt")).unwrap(), b"old");
                assert_eq!(fs::read(dst.join("a 2.txt")).unwrap(), b"alpha");
            }),
        ];
        for (policy, check) in cases {
            let d = tmp(&format!("mergepol{:?}", policy));
            let src = d.join("src");
            make_tree(&src);
            let dst = d.join("dst");
            fs::create_dir_all(&dst).unwrap();
            fs::write(dst.join("a.txt"), b"old").unwrap();

            let trash = DirTrasher(d.join("trash"));
            let ctx = MergeCtx { op_id: "op1", trasher: &trash, moving: false, tol_ms: 2_000 };
            let mut sink = TestSink::new(policy);
            merge_into(&src, &dst, &ctx, &mut sink).unwrap();
            assert_eq!(sink.conflicts_seen, vec![ConflictKind::FileFile]);
            check(&dst);
            assert_staging_free(&dst, "op1");
            fs::remove_dir_all(&d).ok();
        }
    }

    #[test]
    fn merge_move_moves_and_prunes_source() {
        let d = tmp("mergemove");
        let src = d.join("src");
        make_tree(&src);
        let dst = d.join("dst");
        fs::create_dir_all(dst.join("sub")).unwrap();
        fs::write(dst.join("sub/existing.txt"), b"x").unwrap();

        let trash = DirTrasher(d.join("trash"));
        let ctx = MergeCtx { op_id: "op2", trasher: &trash, moving: true, tol_ms: 2_000 };
        let mut sink = TestSink::new(Resolution::Skip);
        assert_eq!(merge_into(&src, &dst, &ctx, &mut sink).unwrap(), Outcome::Done);

        assert_eq!(fs::read(dst.join("a.txt")).unwrap(), b"alpha");
        assert_eq!(fs::read(dst.join("sub/b.txt")).unwrap(), b"beta-beta");
        assert!(dst.join("sub/existing.txt").exists());
        // Source fully consumed (all entries moved, dirs pruned).
        assert!(!src.exists(), "source should be pruned after full merge-move");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn file_vs_dir_conflict_is_surfaced() {
        let d = tmp("filevsdir");
        let src = d.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("thing"), b"file side").unwrap();
        let dst = d.join("dst");
        fs::create_dir_all(dst.join("thing")).unwrap();

        let trash = DirTrasher(d.join("trash"));
        let ctx = MergeCtx { op_id: "op3", trasher: &trash, moving: false, tol_ms: 2_000 };
        let mut sink = TestSink::new(Resolution::Skip);
        merge_into(&src, &dst, &ctx, &mut sink).unwrap();
        assert_eq!(sink.conflicts_seen, vec![ConflictKind::FileDir]);
        assert!(dst.join("thing").is_dir(), "skip must leave the dir");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn replace_transaction_trashes_original() {
        let d = tmp("replace");
        let staged = d.join("staged.txt");
        let dst = d.join("target.txt");
        fs::write(&staged, b"new").unwrap();
        fs::write(&dst, b"old").unwrap();
        let trash = DirTrasher(d.join("trash"));
        let trashed = replace_with_staged(&staged, &dst, &trash).unwrap();
        assert_eq!(fs::read(&dst).unwrap(), b"new");
        assert_eq!(fs::read(&trashed).unwrap(), b"old");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn keep_both_and_duplicate_names() {
        let d = tmp("names");
        fs::write(d.join("report.pdf"), b"1").unwrap();
        fs::write(d.join("report 2.pdf"), b"2").unwrap();
        assert_eq!(keep_both_name(&d, "report.pdf"), "report 3.pdf");
        assert_eq!(duplicate_name(&d, "report.pdf"), "report copy.pdf");
        fs::write(d.join("report copy.pdf"), b"3").unwrap();
        assert_eq!(duplicate_name(&d, "report.pdf"), "report copy 2.pdf");
        assert_eq!(new_folder_name(&d, "untitled folder"), "untitled folder");
        fs::create_dir(d.join("untitled folder")).unwrap();
        assert_eq!(new_folder_name(&d, "untitled folder"), "untitled folder 2");
        // Case-insensitive collision detection.
        assert_eq!(keep_both_name(&d, "REPORT.PDF"), "REPORT 3.PDF");
        fs::remove_dir_all(&d).ok();
    }

    fn assert_staging_free(root: &Path, op_id: &str) {
        for e in walk_all(root) {
            let name = e.file_name().unwrap().to_string_lossy().into_owned();
            assert!(
                !is_staging_name(&name, op_id),
                "staging artifact left behind: {}",
                e.display()
            );
        }
    }

    fn walk_all(root: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        if let Ok(rd) = fs::read_dir(root) {
            for e in rd.flatten() {
                out.push(e.path());
                if e.path().is_dir() {
                    out.extend(walk_all(&e.path()));
                }
            }
        }
        out
    }
}
