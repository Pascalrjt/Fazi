//! Persist a completed fuzzy index to disk so a relaunch (or LRU re-warm)
//! serves the whole tree instantly instead of walking for ~10-15 s.
//! Measured on a 2.8M-entry home dir: ~365 MB flat file, 0.11 s write,
//! 0.10 s load — 83× faster than the walk. The restored index is a snapshot
//! of the disk at save time; callers converge via a background refresh walk
//! that swaps in when complete (see `commands::fuzzy`).
//!
//! Any validation failure (wrong magic/version/root/config, truncation,
//! corrupt lengths, non-UTF-8) makes `load` return None — the caller then
//! builds from a fresh walk, so a bad file only ever costs the fast path.

use std::collections::hash_map::DefaultHasher;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use super::fuzzy::{FuzzyIndex, IndexedPath, BLOCK_SIZE};

const MAGIC: &[u8; 4] = b"FZIX";
const VERSION: u32 = 1;
/// Corrupt-file guard: no real rel path is anywhere near this long.
const MAX_REL_LEN: usize = 8 * 1024;

/// Snapshot file for (root, config): content-addressed name, so a root or
/// config change reads/writes a different file and never collides.
pub fn snapshot_path(dir: &Path, root: &Path, config_hash: u64) -> PathBuf {
    let mut h = DefaultHasher::new();
    root.hash(&mut h);
    config_hash.hash(&mut h);
    dir.join(format!("{:016x}.fzidx", h.finish()))
}

/// Snapshots are a few hundred MB each; a root/config change orphans its
/// old file, so keep only the newest few.
const MAX_SNAPSHOTS: usize = 4;

/// Delete all but the newest `MAX_SNAPSHOTS` snapshot files in `dir`.
pub fn prune(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "fzidx"))
        .filter_map(|e| {
            let modified = e.metadata().ok()?.modified().ok()?;
            Some((modified, e.path()))
        })
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0)); // newest first
    for (_, path) in files.into_iter().skip(MAX_SNAPSHOTS) {
        let _ = std::fs::remove_file(path);
    }
}

/// Serialize the index's current snapshot. Atomic: written to a sibling
/// temp file, then renamed over the target.
pub fn save(index: &FuzzyIndex, file: &Path) -> std::io::Result<()> {
    let tmp = file.with_extension("fzidx.tmp");
    {
        let mut w = BufWriter::with_capacity(1 << 20, File::create(&tmp)?);
        w.write_all(MAGIC)?;
        w.write_all(&VERSION.to_le_bytes())?;
        w.write_all(&index.config_hash.to_le_bytes())?;
        w.write_all(&[index.capped.load(Ordering::SeqCst) as u8])?;
        w.write_all(&index.built_at_ms.load(Ordering::SeqCst).to_le_bytes())?;
        let root = index.root.to_string_lossy();
        w.write_all(&(root.len() as u32).to_le_bytes())?;
        w.write_all(root.as_bytes())?;
        let blocks = index.snapshot();
        let count: u64 = blocks.iter().map(|b| b.len() as u64).sum();
        w.write_all(&count.to_le_bytes())?;
        for block in blocks.iter() {
            for item in block.iter() {
                w.write_all(&(item.rel.len() as u16).to_le_bytes())?;
                w.write_all(item.rel.as_bytes())?;
                w.write_all(&item.name_len.to_le_bytes())?;
                w.write_all(&[item.is_dir as u8])?;
            }
        }
        w.flush()?;
    }
    std::fs::rename(&tmp, file)
}

