//! All-or-nothing two-phase batch rename.
//!
//! Phase 1 renames every source to a hidden temp
//! (`.fazi-batchrename-<tag>-<i>`), phase 2 renames temps to finals — which
//! makes permutations (`1.jpg` ↔ `2.jpg`) safe. Any failure rolls back in
//! reverse; if the rollback itself fails mid-way, the error explicitly lists
//! the pairs left in intermediate state.
//!
//! The engine is parameterized over a rename seam (like `Trasher`) so tests
//! can inject failures at a chosen pair — filesystem-permission tricks can
//! fail before phase 1 even starts.

use std::io;
use std::path::{Path, PathBuf};

use crate::core::walker::exists_ci;

/// Injectable rename — production passes `std::fs::rename`.
pub type RenameSeam<'a> = &'a dyn Fn(&Path, &Path) -> io::Result<()>;

pub fn std_rename(from: &Path, to: &Path) -> io::Result<()> {
    std::fs::rename(from, to)
}

/// Illegal characters in a macOS file name (POSIX layer).
pub fn validate_name(name: &str) -> io::Result<()> {
    let bad = |m: &str| Err(io::Error::new(io::ErrorKind::InvalidInput, m.to_string()));
    if name.is_empty() {
        return bad("name can't be empty");
    }
    if name.contains('/') {
        return bad("name can't contain \"/\"");
    }
    if name.contains('\0') {
        return bad("invalid name");
    }
    if name == "." || name == ".." {
        return bad("invalid name");
    }
    Ok(())
}

/// Validate a whole batch up front — nothing mutates unless every pair
/// passes. `pairs` are (fromName, toName) within `parent`.
pub fn validate_batch(parent: &Path, pairs: &[(String, String)]) -> io::Result<()> {
    if pairs.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "nothing to rename"));
    }
    let source_lower: std::collections::HashSet<String> =
        pairs.iter().map(|(f, _)| f.to_lowercase()).collect();
    let mut target_lower: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (from, to) in pairs {
        validate_name(to)?;
        if parent.join(from).symlink_metadata().is_err() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("\"{from}\" no longer exists"),
            ));
        }
        // Intra-batch case-insensitive duplicate targets.
        if !target_lower.insert(to.to_lowercase()) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("two items would be named \"{to}\""),
            ));
        }
        // Collision with an existing item — batch sources excluded (their
        // names are being vacated; case-only mass renames stay legal).
        if !source_lower.contains(&to.to_lowercase()) && exists_ci(parent, to) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("\"{to}\" already exists"),
            ));
        }
    }
    Ok(())
}

fn temp_name(tag: &str, i: usize) -> String {
    format!(".fazi-batchrename-{tag}-{i}")
}

fn residual_error(op: &str, cause: &io::Error, residual: &[(PathBuf, PathBuf)]) -> io::Error {
    let list = residual
        .iter()
        .map(|(a, b)| format!("\"{}\" → \"{}\"", a.display(), b.display()))
        .collect::<Vec<_>>()
        .join(", ");
    io::Error::new(
        cause.kind(),
        format!(
            "{op} failed ({cause}) and rolling back also failed — these items were left renamed: {list}"
        ),
    )
}

