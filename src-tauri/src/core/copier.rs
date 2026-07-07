//! The one `unsafe` module: raw macOS copy primitives.
//!
//! Per-item attempt ladder (never trust volume detection up front):
//!   moves:  rename(2) → (EXDEV) staged copy + verify + delete
//!   copies: clonefile(2) → (ENOTSUP/EXDEV/…) copyfile(3) COPYFILE_ALL byte copy
//!
//! `COPYFILE_RECURSIVE` is deliberately never used — recursion lives in
//! `walker.rs` where we control cancellation, staging, and per-entry errors.

#![allow(non_camel_case_types)]

use std::ffi::{c_char, c_int, c_void, CString};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

type copyfile_state_t = *mut c_void;

extern "C" {
    fn copyfile(
        from: *const c_char,
        to: *const c_char,
        state: copyfile_state_t,
        flags: u32,
    ) -> c_int;
    fn copyfile_state_alloc() -> copyfile_state_t;
    fn copyfile_state_free(s: copyfile_state_t) -> c_int;
    fn copyfile_state_set(s: copyfile_state_t, flag: u32, value: *const c_void) -> c_int;
    fn copyfile_state_get(s: copyfile_state_t, flag: u32, dst: *mut c_void) -> c_int;
    fn clonefile(src: *const c_char, dst: *const c_char, flags: u32) -> c_int;
    fn renamex_np(from: *const c_char, to: *const c_char, flags: u32) -> c_int;
}

// copyfile.h flags
const COPYFILE_ACL: u32 = 1 << 0;
const COPYFILE_STAT: u32 = 1 << 1;
const COPYFILE_XATTR: u32 = 1 << 2;
const COPYFILE_DATA: u32 = 1 << 3;
const COPYFILE_SECURITY: u32 = COPYFILE_STAT | COPYFILE_ACL;
const COPYFILE_METADATA: u32 = COPYFILE_SECURITY | COPYFILE_XATTR;
const COPYFILE_ALL: u32 = COPYFILE_METADATA | COPYFILE_DATA;
const COPYFILE_NOFOLLOW_SRC: u32 = 1 << 18;
const COPYFILE_NOFOLLOW_DST: u32 = 1 << 19;
const COPYFILE_NOFOLLOW: u32 = COPYFILE_NOFOLLOW_SRC | COPYFILE_NOFOLLOW_DST;

// copyfile.h state selectors
const COPYFILE_STATE_STATUS_CB: u32 = 6;
const COPYFILE_STATE_STATUS_CTX: u32 = 7;
const COPYFILE_STATE_COPIED: u32 = 8;

// copyfile.h callback `what` / `stage` / return values
const COPYFILE_COPY_DATA: c_int = 4;
const COPYFILE_PROGRESS: c_int = 4;
const COPYFILE_CONTINUE: c_int = 0;
const COPYFILE_QUIT: c_int = 2;

// clonefile.h
const CLONE_NOFOLLOW: u32 = 0x0001;

// renamex_np flags (sys/stdio.h)
pub const RENAME_SWAP: u32 = 0x0000_0002;
pub const RENAME_EXCL: u32 = 0x0000_0004;

fn cstr(p: &Path) -> io::Result<CString> {
    CString::new(p.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))
}

fn last_errno() -> io::Error {
    io::Error::last_os_error()
}

/// Atomic same-volume rename. Fails with `CrossesDevices` (EXDEV) across volumes.
pub fn rename(src: &Path, dst: &Path) -> io::Result<()> {
    std::fs::rename(src, dst)
}

/// Atomic swap of two existing paths (APFS). ENOTSUP on filesystems without it.
pub fn rename_swap(a: &Path, b: &Path) -> io::Result<()> {
    let (ca, cb) = (cstr(a)?, cstr(b)?);
    if unsafe { renamex_np(ca.as_ptr(), cb.as_ptr(), RENAME_SWAP) } == 0 {
        Ok(())
    } else {
        Err(last_errno())
    }
}

