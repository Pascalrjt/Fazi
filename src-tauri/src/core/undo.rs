//! In-memory user-facing undo — a separate mechanism from the crash journal.
//! Inverse ops, capped at 50, invalidated by existence/mtime checks.

use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};

use crate::core::batch_rename;
use crate::core::copier;
use crate::core::walker::{self, SilentSink, Trasher};

const CAP: usize = 50;

/// Which archive op produced the items — a typed kind so labels and the wire
/// kind both match on the enum rather than arbitrary strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProducedKind {
    Compress,
    Extract,
    /// Clipboard content pasted as a new file (pb_paste_new_file).
    Paste,
}

impl ProducedKind {
    fn verb(&self) -> &'static str {
        match self {
            ProducedKind::Compress => "Compress",
            ProducedKind::Extract => "Extract",
            ProducedKind::Paste => "Paste",
        }
    }
}

#[derive(Debug, Clone)]
pub enum UndoOp {
    /// Items moved: (original_path, new_path) — undo moves them back.
    Move { pairs: Vec<(PathBuf, PathBuf)> },
    /// Items copied/duplicated: undo trashes what was produced.
    Copy { produced: Vec<PathBuf> },
    Rename { from: PathBuf, to: PathBuf },
    NewFolder { path: PathBuf },
    /// Items trashed: (original_path, trashed_path) — undo restores them.
    Trash { pairs: Vec<(PathBuf, PathBuf)> },
    /// Archive/paste outputs: (produced_path, trashed_path_once_undone). The
    /// trashed paths double as the redo bookkeeping so the inverse never
    /// collapses into `Trash`/`Move` (both stack tops keep the label).
    ProducedItems {
        kind: ProducedKind,
        pairs: Vec<(PathBuf, Option<PathBuf>)>,
    },
    /// Atomic batch rename: (from_path, to_path) per item — undo renames them
    /// all back with the same two-phase engine (permutation-safe).
    BatchRename { pairs: Vec<(PathBuf, PathBuf)> },
}

impl UndoOp {
    pub fn label(&self) -> String {
        match self {
            UndoOp::Move { pairs } => format!("Move of {}", count_label(pairs.len())),
            UndoOp::Copy { produced } => format!("Copy of {}", count_label(produced.len())),
            UndoOp::Rename { .. } => "Rename".to_string(),
            UndoOp::NewFolder { .. } => "New Folder".to_string(),
            UndoOp::Trash { pairs } => format!("Move of {} to Trash", count_label(pairs.len())),
            UndoOp::ProducedItems { kind, pairs } => {
                format!("{} of {}", kind.verb(), count_label(pairs.len()))
            }
            UndoOp::BatchRename { pairs } => format!("Rename of {}", count_label(pairs.len())),
        }
    }

    pub fn kind_wire(&self) -> &'static str {
        match self {
            UndoOp::Move { .. } => "move",
            UndoOp::Copy { .. } => "copy",
            UndoOp::Rename { .. } => "rename",
            UndoOp::NewFolder { .. } => "newFolder",
            UndoOp::Trash { .. } => "trash",
            UndoOp::ProducedItems { kind: ProducedKind::Compress, .. } => "compress",
            UndoOp::ProducedItems { kind: ProducedKind::Extract, .. } => "extract",
            UndoOp::ProducedItems { kind: ProducedKind::Paste, .. } => "paste",
            UndoOp::BatchRename { .. } => "batchRename",
        }
    }
}

fn count_label(n: usize) -> String {
    if n == 1 {
        "1 Item".to_string()
    } else {
        format!("{} Items", n)
    }
}

pub struct UndoOutcome {
    pub label: String,
    pub restored: Vec<PathBuf>,
    /// The inverse entry to push onto the other stack (undo↔redo).
    pub inverse: UndoOp,
}

pub struct UndoStack {
    undo: Vec<UndoOp>,
    redo: Vec<UndoOp>,
}

impl Default for UndoStack {
    fn default() -> Self {
        UndoStack { undo: Vec::new(), redo: Vec::new() }
    }
}

