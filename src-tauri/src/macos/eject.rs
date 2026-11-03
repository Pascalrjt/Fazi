//! Volume eject via `diskutil eject`, run off the main thread.
//!
//! `diskutil` goes through Disk Arbitration like Finder does: it unmounts
//! every volume on the device (APFS physical stores included) before
//! ejecting, and when a process keeps the volume busy it names it
//! ("dissented by PID 123 (/path/to/binary)"). The legacy
//! `NSWorkspace.unmountAndEjectDeviceAtPath` blocked the AppKit main thread
//! for the whole unmount and only reported a bare bool.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// One `diskutil` attempt. A busy volume takes Disk Arbitration ~10 s to
/// give up on; anything past this is a wedged device.
const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(45);
/// Pause before retrying after a transient dissent (Spotlight, Quick Look,
/// Fazi's own readers finishing up).
const RETRY_DELAY: Duration = Duration::from_millis(1500);

/// The process that refused the unmount.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dissenter {
    pub pid: u32,
    /// Executable path as reported by Disk Arbitration (may be empty).
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EjectError {
    /// Something has files open on the volume.
    Busy(Option<Dissenter>),
    /// No disk is mounted at that path.
    NotFound,
    /// `diskutil` didn't finish within `ATTEMPT_TIMEOUT`.
    TimedOut,
    /// Any other failure, with diskutil's own first line.
    Failed(String),
}

/// Map `diskutil eject`/`unmount` failure output to an `EjectError`.
pub fn parse_failure(output: &str) -> EjectError {
    for line in output.lines() {
        if let Some(i) = line.find("dissented by PID ") {
            let rest = &line[i + "dissented by PID ".len()..];
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            let Ok(pid) = digits.parse::<u32>() else { continue };
            let after = &rest[digits.len()..];
            let path = match (after.find('('), after.rfind(')')) {
                (Some(open), Some(close)) if close > open => after[open + 1..close].to_string(),
                _ => String::new(),
            };
            return EjectError::Busy(Some(Dissenter { pid, path }));
        }
    }
    let lower = output.to_lowercase();
    if lower.contains("failed to find disk") || lower.contains("could not find disk") {
        return EjectError::NotFound;
    }
    if lower.contains("could not be unmounted")
        || lower.contains("failed to unmount")
        || lower.contains("resource busy")
        || lower.contains("in use")
    {
        return EjectError::Busy(None);
    }
    let first = output.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    EjectError::Failed(if first.is_empty() { "diskutil failed".into() } else { first.into() })
}

/// What to call a dissenting process in a toast: the outermost app bundle
/// name, a friendly name for well-known system daemons, else the binary name.
pub fn display_name(path: &str) -> String {
    if let Some(app) = path.split('/').find(|c| c.ends_with(".app")) {
        return app.trim_end_matches(".app").to_string();
    }
    let bin = path.rsplit('/').next().unwrap_or(path);
    match system_service(bin) {
        Some(name) => name.to_string(),
        None if bin.is_empty() => "another app".to_string(),
        None => bin.to_string(),
    }
}

/// Well-known system daemons that open files on a fresh or busy volume and
/// let go on their own shortly after.
fn system_service(bin: &str) -> Option<&'static str> {
    match bin {
        "mds" | "mds_stores" | "mdworker" | "mdworker_shared" | "mdsync" | "corespotlightd" => {
            Some("Spotlight")
        }
        "quicklookd" | "QuickLookUIService" | "QuickLookSatellite" => Some("Quick Look"),
        b if b.starts_with("com.apple.quicklook") || b.starts_with("ThumbnailExtension") => {
            Some("Quick Look")
        }
        "fseventsd" => Some("File System Events"),
        "backupd" | "backupd-helper" => Some("Time Machine"),
        _ => None,
    }
}

impl EjectError {
    /// Worth one more try: the dissenter usually lets go within a second
    /// (system indexers, thumbnailers, or Fazi's own readers still draining).
    pub fn is_transient(&self, own_pid: u32) -> bool {
        match self {
            EjectError::Busy(Some(d)) => {
                if d.pid == own_pid {
                    return true;
                }
                let bin = d.path.rsplit('/').next().unwrap_or("");
                matches!(system_service(bin), Some(s) if s != "Time Machine")
            }
            _ => false,
        }
    }