/// Execute the two-phase rename. On success returns the final paths (same
/// order as `pairs`). On failure everything is rolled back — or, if the
/// rollback itself fails, the error lists what was left behind.
pub fn two_phase_rename(
    parent: &Path,
    pairs: &[(String, String)],
    tag: &str,
    rename: RenameSeam,
) -> io::Result<Vec<PathBuf>> {
    // Phase 1: sources → temps.
    let mut in_temp: Vec<usize> = Vec::new();
    for (i, (from, _)) in pairs.iter().enumerate() {
        match rename(&parent.join(from), &parent.join(temp_name(tag, i))) {
            Ok(()) => in_temp.push(i),
            Err(e) => {
                // Roll back the temps we made, in reverse.
                let mut residual: Vec<(PathBuf, PathBuf)> = Vec::new();
                for &j in in_temp.iter().rev() {
                    let temp = parent.join(temp_name(tag, j));
                    let orig = parent.join(&pairs[j].0);
                    if rename(&temp, &orig).is_err() {
                        residual.push((orig, temp));
                    }
                }
                if !residual.is_empty() {
                    return Err(residual_error("rename", &e, &residual));
                }
                return Err(e);
            }
        }
    }

    // Phase 2: temps → finals.
    for (i, (_, to)) in pairs.iter().enumerate() {
        match rename(&parent.join(temp_name(tag, i)), &parent.join(to)) {
            Ok(()) => {}
            Err(e) => {
                let mut residual: Vec<(PathBuf, PathBuf)> = Vec::new();
                // Promoted finals back to temps (reverse)…
                for j in (0..i).rev() {
                    let fin = parent.join(&pairs[j].1);
                    let temp = parent.join(temp_name(tag, j));
                    if rename(&fin, &temp).is_err() {
                        residual.push((parent.join(&pairs[j].0), fin));
                    }
                }
                // …then every temp back to its source (reverse).
                for j in (0..pairs.len()).rev() {
                    let temp = parent.join(temp_name(tag, j));
                    if temp.symlink_metadata().is_err() {
                        continue; // already restored or listed as residual
                    }
                    let orig = parent.join(&pairs[j].0);
                    if rename(&temp, &orig).is_err() {
                        residual.push((orig, temp));
                    }
                }
                if !residual.is_empty() {
                    return Err(residual_error("rename", &e, &residual));
                }
                return Err(e);
            }
        }
    }
    Ok(pairs.iter().map(|(_, to)| parent.join(to)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::fs;

    fn tmp(name: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("fazi-batch-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    #[test]
    fn happy_path_renames_all() {
        let d = tmp("happy");
        fs::write(d.join("a.txt"), b"a").unwrap();
        fs::write(d.join("b.txt"), b"b").unwrap();
        let p = pairs(&[("a.txt", "one.txt"), ("b.txt", "two.txt")]);
        validate_batch(&d, &p).unwrap();
        let out = two_phase_rename(&d, &p, "t", &std_rename).unwrap();
        assert_eq!(out, vec![d.join("one.txt"), d.join("two.txt")]);
        assert_eq!(names(&d), vec!["one.txt", "two.txt"]);
        assert_eq!(fs::read(d.join("one.txt")).unwrap(), b"a");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn permutation_swap_is_safe() {
        let d = tmp("swap");
        fs::write(d.join("1.jpg"), b"one").unwrap();
        fs::write(d.join("2.jpg"), b"two").unwrap();
        let p = pairs(&[("1.jpg", "2.jpg"), ("2.jpg", "1.jpg")]);
        validate_batch(&d, &p).unwrap();
        two_phase_rename(&d, &p, "t", &std_rename).unwrap();
        assert_eq!(fs::read(d.join("2.jpg")).unwrap(), b"one");
        assert_eq!(fs::read(d.join("1.jpg")).unwrap(), b"two");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn case_only_mass_rename_allowed() {
        let d = tmp("caseonly");
        fs::write(d.join("readme.md"), b"1").unwrap();
        fs::write(d.join("notes.md"), b"2").unwrap();
        let p = pairs(&[("readme.md", "README.md"), ("notes.md", "NOTES.md")]);
        validate_batch(&d, &p).unwrap();
        two_phase_rename(&d, &p, "t", &std_rename).unwrap();
        assert_eq!(names(&d), vec!["NOTES.md", "README.md"]);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn validation_rejects_dups_collisions_and_bad_names() {
        let d = tmp("validate");
        fs::write(d.join("a.txt"), b"a").unwrap();
        fs::write(d.join("b.txt"), b"b").unwrap();
        fs::write(d.join("taken.txt"), b"t").unwrap();
        // Intra-batch case-insensitive duplicate targets.
        let e = validate_batch(&d, &pairs(&[("a.txt", "X.txt"), ("b.txt", "x.TXT")]))
            .unwrap_err();
        assert!(e.to_string().contains("two items"), "{e}");
        // Collision with an existing non-batch item.
        let e = validate_batch(&d, &pairs(&[("a.txt", "TAKEN.txt")])).unwrap_err();
        assert!(e.to_string().contains("already exists"), "{e}");
        // Illegal name.
        assert!(validate_batch(&d, &pairs(&[("a.txt", "x/y")])).is_err());
        // Missing source.
        assert!(validate_batch(&d, &pairs(&[("ghost.txt", "g.txt")])).is_err());
        fs::remove_dir_all(&d).ok();
    }

    /// A seam that fails on the Nth rename call overall.
    fn failing_seam(fail_at: usize) -> (impl Fn(&Path, &Path) -> io::Result<()>, ()) {
        let count = Cell::new(0usize);
        (
            move |from: &Path, to: &Path| {
                let n = count.get();
                count.set(n + 1);
                if n == fail_at {
                    return Err(io::Error::new(io::ErrorKind::PermissionDenied, "injected"));
                }
                std::fs::rename(from, to)
            },
            (),
        )
    }

    #[test]
    fn phase1_failure_at_pair_k_rolls_back_cleanly() {
        let d = tmp("p1fail");
        for n in ["a.txt", "b.txt", "c.txt"] {
            fs::write(d.join(n), n.as_bytes()).unwrap();
        }
        let p = pairs(&[("a.txt", "x.txt"), ("b.txt", "y.txt"), ("c.txt", "z.txt")]);
        // Fail on the 3rd rename call = phase-1 rename of pair index 2.
        let (seam, ()) = failing_seam(2);
        let err = two_phase_rename(&d, &p, "t", &seam).unwrap_err();
        assert!(err.to_string().contains("injected"), "{err}");
        // Everything back at its original name, no temps.
        assert_eq!(names(&d), vec!["a.txt", "b.txt", "c.txt"]);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn phase2_failure_at_pair_k_rolls_back_cleanly() {
        let d = tmp("p2fail");
        for n in ["a.txt", "b.txt", "c.txt"] {
            fs::write(d.join(n), n.as_bytes()).unwrap();
        }
        let p = pairs(&[("a.txt", "x.txt"), ("b.txt", "y.txt"), ("c.txt", "z.txt")]);
        // Calls: 3 phase-1 renames (0,1,2), then phase-2 at 3,4,5 — fail the
        // middle phase-2 promote (call index 4).
        let (seam, ()) = failing_seam(4);
        let err = two_phase_rename(&d, &p, "t", &seam).unwrap_err();
        assert!(err.to_string().contains("injected"), "{err}");
        assert_eq!(names(&d), vec!["a.txt", "b.txt", "c.txt"]);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn rollback_failure_lists_residual_pairs() {
        let d = tmp("rollfail");
        for n in ["a.txt", "b.txt"] {
            fs::write(d.join(n), n.as_bytes()).unwrap();
        }
        let p = pairs(&[("a.txt", "x.txt"), ("b.txt", "y.txt")]);
        // Fail the 2nd phase-1 rename AND the rollback rename that follows.
        let count = Cell::new(0usize);
        let seam = move |from: &Path, to: &Path| {
            let n = count.get();
            count.set(n + 1);
            if n == 1 || n == 2 {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, "injected"));
            }
            std::fs::rename(from, to)
        };
        let err = two_phase_rename(&d, &p, "t", &seam).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("rolling back also failed"), "{msg}");
        assert!(msg.contains("a.txt"), "the residual pair names the stuck item: {msg}");
        fs::remove_dir_all(&d).ok();
    }
}