impl UndoStack {
    /// Record a completed op (clears the redo stack, caps at 50).
    pub fn push(&mut self, op: UndoOp) {
        self.redo.clear();
        self.undo.push(op);
        if self.undo.len() > CAP {
            self.undo.remove(0);
        }
    }

    pub fn undo_top(&self) -> Option<&UndoOp> {
        self.undo.last()
    }

    pub fn redo_top(&self) -> Option<&UndoOp> {
        self.redo.last()
    }

    pub fn undo(&mut self, trasher: &dyn Trasher) -> io::Result<Option<UndoOutcome>> {
        let Some(op) = self.undo.pop() else {
            return Ok(None);
        };
        match apply_inverse(&op, trasher) {
            Ok(outcome) => {
                self.redo.push(outcome.inverse.clone());
                Ok(Some(outcome))
            }
            Err(e) => {
                // A failed undo must not silently drop the record — the user
                // can fix the blocker (e.g. free the name) and retry.
                self.undo.push(op);
                Err(e)
            }
        }
    }

    pub fn redo(&mut self, trasher: &dyn Trasher) -> io::Result<Option<UndoOutcome>> {
        let Some(op) = self.redo.pop() else {
            return Ok(None);
        };
        match apply_inverse(&op, trasher) {
            Ok(outcome) => {
                self.undo.push(outcome.inverse.clone());
                Ok(Some(outcome))
            }
            Err(e) => {
                self.redo.push(op);
                Err(e)
            }
        }
    }

    /// Drop every undo AND redo record that references any of `purged` (the
    /// path itself or anything under it). Called after Empty Trash with the
    /// successfully deleted top-level paths — records pointing at deleted
    /// trash content can only fail or, worse, act on an unrelated file that
    /// later lands at the same trash path.
    pub fn purge_records_under(&mut self, purged: &[PathBuf]) {
        let references = |p: &Path| {
            purged.iter().any(|root| p == root || p.starts_with(root))
        };
        let op_references = |op: &UndoOp| match op {
            UndoOp::Move { pairs } | UndoOp::Trash { pairs } | UndoOp::BatchRename { pairs } => {
                pairs.iter().any(|(a, b)| references(a) || references(b))
            }
            UndoOp::Copy { produced } => produced.iter().any(|p| references(p)),
            UndoOp::Rename { from, to } => references(from) || references(to),
            UndoOp::NewFolder { path } => references(path),
            UndoOp::ProducedItems { pairs, .. } => pairs
                .iter()
                .any(|(p, t)| references(p) || t.as_deref().is_some_and(references)),
        };
        self.undo.retain(|op| !op_references(op));
        self.redo.retain(|op| !op_references(op));
    }
}

