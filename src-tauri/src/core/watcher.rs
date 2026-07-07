//! Directory watching: FSEvents via `notify` + debouncer (~150 ms batches).
//! Batches are mapped to name-level deltas relative to the watched dir; the
//! frontend re-stats upserted names and drops removed ones.

use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum WatchEvent {
    #[serde(rename_all = "camelCase")]
    Batch {
        upserted: Vec<String>,
        removed: Vec<String>,
        rescan: bool,
    },
    RootGone,
}

pub type DirDebouncer = Debouncer<RecommendedWatcher, RecommendedCache>;

/// Start watching `root` (non-recursive). `send` receives debounced batches.
pub fn watch(
    root: PathBuf,
    send: impl Fn(WatchEvent) + Send + 'static,
) -> notify::Result<DirDebouncer> {
    // FSEvents reports canonical paths (/private/var/… for /var/…) — watch
    // and compare against the canonical root or deltas silently vanish.
    let root = std::fs::canonicalize(&root).unwrap_or(root);
    let watched = root.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(150),
        None,
        move |result: DebounceEventResult| match result {
            Ok(events) => {
                if let Some(batch) = map_events(&watched, events.iter().flat_map(|e| e.paths.iter())) {
                    send(batch);
                }
            }
            Err(_) => {
                // Watcher errors (queue overflow etc.): ask the UI to re-list.
                send(WatchEvent::Batch {
                    upserted: Vec::new(),
                    removed: Vec::new(),
                    rescan: true,
                });
            }
        },
    )?;
    debouncer.watch(&root, RecursiveMode::NonRecursive)?;
    Ok(debouncer)
}

/// Classify affected paths by what's true *now*: existing paths in the root
/// are upserts, missing ones are removals. Robust across rename semantics.
fn map_events<'a>(
    root: &Path,
    paths: impl Iterator<Item = &'a PathBuf>,
) -> Option<WatchEvent> {
    let mut upserted = Vec::new();
    let mut removed = Vec::new();
    let mut root_gone = false;
    let mut seen = std::collections::HashSet::new();

    for p in paths {
        if p == root {
            if p.symlink_metadata().is_err() {
                root_gone = true;
            }
            continue;
        }
        if p.parent() != Some(root) {
            continue; // non-recursive watch can still surface deeper paths
        }
        let Some(name) = p.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        if !seen.insert(name.clone()) {
            continue;
        }
        if p.symlink_metadata().is_ok() {
            upserted.push(name);
        } else {
            removed.push(name);
        }
    }

    if root_gone {
        return Some(WatchEvent::RootGone);
    }
    if upserted.is_empty() && removed.is_empty() {
        return None;
    }
    Some(WatchEvent::Batch { upserted, removed, rescan: false })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn batches_arrive_for_create_and_remove() {
        let root = std::env::temp_dir().join(format!("fazi-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let (tx, rx) = mpsc::channel();
        let _guard = watch(root.clone(), move |e| {
            let _ = tx.send(e);
        })
        .unwrap();

        std::fs::write(root.join("created.txt"), b"x").unwrap();

        // Generous timeout — FSEvents latency + debounce.
        let evt = rx.recv_timeout(Duration::from_secs(10)).expect("no watch event");
        match evt {
            WatchEvent::Batch { upserted, .. } => {
                assert!(upserted.contains(&"created.txt".to_string()), "{:?}", upserted);
            }
            other => panic!("unexpected: {:?}", other),
        }

        std::fs::remove_file(root.join("created.txt")).unwrap();
        let evt = rx.recv_timeout(Duration::from_secs(10)).expect("no removal event");
        match evt {
            WatchEvent::Batch { removed, .. } => {
                assert!(removed.contains(&"created.txt".to_string()), "{:?}", removed);
            }
            other => panic!("unexpected: {:?}", other),
        }

        std::fs::remove_dir_all(&root).ok();
    }
}