    /// The reason half of "Couldn't eject “X”: …".
    pub fn message(&self, own_pid: u32) -> String {
        match self {
            EjectError::Busy(Some(d)) if d.pid == own_pid => {
                "Fazi is still reading files on it. Try again in a moment".into()
            }
            EjectError::Busy(Some(d)) => {
                let name = display_name(&d.path);
                let bin = d.path.rsplit('/').next().unwrap_or("");
                match system_service(bin) {
                    Some("Spotlight") => "Spotlight is indexing it. Try again in a moment".into(),
                    Some("Time Machine") => "Time Machine is backing up to it".into(),
                    Some(_) => format!("{name} is using it. Try again in a moment"),
                    None => format!("“{name}” is using it (pid {})", d.pid),
                }
            }
            EjectError::Busy(None) => "it's in use by another app".into(),
            EjectError::NotFound => "it isn't mounted".into(),
            EjectError::TimedOut => "the disk stopped responding".into(),
            EjectError::Failed(line) => line.clone(),
        }
    }
}

/// Run `diskutil <verb> <path>` with a timeout.
fn diskutil(verb: &str, path: &Path) -> Result<(), EjectError> {
    let mut child = Command::new("/usr/sbin/diskutil")
        .arg(verb)
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| EjectError::Failed(format!("couldn't run diskutil: {e}")))?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > ATTEMPT_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(EjectError::TimedOut);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(e) => return Err(EjectError::Failed(e.to_string())),
        }
    };
    if status.success() {
        return Ok(());
    }
    // A few short lines: safe to read after exit without pipe deadlock.
    let mut out = String::new();
    if let Some(mut s) = child.stdout.take() {
        let _ = s.read_to_string(&mut out);
    }
    if let Some(mut s) = child.stderr.take() {
        let _ = s.read_to_string(&mut out);
    }
    Err(parse_failure(&out))
}

/// Whether `path` is still a mount point (its device differs from its
/// parent's) — distinguishes "already gone" from "not a DA disk".
fn is_mount_point(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let (Ok(meta), Some(parent)) = (std::fs::metadata(path), path.parent()) else {
        return false;
    };
    std::fs::metadata(parent).map(|p| p.dev() != meta.dev()).unwrap_or(false)
}

/// One eject attempt: `diskutil eject`, falling back to `diskutil unmount`
/// for mounts with no ejectable device behind them. A volume that vanished
/// on its own counts as ejected.
fn attempt(path: &Path) -> Result<(), EjectError> {
    match diskutil("eject", path) {
        Err(EjectError::NotFound) if is_mount_point(path) => diskutil("unmount", path),
        Err(EjectError::NotFound) if !path.exists() => Ok(()),
        other => other,
    }
}

/// Retry policy, separated from the process plumbing for tests: retry once
/// after `delay` when the failure is transient.
pub fn with_retry(
    own_pid: u32,
    delay: Duration,
    mut attempt: impl FnMut() -> Result<(), EjectError>,
) -> Result<(), EjectError> {
    match attempt() {
        Err(e) if e.is_transient(own_pid) => {
            std::thread::sleep(delay);
            attempt()
        }
        other => other,
    }
}

