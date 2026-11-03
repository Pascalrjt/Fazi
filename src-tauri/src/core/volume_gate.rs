//! Volume gate: the handles Fazi itself holds open on a volume.
//!
//! macOS refuses to unmount while any process has a file or directory open
//! on the volume — Fazi included. Background readers (folder-size walks,
//! ⌘P index walks, directory listings) register here for their lifetime.
//! An eject first closes the gate on its root: tracked readers under it are
//! cancelled, new ones are refused, and the eject waits for in-flight ones
//! to drain before asking the system to unmount.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Inner {
    /// Roots with an eject in flight.
    ejecting: Vec<PathBuf>,
    /// Live readers: id → (path, cancel flag).
    readers: HashMap<u64, (PathBuf, Arc<AtomicBool>)>,
}

#[derive(Default)]
pub struct VolumeGate {
    inner: Mutex<Inner>,
    changed: Condvar,
    next_id: AtomicU64,
}

/// `a` and `b` overlap when either contains the other (component-wise, so
/// `/Volumes/Data 2` is unrelated to `/Volumes/Data`).
fn overlaps(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}

impl VolumeGate {
    /// Whether `path` lies on a volume that is being ejected.
    pub fn is_blocked(&self, path: &Path) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.ejecting.iter().any(|root| path.starts_with(root))
    }

    /// Register a background reader of `path` for the guard's lifetime.
    /// `None` when `path` is on a volume being ejected — don't start.
    pub fn track(self: &Arc<Self>, path: &Path) -> Option<ReaderGuard> {
        let mut inner = self.inner.lock().unwrap();
        if inner.ejecting.iter().any(|root| path.starts_with(root)) {
            return None;
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let cancel = Arc::new(AtomicBool::new(false));
        inner.readers.insert(id, (path.to_path_buf(), cancel.clone()));
        Some(ReaderGuard { gate: self.clone(), id, cancel })
    }

    /// Close the gate on `root`: cancel every reader whose path overlaps it
    /// (a walk of `/` crosses into `/Volumes/X` too) and refuse new readers
    /// under it until the guard drops. `None` if an eject of `root` is
    /// already in flight.
    pub fn begin_eject(self: &Arc<Self>, root: &Path) -> Option<EjectGuard> {
        let mut inner = self.inner.lock().unwrap();
        if inner.ejecting.iter().any(|r| r == root) {
            return None;
        }
        inner.ejecting.push(root.to_path_buf());
        for (path, cancel) in inner.readers.values() {
            if overlaps(path, root) {
                cancel.store(true, Ordering::SeqCst);
            }
        }
        Some(EjectGuard { gate: self.clone(), root: root.to_path_buf() })
    }

    /// Block until no tracked reader overlaps `root`, or `timeout` passes.
    /// Returns whether the readers drained.
    pub fn wait_drained(&self, root: &Path, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut inner = self.inner.lock().unwrap();
        loop {
            if !inner.readers.values().any(|(p, _)| overlaps(p, root)) {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            inner = self.changed.wait_timeout(inner, deadline - now).unwrap().0;
        }
    }
}

/// A live background reader. Poll `cancelled()` between I/O steps.
pub struct ReaderGuard {
    gate: Arc<VolumeGate>,
    id: u64,
    cancel: Arc<AtomicBool>,
}

impl ReaderGuard {
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

impl Drop for ReaderGuard {
    fn drop(&mut self) {
        self.gate.inner.lock().unwrap().readers.remove(&self.id);
        self.gate.changed.notify_all();
    }
}

/// Holds the gate closed on a root; reopens it on drop (eject failed or
/// finished — after a successful eject the root no longer exists anyway).
pub struct EjectGuard {
    gate: Arc<VolumeGate>,
    root: PathBuf,
}

impl Drop for EjectGuard {
    fn drop(&mut self) {
        self.gate.inner.lock().unwrap().ejecting.retain(|r| r != &self.root);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate() -> Arc<VolumeGate> {
        Arc::new(VolumeGate::default())
    }

    #[test]
    fn eject_cancels_overlapping_readers_only() {
        let g = gate();
        let inside = g.track(Path::new("/Volumes/USB/photos")).unwrap();
        let ancestor = g.track(Path::new("/")).unwrap();
        let sibling = g.track(Path::new("/Volumes/USB 2/photos")).unwrap();
        let elsewhere = g.track(Path::new("/Users/me")).unwrap();

        let _eject = g.begin_eject(Path::new("/Volumes/USB")).unwrap();
        assert!(inside.cancelled());
        assert!(ancestor.cancelled(), "a walk of / descends into the volume");
        assert!(!sibling.cancelled(), "prefix match must be component-wise");
        assert!(!elsewhere.cancelled());
    }

    #[test]
    fn eject_refuses_new_readers_under_root_until_released() {
        let g = gate();
        let eject = g.begin_eject(Path::new("/Volumes/USB")).unwrap();
        assert!(g.is_blocked(Path::new("/Volumes/USB")));
        assert!(g.is_blocked(Path::new("/Volumes/USB/a/b")));
        assert!(!g.is_blocked(Path::new("/Volumes/USB 2")));
        assert!(!g.is_blocked(Path::new("/Volumes")));
        assert!(g.track(Path::new("/Volumes/USB/a")).is_none());
        assert!(g.track(Path::new("/Volumes/USB 2/a")).is_some());

        drop(eject);
        assert!(!g.is_blocked(Path::new("/Volumes/USB/a")));
        assert!(g.track(Path::new("/Volumes/USB/a")).is_some());
    }

    #[test]
    fn double_eject_of_same_root_is_refused() {
        let g = gate();
        let first = g.begin_eject(Path::new("/Volumes/USB")).unwrap();
        assert!(g.begin_eject(Path::new("/Volumes/USB")).is_none());
        drop(first);
        assert!(g.begin_eject(Path::new("/Volumes/USB")).is_some());
    }

    #[test]
    fn wait_drained_returns_once_readers_finish() {
        let g = gate();
        let reader = g.track(Path::new("/Volumes/USB/big")).unwrap();
        let _eject = g.begin_eject(Path::new("/Volumes/USB")).unwrap();
        assert!(!g.wait_drained(Path::new("/Volumes/USB"), Duration::from_millis(30)));

        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            drop(reader);
        });
        let started = Instant::now();
        assert!(g.wait_drained(Path::new("/Volumes/USB"), Duration::from_secs(5)));
        assert!(started.elapsed() < Duration::from_secs(2), "woken by the drop, not the timeout");
        t.join().unwrap();
    }

    #[test]
    fn unrelated_readers_do_not_delay_drain() {
        let g = gate();
        let _other = g.track(Path::new("/Users/me")).unwrap();
        assert!(g.wait_drained(Path::new("/Volumes/USB"), Duration::from_millis(0)));
    }
}