/// Load and validate a snapshot for exactly (root, config_hash).
pub fn load(file: &Path, root: &Path, config_hash: u64) -> Option<Arc<FuzzyIndex>> {
    let mut r = BufReader::with_capacity(1 << 20, File::open(file).ok()?);

    let mut magic = [0u8; 4];
    r.read_exact(&mut magic).ok()?;
    if &magic != MAGIC {
        return None;
    }
    let mut b4 = [0u8; 4];
    let mut b8 = [0u8; 8];
    let mut b2 = [0u8; 2];
    let mut b1 = [0u8; 1];
    r.read_exact(&mut b4).ok()?;
    if u32::from_le_bytes(b4) != VERSION {
        return None;
    }
    r.read_exact(&mut b8).ok()?;
    if u64::from_le_bytes(b8) != config_hash {
        return None;
    }
    r.read_exact(&mut b1).ok()?;
    let capped = b1[0] != 0;
    r.read_exact(&mut b8).ok()?;
    let built_at_ms = u64::from_le_bytes(b8);
    r.read_exact(&mut b4).ok()?;
    let root_len = u32::from_le_bytes(b4) as usize;
    if root_len > MAX_REL_LEN {
        return None;
    }
    let mut root_bytes = vec![0u8; root_len];
    r.read_exact(&mut root_bytes).ok()?;
    if root_bytes != root.to_string_lossy().as_bytes() {
        return None;
    }
    r.read_exact(&mut b8).ok()?;
    let count = u64::from_le_bytes(b8);

    let mut blocks: Vec<Vec<IndexedPath>> = Vec::new();
    let mut block: Vec<IndexedPath> = Vec::with_capacity(BLOCK_SIZE);
    let mut buf = vec![0u8; MAX_REL_LEN];
    for _ in 0..count {
        r.read_exact(&mut b2).ok()?;
        let rel_len = u16::from_le_bytes(b2) as usize;
        if rel_len == 0 || rel_len > MAX_REL_LEN {
            return None;
        }
        r.read_exact(&mut buf[..rel_len]).ok()?;
        let rel: Box<str> = std::str::from_utf8(&buf[..rel_len]).ok()?.into();
        r.read_exact(&mut b2).ok()?;
        let name_len = u16::from_le_bytes(b2);
        if name_len as usize > rel_len {
            return None;
        }
        r.read_exact(&mut b1).ok()?;
        block.push(IndexedPath { rel, name_len, is_dir: b1[0] != 0 });
        if block.len() >= BLOCK_SIZE {
            blocks.push(std::mem::take(&mut block));
        }
    }
    if !block.is_empty() {
        blocks.push(block);
    }
    // Trailing garbage → treat as corrupt.
    if r.read(&mut b1).ok()? != 0 {
        return None;
    }
    Some(FuzzyIndex::restore(root.to_path_buf(), config_hash, blocks, capped, built_at_ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fazi-persist-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn synthetic_index(root: &Path) -> Arc<FuzzyIndex> {
        let entries: Vec<IndexedPath> = ["src/main.rs", "docs/readme.md", "photo.png", "src"]
            .iter()
            .map(|p| IndexedPath {
                rel: (*p).into(),
                name_len: p.split('/').next_back().unwrap().len() as u16,
                is_dir: !p.contains('.'),
            })
            .collect();
        FuzzyIndex::restore(root.to_path_buf(), 42, vec![entries], true, 1234)
    }

    fn entry_list(index: &FuzzyIndex) -> Vec<(String, u16, bool)> {
        index
            .snapshot()
            .iter()
            .flat_map(|b| b.iter().map(|i| (i.rel.to_string(), i.name_len, i.is_dir)))
            .collect()
    }

    #[test]
    fn round_trip_preserves_entries_and_status() {
        let d = tmp_dir("roundtrip");
        let root = d.join("root");
        let index = synthetic_index(&root);
        let file = snapshot_path(&d, &root, 42);
        save(&index, &file).unwrap();

        let loaded = load(&file, &root, 42).expect("valid snapshot must load");
        assert_eq!(entry_list(&loaded), entry_list(&index));
        assert_eq!(loaded.indexed.load(Ordering::SeqCst), 4);
        assert!(!loaded.indexing.load(Ordering::SeqCst));
        assert!(loaded.capped.load(Ordering::SeqCst));
        assert_eq!(loaded.built_at_ms.load(Ordering::SeqCst), 1234);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn mismatched_config_root_or_corruption_refuses_to_load() {
        let d = tmp_dir("reject");
        let root = d.join("root");
        let index = synthetic_index(&root);
        let file = snapshot_path(&d, &root, 42);
        save(&index, &file).unwrap();

        assert!(load(&file, &root, 43).is_none(), "config hash mismatch");
        assert!(load(&file, &d.join("other"), 42).is_none(), "root mismatch");

        // Truncation → None.
        let bytes = std::fs::read(&file).unwrap();
        std::fs::write(&file, &bytes[..bytes.len() - 3]).unwrap();
        assert!(load(&file, &root, 42).is_none(), "truncated file");

        // Trailing garbage → None.
        let mut garbled = bytes.clone();
        garbled.push(0xFF);
        std::fs::write(&file, &garbled).unwrap();
        assert!(load(&file, &root, 42).is_none(), "trailing garbage");

        // Wrong magic → None.
        let mut wrong = bytes;
        wrong[0] = b'X';
        std::fs::write(&file, &wrong).unwrap();
        assert!(load(&file, &root, 42).is_none(), "bad magic");
        std::fs::remove_dir_all(&d).ok();
    }
}