/// Execute the inverse of `op`. Validates preconditions first — if the world
/// changed underneath us (targets missing, destinations occupied), fail with
/// a clear message instead of doing something destructive.
fn apply_inverse(op: &UndoOp, trasher: &dyn Trasher) -> io::Result<UndoOutcome> {
    match op {
        UndoOp::Move { pairs } => {
            let mut restored = Vec::new();
            let mut inverse_pairs = Vec::new();
            for (original, new_path) in pairs {
                validate_exists(new_path)?;
                validate_absent(original)?;
                move_back(new_path, original)?;
                restored.push(original.clone());
                inverse_pairs.push((new_path.clone(), original.clone()));
            }
            Ok(UndoOutcome {
                label: op.label(),
                restored,
                inverse: UndoOp::Move { pairs: inverse_pairs },
            })
        }
        UndoOp::Copy { produced } => {
            let mut pairs = Vec::new();
            for p in produced {
                validate_exists(p)?;
            }
            for p in produced {
                let trashed = trasher.trash(p)?;
                pairs.push((p.clone(), trashed));
            }
            Ok(UndoOutcome {
                label: op.label(),
                restored: Vec::new(),
                inverse: UndoOp::Trash { pairs },
            })
        }
        UndoOp::Rename { from, to } => {
            validate_exists(to)?;
            validate_absent(from)?;
            std::fs::rename(to, from)?;
            Ok(UndoOutcome {
                label: op.label(),
                restored: vec![from.clone()],
                inverse: UndoOp::Rename { from: to.clone(), to: from.clone() },
            })
        }
        UndoOp::NewFolder { path } => {
            validate_exists(path)?;
            // Only remove if still empty — the user may have put things in it.
            if std::fs::read_dir(path)?.next().is_some() {
                return Err(io::Error::new(
                    io::ErrorKind::DirectoryNotEmpty,
                    "folder is no longer empty",
                ));
            }
            let trashed = trasher.trash(path)?;
            Ok(UndoOutcome {
                label: op.label(),
                restored: Vec::new(),
                inverse: UndoOp::Trash { pairs: vec![(path.clone(), trashed)] },
            })
        }
        UndoOp::Trash { pairs } => {
            let mut restored = Vec::new();
            let mut inverse_pairs = Vec::new();
            for (original, trashed) in pairs {
                validate_exists(trashed)?;
                validate_absent(original)?;
                move_back(trashed, original)?;
                restored.push(original.clone());
                inverse_pairs.push((original.clone(), trashed.clone()));
            }
            // Inverse of restoring-from-trash is "these items were moved from
            // trash back": represent as Move so redo re-trashes cleanly.
            Ok(UndoOutcome {
                label: op.label(),
                restored: restored.clone(),
                inverse: UndoOp::Move {
                    pairs: inverse_pairs.iter().map(|(o, t)| (t.clone(), o.clone())).collect(),
                },
            })
        }
        UndoOp::BatchRename { pairs } => {
            // Validate ALL inverse pairs before any mutation, then run the
            // same two-phase engine (permutation-safe both directions).
            let parent = pairs
                .first()
                .and_then(|(f, _)| f.parent())
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "empty batch"))?
                .to_path_buf();
            let name_of = |p: &Path| -> io::Result<String> {
                p.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid path"))
            };
            // Inverse: rename `to` back to `from`.
            let mut inverse_names: Vec<(String, String)> = Vec::new();
            for (from, to) in pairs {
                inverse_names.push((name_of(to)?, name_of(from)?));
            }
            batch_rename::validate_batch(&parent, &inverse_names)?;
            let tag = uuid::Uuid::new_v4().simple().to_string();
            batch_rename::two_phase_rename(
                &parent,
                &inverse_names,
                &tag,
                &batch_rename::std_rename,
            )?;
            Ok(UndoOutcome {
                label: op.label(),
                restored: pairs.iter().map(|(f, _)| f.clone()).collect(),
                inverse: UndoOp::BatchRename {
                    pairs: pairs.iter().map(|(f, t)| (t.clone(), f.clone())).collect(),
                },
            })
        }
        UndoOp::ProducedItems { kind, pairs } => {
            let undoing = pairs.iter().all(|(_, trashed)| trashed.is_none());
            if undoing {
                // Undo: trash each produced item; the inverse carries the
                // trashed locations so redo can restore them.
                for (produced, _) in pairs {
                    validate_exists(produced)?;
                }
                let mut inverse_pairs = Vec::new();
                for (produced, _) in pairs {
                    let trashed = trasher.trash(produced)?;
                    inverse_pairs.push((produced.clone(), Some(trashed)));
                }
                Ok(UndoOutcome {
                    label: op.label(),
                    restored: Vec::new(),
                    inverse: UndoOp::ProducedItems { kind: *kind, pairs: inverse_pairs },
                })
            } else {
                // Redo: restore each pair from the Trash; the inverse clears
                // the trashed paths, ready to be undone again.
                let mut restored = Vec::new();
                let mut inverse_pairs = Vec::new();
                for (produced, trashed) in pairs {
                    let Some(trashed) = trashed else {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "inconsistent archive undo record",
                        ));
                    };
                    validate_exists(trashed)?;
                    validate_absent(produced)?;
                    move_back(trashed, produced)?;
                    restored.push(produced.clone());
                    inverse_pairs.push((produced.clone(), None));
                }
                Ok(UndoOutcome {
                    label: op.label(),
                    restored,
                    inverse: UndoOp::ProducedItems { kind: *kind, pairs: inverse_pairs },
                })
            }
        }
    }
}

