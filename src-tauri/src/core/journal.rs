//! Durable on-disk op journal — exists for *recovery*, not undo.
//!
//! One small JSON file per op under `<app-data>/ops-journal/`, written before
//! bytes move, updated as items promote, deleted on completion. On startup,
//! the journal is scanned: orphaned staging artifacts are deleted and
//! interrupted ops are reported to the user.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::core::walker::{is_staging_name, remove_tree_best_effort};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpJournalEntry {
    pub op_id: String,
    pub kind: String,
    pub sources: Vec<String>,
    pub dest_dir: String,
    /// Explicit staging paths (fresh-copy tier).
    pub staging: Vec<String>,
    /// Roots that may contain per-entry staging artifacts (merge tier) —
    /// recovery scans these for `*.fazi-partial-<opid>` names.
    pub merge_roots: Vec<String>,
    /// Promoted top-level destination paths.
    pub completed: Vec<String>,
    pub total: usize,
    pub started_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterruptedOp {
    pub op_id: String,
    pub kind: String,
    pub dest_dir: String,
    pub completed: usize,
    pub total: usize,
    pub started_at_ms: u64,
}

pub struct Journal {
    dir: PathBuf,
}

impl Journal {
    pub fn new(dir: PathBuf) -> std::io::Result<Self> {
        fs::create_dir_all(&dir)?;
        Ok(Journal { dir })
    }

    fn path_for(&self, op_id: &str) -> PathBuf {
        // op ids are UUIDs we mint — still, never trust them as path segments.
        let safe: String = op_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect();
        self.dir.join(format!("{}.json", safe))
    }

    /// Durable write: temp file + fsync + atomic rename + directory fsync.
    ///
    /// The directory fsync after the rename matters: without it, a crash can
    /// lose the rename itself, so a fail-fast caller's "write succeeded before
    /// mutation" would be a false promise. (macOS `fsync` doesn't force the
    /// drive's write cache; full power-loss durability would additionally need
    /// `fcntl(F_FULLFSYNC)` — out of scope, the threat model is app/OS crashes.)
    pub fn write(&self, entry: &OpJournalEntry) -> std::io::Result<()> {
        let final_path = self.path_for(&entry.op_id);
        let tmp = final_path.with_extension("json.tmp");
        let data = serde_json::to_vec_pretty(entry)?;
        {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(&data)?;
            f.sync_all()?;
        }
        fs::rename(&tmp, &final_path)?;
        fs::File::open(&self.dir)?.sync_all()
    }

    pub fn remove(&self, op_id: &str) {
        let _ = fs::remove_file(self.path_for(op_id));
    }

    /// Startup recovery: delete orphaned staging artifacts, report
    /// interrupted ops, clear the journal.
    pub fn recover(&self) -> Vec<InterruptedOp> {
        let mut report = Vec::new();
        let Ok(rd) = fs::read_dir(&self.dir) else {
            return report;
        };
        for f in rd.flatten() {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) != Some("json") {
                let _ = fs::remove_file(&p);
                continue;
            }
            let Ok(bytes) = fs::read(&p) else {
                let _ = fs::remove_file(&p);
                continue;
            };
            let Ok(entry) = serde_json::from_slice::<OpJournalEntry>(&bytes) else {
                let _ = fs::remove_file(&p);
                continue;
            };

            // 1. Remove explicit staging paths.
            for s in &entry.staging {
                remove_tree_best_effort(Path::new(s));
            }
            // 2. Scan merge roots for per-entry staging names.
            for root in &entry.merge_roots {
                remove_staging_recursive(Path::new(root), &entry.op_id);
            }

            report.push(InterruptedOp {
                op_id: entry.op_id,
                kind: entry.kind,
                dest_dir: entry.dest_dir,
                completed: entry.completed.len(),
                total: entry.total,
                started_at_ms: entry.started_at_ms,
            });
            let _ = fs::remove_file(&p);
        }
        report
    }
}

fn remove_staging_recursive(root: &Path, op_id: &str) {
    let Ok(rd) = fs::read_dir(root) else {
        return;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let p = e.path();
        if is_staging_name(&name, op_id) {
            remove_tree_best_effort(&p);
        } else if p.is_dir() && !p.is_symlink() {
            remove_staging_recursive(&p, op_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::walker::staging_name;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fazi-journal-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn recovery_removes_staging_and_reports() {
        let d = tmp("recover");
        let journal = Journal::new(d.join("journal")).unwrap();

        // Simulate a crash: staging artifacts on disk + journal entry, no cleanup.
        let dest = d.join("dest");
        fs::create_dir_all(dest.join("merged-into")).unwrap();
        let staged_top = dest.join(staging_name("BigFolder", "op-abc"));
        fs::create_dir_all(&staged_top).unwrap();
        fs::write(staged_top.join("partial.bin"), b"half").unwrap();
        let staged_entry = dest.join("merged-into").join(staging_name("file.txt", "op-abc"));
        fs::write(&staged_entry, b"half").unwrap();
        let promoted = dest.join("Done.txt");
        fs::write(&promoted, b"complete").unwrap();

        journal
            .write(&OpJournalEntry {
                op_id: "op-abc".into(),
                kind: "copy".into(),
                sources: vec!["/src/BigFolder".into()],
                dest_dir: dest.to_string_lossy().into_owned(),
                staging: vec![staged_top.to_string_lossy().into_owned()],
                merge_roots: vec![dest.to_string_lossy().into_owned()],
                completed: vec![promoted.to_string_lossy().into_owned()],
                total: 3,
                started_at_ms: 0,
            })
            .unwrap();

        let report = journal.recover();
        assert_eq!(report.len(), 1);
        assert_eq!(report[0].completed, 1);
        assert_eq!(report[0].total, 3);
        // Staging gone, promoted item untouched.
        assert!(!staged_top.exists());
        assert!(!staged_entry.exists());
        assert_eq!(fs::read(&promoted).unwrap(), b"complete");
        // Journal cleared: second recovery reports nothing.
        assert!(journal.recover().is_empty());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn completed_op_leaves_no_journal() {
        let d = tmp("complete");
        let journal = Journal::new(d.join("journal")).unwrap();
        let entry = OpJournalEntry {
            op_id: "op-xyz".into(),
            kind: "move".into(),
            sources: vec![],
            dest_dir: "/tmp".into(),
            staging: vec![],
            merge_roots: vec![],
            completed: vec![],
            total: 0,
            started_at_ms: 0,
        };
        journal.write(&entry).unwrap();
        journal.remove("op-xyz");
        assert!(journal.recover().is_empty());
        fs::remove_dir_all(&d).ok();
    }
}