/// Atomic promote that refuses to clobber: rename src→dst only if dst is absent.
pub fn rename_excl(src: &Path, dst: &Path) -> io::Result<()> {
    let (cs, cd) = (cstr(src)?, cstr(dst)?);
    if unsafe { renamex_np(cs.as_ptr(), cd.as_ptr(), RENAME_EXCL) } == 0 {
        return Ok(());
    }
    let err = last_errno();
    // Some filesystems lack renamex_np entirely; emulate (non-atomic window).
    if matches!(err.raw_os_error(), Some(libc::ENOTSUP) | Some(libc::ENOSYS)) {
        if dst.symlink_metadata().is_ok() {
            return Err(io::Error::from_raw_os_error(libc::EEXIST));
        }
        return std::fs::rename(src, dst);
    }
    Err(err)
}

/// APFS CoW clone of a single entry (file, symlink, or empty-clone of a dir).
/// Never follows symlinks. Fails if dst exists.
pub fn clone_entry(src: &Path, dst: &Path) -> io::Result<()> {
    let (cs, cd) = (cstr(src)?, cstr(dst)?);
    if unsafe { clonefile(cs.as_ptr(), cd.as_ptr(), CLONE_NOFOLLOW) } == 0 {
        Ok(())
    } else {
        Err(last_errno())
    }
}

/// How a byte-level copy ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyEnd {
    Done,
    Cancelled,
}

struct ProgressCtx<'a> {
    /// Called with total bytes copied so far for the current file.
    /// Return false to cancel.
    on_progress: &'a mut dyn FnMut(u64) -> bool,
}

extern "C" fn progress_trampoline(
    what: c_int,
    stage: c_int,
    state: copyfile_state_t,
    _src: *const c_char,
    _dst: *const c_char,
    ctx: *mut c_void,
) -> c_int {
    if what == COPYFILE_COPY_DATA && stage == COPYFILE_PROGRESS {
        let mut copied: libc::off_t = 0;
        unsafe {
            copyfile_state_get(
                state,
                COPYFILE_STATE_COPIED,
                &mut copied as *mut libc::off_t as *mut c_void,
            );
        }
        let cb = unsafe { &mut *(ctx as *mut ProgressCtx) };
        if !(cb.on_progress)(copied.max(0) as u64) {
            return COPYFILE_QUIT;
        }
    }
    COPYFILE_CONTINUE
}

/// Byte copy of a single file/symlink with full metadata (`COPYFILE_ALL`),
/// never following links, streaming progress. Removes a partial dst on
/// failure or cancellation.
pub fn copy_file_all(
    src: &Path,
    dst: &Path,
    on_progress: &mut dyn FnMut(u64) -> bool,
) -> io::Result<CopyEnd> {
    let (cs, cd) = (cstr(src)?, cstr(dst)?);
    let state = unsafe { copyfile_state_alloc() };
    if state.is_null() {
        return Err(io::Error::new(io::ErrorKind::OutOfMemory, "copyfile_state_alloc"));
    }
    let mut ctx = ProgressCtx { on_progress };
    let rc = unsafe {
        copyfile_state_set(
            state,
            COPYFILE_STATE_STATUS_CB,
            progress_trampoline as *const c_void,
        );
        copyfile_state_set(
            state,
            COPYFILE_STATE_STATUS_CTX,
            &mut ctx as *mut ProgressCtx as *const c_void,
        );
        copyfile(cs.as_ptr(), cd.as_ptr(), state, COPYFILE_ALL | COPYFILE_NOFOLLOW)
    };
    let err = if rc < 0 { Some(last_errno()) } else { None };
    unsafe { copyfile_state_free(state) };

    match err {
        None => Ok(CopyEnd::Done),
        Some(e) if e.raw_os_error() == Some(libc::ECANCELED) => {
            let _ = std::fs::remove_file(dst);
            Ok(CopyEnd::Cancelled)
        }
        Some(e) => {
            let _ = std::fs::remove_file(dst);
            Err(e)
        }
    }
}

/// Copy only metadata (permissions, times, xattrs, ACLs) — used to finish
/// directories after their children are copied.
pub fn copy_metadata(src: &Path, dst: &Path) -> io::Result<()> {
    let (cs, cd) = (cstr(src)?, cstr(dst)?);
    let rc = unsafe {
        copyfile(
            cs.as_ptr(),
            cd.as_ptr(),
            std::ptr::null_mut(),
            COPYFILE_METADATA | COPYFILE_NOFOLLOW,
        )
    };
    if rc < 0 {
        Err(last_errno())
    } else {
        Ok(())
    }
}

