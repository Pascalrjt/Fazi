//! End-to-end eject against real disk images (hdiutil). Ignored by default:
//! they mount volumes and a busy unmount takes Disk Arbitration ~10 s.
//! Run with `cargo test --test eject -- --ignored --test-threads=1`.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use std::sync::atomic::Ordering;
use std::sync::Arc;

use fazi_lib::core::volume_gate::VolumeGate;
use fazi_lib::macos::eject::{eject, EjectError};
use fazi_lib::search::fuzzy::{build_index, Excludes, FuzzyIndex};

/// A mounted scratch disk image, detached (forcibly) on drop.
struct Image {
    dmg: PathBuf,
    mount: PathBuf,
}

impl Image {
    fn new(tag: &str, fs: &str) -> Image {
        Image::sized(tag, fs, "20m")
    }

    fn sized(tag: &str, fs: &str, size: &str) -> Image {
        let name = format!("FaziEjectTest{}{}", tag, std::process::id());
        let dir = std::env::temp_dir().join(format!("fazi-eject-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dmg = dir.join("t.dmg");
        let ok = Command::new("hdiutil")
            .args(["create", "-quiet", "-size", size, "-fs", fs, "-volname", &name])
            .arg(&dmg)
            .status()
            .unwrap()
            .success();
        assert!(ok, "hdiutil create");
        let ok = Command::new("hdiutil")
            .args(["attach", "-quiet", "-nobrowse"])
            .arg(&dmg)
            .status()
            .unwrap()
            .success();
        assert!(ok, "hdiutil attach");
        let mount = PathBuf::from("/Volumes").join(&name);
        assert!(mount.is_dir(), "mounted at {}", mount.display());
        std::fs::write(mount.join("f.txt"), b"hello").unwrap();
        Image { dmg, mount }
    }
}

impl Image {
    /// `dirs` × 100 small files under `tree/`, so a walk stays in flight.
    fn with_tree(self, dirs: usize) -> Image {
        for d in 0..dirs {
            let dir = self.mount.join(format!("tree/d{d:03}"));
            std::fs::create_dir_all(&dir).unwrap();
            for f in 0..100 {
                std::fs::write(dir.join(format!("f{f:03}.txt")), b"x").unwrap();
            }
        }
        self
    }

    /// Detach + re-attach: the filesystem's caches start cold, so a walk
    /// reads through the disk-image driver and stays in flight longer.
    fn remount(self) -> Image {
        let ok = Command::new("hdiutil").args(["detach", "-quiet"]).arg(&self.mount).status().unwrap().success();
        assert!(ok, "hdiutil detach");
        let ok = Command::new("hdiutil")
            .args(["attach", "-quiet", "-nobrowse"])
            .arg(&self.dmg)
            .status()
            .unwrap()
            .success();
        assert!(ok, "hdiutil attach");
        self
    }
}

impl Drop for Image {
    fn drop(&mut self) {
        if self.mount.exists() {
            let _ = Command::new("hdiutil").args(["detach", "-force", "-quiet"]).arg(&self.mount).status();
        }
        let _ = std::fs::remove_dir_all(self.dmg.parent().unwrap());
    }
}

/// An external process holding `file` open.
fn hold_open(file: &Path) -> Child {
    let child = Command::new("/usr/bin/tail")
        .arg("-f")
        .arg(file)
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    child
}

#[test]
#[ignore]
fn ejects_an_idle_hfs_volume() {
    let img = Image::new("Hfs", "HFS+");
    let started = Instant::now();
    assert_eq!(eject(&img.mount), Ok(()));
    assert!(!img.mount.exists(), "unmounted");
    assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
}

#[test]
#[ignore]
fn ejects_an_idle_apfs_volume_and_its_container() {
    let img = Image::new("Apfs", "APFS");
    assert_eq!(eject(&img.mount), Ok(()));
    assert!(!img.mount.exists());
    let info = Command::new("hdiutil").arg("info").output().unwrap();
    let info = String::from_utf8_lossy(&info.stdout);
    assert!(
        !info.contains(&*img.dmg.to_string_lossy()),
        "the whole image (container + physical store) is detached"
    );
}

#[test]
#[ignore]
fn names_the_process_holding_a_file_open() {
    let img = Image::new("Busy", "HFS+");
    let mut holder = hold_open(&img.mount.join("f.txt"));
    let err = eject(&img.mount).unwrap_err();
    holder.kill().ok();
    holder.wait().ok();
    let EjectError::Busy(Some(d)) = &err else { panic!("expected a named dissenter, got {err:?}") };
    assert_eq!(d.pid, holder.id());
    assert!(d.path.ends_with("/tail"), "{}", d.path);
    assert_eq!(err.message(std::process::id()), format!("“tail” is using it (pid {})", holder.id()));
    assert!(img.mount.exists(), "still mounted after a refused eject");
    // Released: the next eject succeeds.
    assert_eq!(eject(&img.mount), Ok(()));
}

#[test]
#[ignore]
fn retries_when_fazi_itself_lets_go() {
    // Our own process is the dissenter, and drops the handle shortly after:
    // the transient retry turns that into a success.
    let img = Image::new("Self", "HFS+");
    let file = std::fs::File::open(img.mount.join("f.txt")).unwrap();
    let t = std::thread::spawn(move || {
        // Mid-way between the first (fast-failing) attempt and the retry.
        std::thread::sleep(Duration::from_millis(500));
        drop(file);
    });
    assert_eq!(eject(&img.mount), Ok(()));
    assert!(!img.mount.exists());
    t.join().unwrap();
}

#[test]
#[ignore]
fn a_volume_that_is_already_gone_counts_as_ejected() {
    assert_eq!(eject(Path::new("/Volumes/FaziNoSuchVolume-1b2c3d")), Ok(()));
}

#[test]
#[ignore]
fn a_plain_folder_is_not_ejectable() {
    let dir = std::env::temp_dir();
    assert_eq!(eject(&dir), Err(EjectError::NotFound));
}

/// The folder-size walk as `dir_size` runs it, slowed down so it is
/// guaranteed to be mid-walk (directory handles open) when the eject starts.
fn spawn_size_walk(gate: &Arc<VolumeGate>, root: &Path) -> std::thread::JoinHandle<bool> {
    let reader = gate.track(root).expect("not ejecting yet");
    let root = root.to_path_buf();
    std::thread::spawn(move || {
        for entry in jwalk::WalkDir::new(&root).skip_hidden(false) {
            if reader.cancelled() {
                break;
            }
            let _ = entry.map(|e| e.metadata());
            std::thread::sleep(Duration::from_millis(1));
        }
        reader.cancelled()
    })
}

#[test]
#[ignore]
fn in_flight_folder_size_walk_is_cancelled_and_the_eject_succeeds() {
    let img = Image::sized("Walk", "HFS+", "100m").with_tree(50);
    let gate = Arc::new(VolumeGate::default());
    let walk = spawn_size_walk(&gate, &img.mount);
    std::thread::sleep(Duration::from_millis(300));

    let closed = gate.begin_eject(&img.mount).unwrap();
    assert!(gate.track(&img.mount.join("tree")).is_none(), "new readers refused");
    assert!(gate.wait_drained(&img.mount, Duration::from_secs(3)), "walk stopped promptly");
    assert!(walk.join().unwrap(), "the walk saw the cancellation mid-way");
    assert_eq!(eject(&img.mount), Ok(()));
    drop(closed);
    assert!(!img.mount.exists());
}

#[test]
#[ignore]
fn in_flight_fuzzy_index_walk_is_aborted_and_the_eject_succeeds() {
    let img = Image::sized("Fuzzy", "APFS", "400m").with_tree(400).remount();
    let gate = Arc::new(VolumeGate::default());
    let index = FuzzyIndex::new(img.mount.clone(), 0, 0);
    let reader = gate.track(&img.mount).unwrap();
    let idx = index.clone();
    let walk = std::thread::spawn(move || {
        build_index(idx, Excludes::parse(&[]), u64::MAX, 0);
        drop(reader);
    });
    let started = Instant::now();
    while index.indexed.load(Ordering::SeqCst) == 0 && started.elapsed() < Duration::from_secs(5) {
        std::thread::yield_now();
    }
    assert!(index.indexing.load(Ordering::SeqCst), "walk still in flight at eject time");

    // What the eject command does: close the gate, abort the walk (the
    // generation bump `release_volume` performs), wait, then unmount.
    let _closed = gate.begin_eject(&img.mount).unwrap();
    index.generation.fetch_add(1, Ordering::SeqCst);
    assert!(gate.wait_drained(&img.mount, Duration::from_secs(3)));
    walk.join().unwrap();
    assert!(index.indexing.load(Ordering::SeqCst), "aborted, not completed");
    assert_eq!(eject(&img.mount), Ok(()));
}

#[test]
#[ignore]
fn without_the_gate_fazis_own_walk_vetoes_the_eject() {
    // Control for the two tests above: the same walk, never told to stop,
    // makes Fazi itself the dissenter.
    let img = Image::new("NoGate", "HFS+").with_tree(5);
    let dir = std::fs::read_dir(img.mount.join("tree/d000")).unwrap(); // an open dir handle
    let err = eject(&img.mount).unwrap_err();
    let EjectError::Busy(Some(d)) = &err else { panic!("{err:?}") };
    assert_eq!(d.pid, std::process::id());
    assert_eq!(err.message(std::process::id()), "Fazi is still reading files on it. Try again in a moment");
    drop(dir);
    assert_eq!(eject(&img.mount), Ok(()));
}
