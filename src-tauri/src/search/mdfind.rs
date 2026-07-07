//! Spotlight search: shell out to `mdfind`, stream stdout rows.
//! Simpler and safer than NSMetadataQuery run-loop management.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum SearchEvent {
    #[serde(rename_all = "camelCase")]
    Hit {
        path: String,
        name: String,
        is_dir: bool,
        icon: String,
    },
    #[serde(rename_all = "camelCase")]
    Done { total: u64 },
    #[serde(rename_all = "camelCase")]
    Error { message: String },
}

const MAX_RESULTS: u64 = 2_000;

/// Build the mdfind invocation. Filename search uses `-name`; content search
/// passes the raw query (Spotlight matches display name + text content).
fn build_command(query: &str, scope: Option<&Path>, contents: bool) -> Command {
    let mut cmd = Command::new("/usr/bin/mdfind");
    if let Some(s) = scope {
        cmd.arg("-onlyin").arg(s);
    }
    if contents {
        cmd.arg(query);
    } else {
        cmd.arg("-name").arg(query);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null());
    cmd
}

/// Spawn mdfind and stream results. `icon_token` mints icon:// tokens for
/// hits. Returns a handle that kills the child on cancel.
pub fn spawn_search(
    query: String,
    scope: Option<PathBuf>,
    contents: bool,
    icon_token: Arc<dyn Fn(&Path) -> String + Send + Sync>,
    send: impl Fn(SearchEvent) + Send + 'static,
) -> std::io::Result<Arc<Mutex<Option<Child>>>> {
    let mut cmd = build_command(&query, scope.as_deref(), contents);
    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().expect("piped stdout");
    let handle = Arc::new(Mutex::new(Some(child)));
    let handle_thread = handle.clone();

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut total = 0u64;
        for line in reader.lines() {
            let Ok(path) = line else { break };
            if path.is_empty() {
                continue;
            }
            let p = PathBuf::from(&path);
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone());
            let is_dir = p.symlink_metadata().map(|m| m.is_dir()).unwrap_or(false);
            send(SearchEvent::Hit {
                icon: icon_token(&p),
                path,
                name,
                is_dir,
            });
            total += 1;
            if total >= MAX_RESULTS {
                break;
            }
        }
        // Reap (or kill, if we bailed early on the cap).
        if let Some(mut c) = handle_thread.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        send(SearchEvent::Done { total });
    });

    Ok(handle)
}

pub fn cancel(handle: &Arc<Mutex<Option<Child>>>) {
    if let Some(mut c) = handle.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}