fn validate_exists(p: &Path) -> io::Result<()> {
    if p.symlink_metadata().is_err() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("{} no longer exists", p.display()),
        ));
    }
    Ok(())
}

fn validate_absent(p: &Path) -> io::Result<()> {
    if p.symlink_metadata().is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{} already exists", p.display()),
        ));
    }
    Ok(())
}

/// Move with the ladder: rename, or (EXDEV) staged copy + delete.
fn move_back(from: &Path, to: &Path) -> io::Result<()> {
    match copier::rename(from, to) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
            // Dataless content encountered here fails verification below (the
            // copy is silently missing that file) — the undo errors instead of
            // deleting a source whose bytes never landed.
            let mut sink = SilentSink;
            walker::copy_fresh(from, to, &mut sink)?;
            let report = walker::verify_tree(from, to, &HashSet::new(), 5_000)?;
            if !report.mismatches.is_empty() {
                walker::remove_tree_best_effort(to);
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "verification failed while restoring",
                ));
            }
            walker::remove_tree_best_effort(from);
            Ok(())
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::walker::DirTrasher;
    use std::fs;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fazi-undo-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn undo_move_restores_tree_exactly() {
        let d = tmp("move");
        let a = d.join("a");
        let b = d.join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("f.txt"), b"data").unwrap();

        // Simulate the op: move a/f.txt → b/f.txt
        fs::rename(a.join("f.txt"), b.join("f.txt")).unwrap();
        let mut stack = UndoStack::default();
        stack.push(UndoOp::Move { pairs: vec![(a.join("f.txt"), b.join("f.txt"))] });

        let trash = DirTrasher(d.join("trash"));
        let out = stack.undo(&trash).unwrap().unwrap();
        assert_eq!(out.restored, vec![a.join("f.txt")]);
        assert_eq!(fs::read(a.join("f.txt")).unwrap(), b"data");
        assert!(!b.join("f.txt").exists());

        // Redo re-applies the move.
        let out = stack.redo(&trash).unwrap().unwrap();
        assert_eq!(fs::read(b.join("f.txt")).unwrap(), b"data");
        assert!(!a.join("f.txt").exists());
        assert_eq!(out.restored, vec![b.join("f.txt")]);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn undo_copy_trashes_produced() {
        let d = tmp("copy");
        let orig = d.join("orig.txt");
        let copy = d.join("copy.txt");
        fs::write(&orig, b"o").unwrap();
        fs::write(&copy, b"o").unwrap();

        let mut stack = UndoStack::default();
        stack.push(UndoOp::Copy { produced: vec![copy.clone()] });
        let trash = DirTrasher(d.join("trash"));
        stack.undo(&trash).unwrap().unwrap();
        assert!(!copy.exists());
        assert!(orig.exists());
        // Redo restores the copy from the trash.
        stack.redo(&trash).unwrap().unwrap();
        assert!(copy.exists());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn undo_invalidated_by_missing_target() {
        let d = tmp("invalid");
        let mut stack = UndoStack::default();
        stack.push(UndoOp::Rename { from: d.join("old"), to: d.join("new") });
        let trash = DirTrasher(d.join("trash"));
        assert!(stack.undo(&trash).is_err());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn undo_trash_restores() {
        let d = tmp("trash");
        let f = d.join("doc.txt");
        fs::write(&f, b"important").unwrap();
        let trash = DirTrasher(d.join("trash"));
        let trashed = trash.trash(&f).unwrap();

        let mut stack = UndoStack::default();
        stack.push(UndoOp::Trash { pairs: vec![(f.clone(), trashed)] });
        let out = stack.undo(&trash).unwrap().unwrap();
        assert_eq!(fs::read(&f).unwrap(), b"important");
        assert_eq!(out.restored, vec![f.clone()]);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn produced_items_label_round_trip() {
        // Undo → redo → undo must keep the archive semantic on BOTH stack
        // tops — the inverse must never collapse into Trash/Move.
        let d = tmp("produced");
        let zip = d.join("Report.pdf.zip");
        fs::write(&zip, b"zipbytes").unwrap();

        let mut stack = UndoStack::default();
        stack.push(UndoOp::ProducedItems {
            kind: ProducedKind::Compress,
            pairs: vec![(zip.clone(), None)],
        });
        assert_eq!(stack.undo_top().unwrap().label(), "Compress of 1 Item");
        assert_eq!(stack.undo_top().unwrap().kind_wire(), "compress");

        let trash = DirTrasher(d.join("trash"));
        // Undo: zip trashed; redo-stack top keeps the compress label.
        let out = stack.undo(&trash).unwrap().unwrap();
        assert_eq!(out.label, "Compress of 1 Item");
        assert!(!zip.exists());
        assert_eq!(stack.redo_top().unwrap().label(), "Compress of 1 Item");
        assert_eq!(stack.redo_top().unwrap().kind_wire(), "compress");

        // Redo: zip restored; undo-stack top STILL reads Compress.
        let out = stack.redo(&trash).unwrap().unwrap();
        assert_eq!(out.label, "Compress of 1 Item");
        assert_eq!(out.restored, vec![zip.clone()]);
        assert_eq!(fs::read(&zip).unwrap(), b"zipbytes");
        assert_eq!(stack.undo_top().unwrap().label(), "Compress of 1 Item");

        // And the cycle keeps working.
        stack.undo(&trash).unwrap().unwrap();
        assert!(!zip.exists());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn produced_items_extract_label() {
        let op = UndoOp::ProducedItems {
            kind: ProducedKind::Extract,
            pairs: vec![
                (PathBuf::from("/x/a"), None),
                (PathBuf::from("/x/b"), None),
            ],
        };
        assert_eq!(op.label(), "Extract of 2 Items");
        assert_eq!(op.kind_wire(), "extract");
    }

    #[test]
    fn purge_records_under_clears_both_stacks() {
        let d = tmp("purge");
        let trash_root = d.join("Trash");
        let kept = d.join("kept.txt");
        fs::create_dir_all(&trash_root).unwrap();
        fs::write(&kept, b"k").unwrap();

        let mut stack = UndoStack::default();
        // Undo-stack: a trash record whose landed path is emptied content.
        stack.push(UndoOp::Trash {
            pairs: vec![(d.join("doc.txt"), trash_root.join("doc.txt"))],
        });
        // Unrelated record that must survive.
        stack.push(UndoOp::Rename { from: d.join("a"), to: kept.clone() });
        // Redo-stack: undo a copy so its Trash inverse (landed in trash_root)
        // sits on the redo stack.
        let produced = d.join("copy.txt");
        fs::write(&produced, b"c").unwrap();
        stack.push(UndoOp::Copy { produced: vec![produced] });
        let trash = DirTrasher(trash_root.clone());
        stack.undo(&trash).unwrap().unwrap();
        assert!(stack.redo_top().is_some());

        // Empty Trash deleted these top-level items.
        stack.purge_records_under(&[trash_root.join("doc.txt"), trash_root.join("copy.txt")]);

        // Only the unrelated rename survives; the redo record is gone too.
        assert_eq!(stack.undo.len(), 1);
        assert!(matches!(stack.undo[0], UndoOp::Rename { .. }));
        assert!(stack.redo_top().is_none());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn batch_rename_undo_redo_round_trip() {
        let d = tmp("batchundo");
        fs::write(d.join("1.jpg"), b"one").unwrap();
        fs::write(d.join("2.jpg"), b"two").unwrap();
        // Simulate the completed op: a swap.
        let tag = "t0";
        crate::core::batch_rename::two_phase_rename(
            &d,
            &[("1.jpg".into(), "2.jpg".into()), ("2.jpg".into(), "1.jpg".into())],
            tag,
            &crate::core::batch_rename::std_rename,
        )
        .unwrap();
        let mut stack = UndoStack::default();
        stack.push(UndoOp::BatchRename {
            pairs: vec![(d.join("1.jpg"), d.join("2.jpg")), (d.join("2.jpg"), d.join("1.jpg"))],
        });
        assert_eq!(stack.undo_top().unwrap().label(), "Rename of 2 Items");
        assert_eq!(stack.undo_top().unwrap().kind_wire(), "batchRename");

        let trash = DirTrasher(d.join("trash"));
        // Undo restores the original contents under the original names.
        stack.undo(&trash).unwrap().unwrap();
        assert_eq!(fs::read(d.join("1.jpg")).unwrap(), b"one");
        assert_eq!(fs::read(d.join("2.jpg")).unwrap(), b"two");
        // Redo re-applies the swap; the stack tops keep the batch label.
        assert_eq!(stack.redo_top().unwrap().kind_wire(), "batchRename");
        stack.redo(&trash).unwrap().unwrap();
        assert_eq!(fs::read(d.join("1.jpg")).unwrap(), b"two");
        assert_eq!(fs::read(d.join("2.jpg")).unwrap(), b"one");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn failed_undo_leaves_the_op_on_the_stack() {
        let d = tmp("popkeep");
        // A rename whose undo target is blocked by an existing file.
        fs::write(d.join("new.txt"), b"renamed").unwrap();
        fs::write(d.join("old.txt"), b"blocker").unwrap();
        let mut stack = UndoStack::default();
        stack.push(UndoOp::Rename { from: d.join("old.txt"), to: d.join("new.txt") });
        let trash = DirTrasher(d.join("trash"));
        assert!(stack.undo(&trash).is_err());
        // The record survives: remove the blocker and the retry succeeds.
        assert!(stack.undo_top().is_some(), "failed undo must not drop the record");
        fs::remove_file(d.join("old.txt")).unwrap();
        stack.undo(&trash).unwrap().unwrap();
        assert_eq!(fs::read(d.join("old.txt")).unwrap(), b"renamed");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn paste_round_trip_through_trash() {
        // pb_paste_new_file records ProducedItems { Paste } — undo trashes
        // the created file, redo restores it from the recorded landed path.
        let d = tmp("pasteundo");
        let f = d.join("Pasted Text.txt");
        fs::write(&f, b"clip").unwrap();
        let mut stack = UndoStack::default();
        stack.push(UndoOp::ProducedItems {
            kind: ProducedKind::Paste,
            pairs: vec![(f.clone(), None)],
        });
        assert_eq!(stack.undo_top().unwrap().label(), "Paste of 1 Item");
        assert_eq!(stack.undo_top().unwrap().kind_wire(), "paste");
        let trash = DirTrasher(d.join("trash"));
        stack.undo(&trash).unwrap().unwrap();
        assert!(!f.exists());
        stack.redo(&trash).unwrap().unwrap();
        assert_eq!(fs::read(&f).unwrap(), b"clip");
        assert_eq!(stack.undo_top().unwrap().kind_wire(), "paste");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn cap_at_50() {
        let mut stack = UndoStack::default();
        for i in 0..60 {
            stack.push(UndoOp::NewFolder { path: PathBuf::from(format!("/x/{}", i)) });
        }
        assert_eq!(stack.undo.len(), 50);
        // Oldest entries were dropped.
        match stack.undo.first().unwrap() {
            UndoOp::NewFolder { path } => assert_eq!(path, &PathBuf::from("/x/10")),
            _ => panic!(),
        }
    }

    #[test]
    fn new_op_clears_redo() {
        let d = tmp("clearredo");
        let f = d.join("f");
        fs::create_dir(&f).unwrap();
        let mut stack = UndoStack::default();
        stack.push(UndoOp::NewFolder { path: f.clone() });
        let trash = DirTrasher(d.join("trash"));
        stack.undo(&trash).unwrap();
        assert!(stack.redo_top().is_some());
        stack.push(UndoOp::NewFolder { path: d.join("g") });
        assert!(stack.redo_top().is_none());
        fs::remove_dir_all(&d).ok();
    }
}