/// Filesystem type name of the volume containing `path` (e.g. "apfs",
/// "exfat", "msdos", "smbfs"). Used for mtime tolerance in verification.
pub fn fs_type_name(path: &Path) -> String {
    let Ok(c) = cstr(path) else {
        return String::new();
    };
    let mut sfs: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(c.as_ptr(), &mut sfs) } != 0 {
        return String::new();
    }
    let bytes: Vec<u8> = sfs
        .f_fstypename
        .iter()
        .take_while(|&&b| b != 0)
        .map(|&b| b as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Device id of the volume containing `path` — a *hint* for op scheduling
/// (per-volume serialization), never for correctness decisions.
pub fn device_of(path: &Path) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    std::fs::symlink_metadata(path).ok().map(|m| m.dev())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("fazi-copier-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn clone_or_copy_preserves_bytes() {
        let d = tmp("clone");
        let src = d.join("a.bin");
        fs::write(&src, vec![7u8; 1_000_000]).unwrap();
        let dst = d.join("b.bin");
        // On APFS /tmp this exercises the clone path; elsewhere it errors and
        // we fall back exactly like the walker does.
        if clone_entry(&src, &dst).is_err() {
            copy_file_all(&src, &dst, &mut |_| true).unwrap();
        }
        assert_eq!(fs::read(&dst).unwrap().len(), 1_000_000);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn copy_reports_progress_and_preserves_xattrs() {
        let d = tmp("progress");
        let src = d.join("src.bin");
        fs::write(&src, vec![1u8; 4 * 1024 * 1024]).unwrap();
        xattr::set(&src, "com.fazi.test", b"value").unwrap();
        let dst = d.join("dst.bin");
        let mut last = 0u64;
        let end = copy_file_all(&src, &dst, &mut |b| {
            last = b;
            true
        })
        .unwrap();
        assert_eq!(end, CopyEnd::Done);
        assert_eq!(last, 4 * 1024 * 1024);
        assert_eq!(
            xattr::get(&dst, "com.fazi.test").unwrap().as_deref(),
            Some(b"value".as_ref())
        );
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn cancelled_copy_removes_partial_dst() {
        let d = tmp("cancel");
        let src = d.join("src.bin");
        fs::write(&src, vec![2u8; 8 * 1024 * 1024]).unwrap();
        let dst = d.join("dst.bin");
        let end = copy_file_all(&src, &dst, &mut |_| false).unwrap();
        assert_eq!(end, CopyEnd::Cancelled);
        assert!(!dst.exists());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn copies_symlink_as_link() {
        let d = tmp("symlink");
        let target = d.join("target.txt");
        fs::write(&target, b"t").unwrap();
        let link = d.join("link");
        std::os::unix::fs::symlink("target.txt", &link).unwrap();
        let dst = d.join("link-copy");
        if clone_entry(&link, &dst).is_err() {
            copy_file_all(&link, &dst, &mut |_| true).unwrap();
        }
        let meta = fs::symlink_metadata(&dst).unwrap();
        assert!(meta.file_type().is_symlink());
        assert_eq!(fs::read_link(&dst).unwrap().to_str().unwrap(), "target.txt");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn rename_excl_refuses_to_clobber() {
        let d = tmp("excl");
        let a = d.join("a");
        let b = d.join("b");
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();
        let err = rename_excl(&a, &b).unwrap_err();
        assert_eq!(err.raw_os_error(), Some(libc::EEXIST));
        assert_eq!(fs::read(&b).unwrap(), b"b");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn swap_exchanges_contents() {
        let d = tmp("swap");
        let a = d.join("a");
        let b = d.join("b");
        fs::write(&a, b"aaa").unwrap();
        fs::write(&b, b"bbb").unwrap();
        match rename_swap(&a, &b) {
            Ok(()) => {
                assert_eq!(fs::read(&a).unwrap(), b"bbb");
                assert_eq!(fs::read(&b).unwrap(), b"aaa");
            }
            Err(e) => {
                // Non-APFS temp dir: swap unsupported is an accepted outcome.
                assert!(matches!(
                    e.raw_os_error(),
                    Some(libc::ENOTSUP) | Some(libc::ENOSYS)
                ));
            }
        }
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn fs_type_of_tmp_is_nonempty() {
        assert!(!fs_type_name(&std::env::temp_dir()).is_empty());
    }
}