/// Eject the device behind the volume mounted at `path`. Blocking (seconds
/// when busy) — call from a worker thread, never the main thread.
pub fn eject(path: &Path) -> Result<(), EjectError> {
    let mut n = 0;
    with_retry(std::process::id(), RETRY_DELAY, || {
        n += 1;
        let started = Instant::now();
        let result = attempt(path);
        if let Err(e) = &result {
            eprintln!(
                "[eject] {} attempt {n} refused after {:.1}s: {e:?}",
                path.display(),
                started.elapsed().as_secs_f64()
            );
        }
        result
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWN: u32 = 4242;

    #[test]
    fn parses_eject_dissent_with_app_bundle() {
        let out = "Unmount of disk7 failed: at least one volume could not be unmounted\n\
                   Unmount was dissented by PID 87855 (/opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python)\n\
                   Dissenter parent PPID 1 (/sbin/launchd)\n";
        let err = parse_failure(out);
        let EjectError::Busy(Some(d)) = &err else { panic!("{err:?}") };
        assert_eq!(d.pid, 87855);
        assert!(d.path.ends_with("Python.app/Contents/MacOS/Python"));
        assert_eq!(display_name(&d.path), "Python");
        assert_eq!(err.message(OWN), "“Python” is using it (pid 87855)");
        assert!(!err.is_transient(OWN));
    }

    #[test]
    fn parses_unmount_dissent_wording() {
        let out = "Volume FaziLabA on disk7s1 failed to unmount: dissented by PID 12 (/usr/bin/vim)\n";
        assert_eq!(
            parse_failure(out),
            EjectError::Busy(Some(Dissenter { pid: 12, path: "/usr/bin/vim".into() }))
        );
    }

    #[test]
    fn path_with_parentheses_is_kept_whole() {
        let out = "Unmount was dissented by PID 9 (/Applications/Foo (Beta).app/Contents/MacOS/Foo)\n";
        let EjectError::Busy(Some(d)) = parse_failure(out) else { panic!() };
        assert_eq!(d.path, "/Applications/Foo (Beta).app/Contents/MacOS/Foo");
        assert_eq!(display_name(&d.path), "Foo (Beta)");
    }

    #[test]
    fn outermost_app_bundle_wins_for_helpers() {
        let p = "/Applications/Google Chrome.app/Contents/Frameworks/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper";
        assert_eq!(display_name(p), "Google Chrome");
    }

    #[test]
    fn busy_without_pid_and_other_failures() {
        assert_eq!(
            parse_failure("Unmount of disk4 failed: at least one volume could not be unmounted\n"),
            EjectError::Busy(None)
        );
        assert_eq!(parse_failure("Failed to find disk /Volumes/Nope\n"), EjectError::NotFound);
        assert_eq!(
            parse_failure("\nSomething odd happened\nmore\n"),
            EjectError::Failed("Something odd happened".into())
        );
        assert_eq!(parse_failure(""), EjectError::Failed("diskutil failed".into()));
    }

    #[test]
    fn system_daemons_are_transient_and_named() {
        let spotlight = EjectError::Busy(Some(Dissenter {
            pid: 300,
            path: "/System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Support/mds_stores".into(),
        }));
        assert!(spotlight.is_transient(OWN));
        assert_eq!(spotlight.message(OWN), "Spotlight is indexing it. Try again in a moment");

        let ql = EjectError::Busy(Some(Dissenter {
            pid: 301,
            path: "/System/Library/Frameworks/QuickLookThumbnailing.framework/Support/com.apple.quicklook.ThumbnailsAgent".into(),
        }));
        assert!(ql.is_transient(OWN));
        assert_eq!(ql.message(OWN), "Quick Look is using it. Try again in a moment");

        let tm = EjectError::Busy(Some(Dissenter {
            pid: 302,
            path: "/System/Library/CoreServices/backupd.bundle/Contents/Resources/backupd".into(),
        }));
        assert!(!tm.is_transient(OWN), "a backup won't finish in a second");
        assert_eq!(tm.message(OWN), "Time Machine is backing up to it");
    }

    #[test]
    fn fazi_itself_is_transient_with_own_message() {
        let me = EjectError::Busy(Some(Dissenter { pid: OWN, path: "/Applications/Fazi.app/Contents/MacOS/fazi".into() }));
        assert!(me.is_transient(OWN));
        assert_eq!(me.message(OWN), "Fazi is still reading files on it. Try again in a moment");
    }

    #[test]
    fn retry_runs_once_more_only_for_transient_failures() {
        let transient = || EjectError::Busy(Some(Dissenter { pid: OWN, path: String::new() }));

        let mut calls = 0;
        let r = with_retry(OWN, Duration::ZERO, || {
            calls += 1;
            if calls == 1 { Err(transient()) } else { Ok(()) }
        });
        assert_eq!((r, calls), (Ok(()), 2));

        let mut calls = 0;
        let r = with_retry(OWN, Duration::ZERO, || {
            calls += 1;
            Err(transient())
        });
        assert_eq!(calls, 2, "at most one retry");
        assert!(r.is_err());

        let mut calls = 0;
        let r = with_retry(OWN, Duration::ZERO, || {
            calls += 1;
            Err(EjectError::Busy(None))
        });
        assert_eq!((r, calls), (Err(EjectError::Busy(None)), 1));
    }
}
