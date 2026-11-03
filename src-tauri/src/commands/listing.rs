//! Two-stage streamed directory listing (perf-critical, see plan).
//! Pass 1: readdir names + d_type hints, streamed in chunks of ~1000, in
//! directory order. Pass 2: background hydration batches (lstat, tags,
//! packages), streamed as delta updates over the same channel.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::commands::blocking;
use crate::core::entry::{
    hydrate, hydrate_with_meta, pass1_entry_owned, record_package_ext, Entry, EntryKind,
};
use crate::error::Result;
use crate::state::{AppState, TokenTable};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum ListEvent {
    #[serde(rename_all = "camelCase")]
    Chunk { entries: Vec<Entry> },
    #[serde(rename_all = "camelCase")]
    Listed { total: u64 },
    #[serde(rename_all = "camelCase")]
    Hydrate { entries: Vec<Entry> },
    Done,
    #[serde(rename_all = "camelCase")]
    Error { code: String, message: String },
}

const CHUNK: usize = 1000;
const HYDRATE_BATCH: usize = 256;
/// Listings above this skip pass 2 entirely: Done follows Listed immediately,
/// no Hydrate events ever arrive on the channel, and hydration flows through
/// `hydrate_paths` request/response (viewport-priority, frontend-scheduled).
pub const PASS2_MAX_ENTRIES: usize = 5_000;

fn error_code(e: &std::io::Error) -> &'static str {
    match e.kind() {
        std::io::ErrorKind::NotFound => "notFound",
        std::io::ErrorKind::PermissionDenied => "permissionDenied",
        std::io::ErrorKind::NotADirectory => "notADirectory",
        _ => "io",
    }
}

/// Outcome of pass 1.
pub enum Pass1 {
    /// Enumeration finished. `retained` holds the entries for pass 2 when the
    /// listing is small enough to hydrate in the background.
    Listed { total: u64, retained: Option<Vec<Entry>> },
    /// Cancelled, or the receiver went away.
    Stopped,
}

/// Pass 1: stream what readdir gives nearly free, in chunks of `CHUNK`.
/// `emit` returns false when the receiver is gone. Public for benchmarks.
pub fn pass1_scan(
    read: std::fs::ReadDir,
    dir_path: &str,
    listing_id: &str,
    tokens: &TokenTable,
    cancel: &AtomicBool,
    mut emit: impl FnMut(Vec<Entry>) -> bool,
) -> Pass1 {
    let dir = Path::new(dir_path);
    // Joined once per entry into a right-sized String (path == dir.join(name)).
    let prefix = if dir_path.ends_with('/') {
        dir_path.to_string()
    } else {
        format!("{dir_path}/")
    };
    // Retain pass-1 entries only while pass 2 is still eligible. Once the
    // threshold is crossed, drop the retained vector immediately instead
    // of holding a second 100k-entry copy until readdir completes.
    let mut all: Option<Vec<Entry>> = Some(Vec::new());
    let mut total = 0u64;
    let mut chunk: Vec<Entry> = Vec::with_capacity(CHUNK);
    for (next_id, dirent) in read.flatten().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Pass1::Stopped;
        }
        // d_type is a hint only — DT_UNKNOWN on foreign filesystems.
        let kind = match dirent.file_type() {
            Ok(ft) if ft.is_dir() => EntryKind::Dir,
            Ok(ft) if ft.is_symlink() => EntryKind::Symlink,
            Ok(_) => EntryKind::File,
            Err(_) => EntryKind::Unknown,
        };
        let (name, path, token, real) = match dirent.file_name().into_string() {
            Ok(name) => {
                let mut path = String::with_capacity(prefix.len() + name.len());
                path.push_str(&prefix);
                path.push_str(&name);
                let token = tokens.register(listing_id, Path::new(&path));
                (name, path, token, None)
            }
            Err(os) => {
                // Non-UTF-8 name: the row shows the lossy spelling, but the
                // token must point at the real bytes.
                let real = dir.join(&os);
                let name = os.to_string_lossy().into_owned();
                let path = dir.join(&name).to_string_lossy().into_owned();
                let token = tokens.register(listing_id, &real);
                (name, path, token, Some(real))
            }
        };
        let mut entry = pass1_entry_owned(next_id as u64, path, name, kind, token);
        // Link destinations are part of the row's primary identity, not
        // optional metadata. Read them during pass 1 so the target is
        // visible on first paint and remains meaningful for broken links.
        if kind == EntryKind::Symlink {
            let target = match &real {
                Some(r) => std::fs::read_link(r),
                None => std::fs::read_link(&entry.path),
            };
            entry.link_target = target.ok().map(|t| t.to_string_lossy().into_owned());
        }
        total += 1;
        if let Some(retained) = all.as_mut() {
            if retained.len() < PASS2_MAX_ENTRIES {
                retained.push(entry.clone());
            } else {
                all = None;
            }
        }
        chunk.push(entry);
        if chunk.len() >= CHUNK && !emit(std::mem::replace(&mut chunk, Vec::with_capacity(CHUNK)))
        {
            return Pass1::Stopped;
        }
    }
    if !chunk.is_empty() && !emit(chunk) {
        return Pass1::Stopped;
    }
    Pass1::Listed { total, retained: all }
}

#[tauri::command]
pub fn list_dir(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    listing_id: String,
    channel: Channel<ListEvent>,
) -> Result<()> {
    let cancel = Arc::new(AtomicBool::new(false));
    state.listings.insert(listing_id.clone(), cancel.clone());
    let tokens = state.tokens.clone();

    std::thread::spawn(move || {
        let read = match std::fs::read_dir(&path) {
            Ok(rd) => rd,
            Err(e) => {
                let _ = channel.send(ListEvent::Error {
                    code: error_code(&e).into(),
                    message: e.to_string(),
                });
                return;
            }
        };

        let outcome = pass1_scan(read, &path, &listing_id, &tokens, &cancel, |entries| {
            channel.send(ListEvent::Chunk { entries }).is_ok()
        });
        let (total, retained) = match outcome {
            Pass1::Listed { total, retained } => (total, retained),
            Pass1::Stopped => {
                // A cancel can land between our flag check and a register;
                // sweep anything minted after cancel_listing detached.
                if cancel.load(Ordering::Relaxed) {
                    tokens.drop_owner(&listing_id);
                }
                return;
            }
        };
        if channel.send(ListEvent::Listed { total }).is_err() {
            return;
        }

        // Big listings: ONE defined behavior — pass 2 never runs, the entry
        // vector is dropped (it exists only to feed pass 2), and the frontend
        // hydrates from the viewport outward via hydrate_paths.
        let Some(all) = retained else {
            let _ = channel.send(ListEvent::Done);
            return;
        };

        // ---- Pass 2: hydration in background batches ----
        // Batches are moved out of the retained vector and sent by value —
        // no per-batch deep clone.
        let mut rest = all.into_iter();
        loop {
            let mut batch: Vec<Entry> = rest.by_ref().take(HYDRATE_BATCH).collect();
            if batch.is_empty() {
                break;
            }
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            let needs: Vec<bool> = batch.iter_mut().map(hydrate).collect();
            // Ambiguous dirs (dir + unknown extension): one main-thread batch.
            resolve_packages(
                &app,
                batch.iter_mut().zip(&needs).filter(|(_, n)| **n).map(|(e, _)| e).collect(),
            );
            if channel.send(ListEvent::Hydrate { entries: batch }).is_err() {
                return;
            }
        }
        let _ = channel.send(ListEvent::Done);
    });
    Ok(())
}

/// Resolve the package flag for ambiguous dirs with ONE question per
/// distinct extension (`ask` answers a batch of representative paths). The
/// answer is per extension for dirs without the package bit (candidates never
/// carry it — `package_precheck` answers those), so it is recorded in the
/// extension cache too.
pub fn resolve_packages_with(
    mut entries: Vec<&mut Entry>,
    ask: impl FnOnce(Vec<PathBuf>) -> Vec<bool>,
) {
    if entries.is_empty() {
        return;
    }
    let mut ext_slot: HashMap<String, usize> = HashMap::new();
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut slot_of: Vec<usize> = Vec::with_capacity(entries.len());
    for e in &entries {
        let slot = *ext_slot.entry(e.ext.clone()).or_insert_with(|| {
            paths.push(PathBuf::from(&e.path));
            paths.len() - 1
        });
        slot_of.push(slot);
    }
    let answers = ask(paths);
    for (ext, &slot) in &ext_slot {
        if let Some(&is_pkg) = answers.get(slot) {
            record_package_ext(ext, is_pkg);
        }
    }
    for (e, slot) in entries.iter_mut().zip(slot_of) {
        e.is_package = answers.get(slot).copied().unwrap_or(false);
    }
}

fn resolve_packages<R: Runtime>(app: &AppHandle<R>, entries: Vec<&mut Entry>) {
    resolve_packages_with(entries, |paths| {
        crate::macos::main_thread::on_main(app, move || {
            crate::macos::workspace::are_file_packages(&paths)
        })
    });
}

/// Off-main: cancel the listing and drop its tokens. The scope detaches in
/// O(1) here; the per-token removals (≈N for an N-entry listing) run on the
/// blocking pool.
#[tauri::command]
pub async fn cancel_listing(app: AppHandle, listing_id: String) {
    let state = app.state::<AppState>();
    if let Some((_, flag)) = state.listings.remove(&listing_id) {
        flag.store(true, Ordering::Relaxed);
    }
    if let Some(scope) = state.tokens.detach_owner(&listing_id) {
        let tokens = state.tokens.clone();
        drop(tauri::async_runtime::spawn_blocking(move || tokens.release(scope)));
    }
}

/// Fully-hydrated entry for one path (watcher upserts, get-info).
/// Icon token is registered under `listing_id` so it lives with the listing.
#[tauri::command]
pub async fn stat_path(app: AppHandle, path: String, listing_id: String) -> Result<Option<Entry>> {
    blocking(move || {
        let state = app.state::<AppState>();
        build_entry(&app, &state, Path::new(&path), &listing_id)
    })
    .await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HydrateItem {
    pub id: u64,
    pub path: String,
    pub icon: String,
}

/// Hydrate one patch item, preserving the CALLER's row id and icon token —
/// never minted here, so responses flow through the standard hydrate merge
/// and the TokenTable doesn't grow on rehydrate. Returns the entry plus
/// whether it needs the main-thread package check; None when the path
/// vanished (the watcher will remove the row).
pub fn hydrate_item(item: HydrateItem) -> Option<(Entry, bool)> {
    let p = Path::new(&item.path);
    let name = p.file_name()?.to_string_lossy().into_owned();
    p.parent()?;
    let meta = p.symlink_metadata().ok()?;
    let mut entry = pass1_entry_owned(item.id, item.path, name, EntryKind::Unknown, item.icon);
    let needs_pkg = hydrate_with_meta(&mut entry, &meta);
    Some((entry, needs_pkg))
}

/// Viewport-priority hydration patch API (big listings, where pass 2 never
/// ran). Responses are guarded by listingId on the frontend — the id is
/// threaded through for symmetry with the channel events.
#[tauri::command]
pub async fn hydrate_paths(
    app: AppHandle,
    listing_id: String,
    items: Vec<HydrateItem>,
) -> Result<Vec<Option<Entry>>> {
    let _ = listing_id;
    blocking(move || {
        let mut out: Vec<Option<Entry>> = Vec::with_capacity(items.len());
        let mut needs: Vec<bool> = Vec::with_capacity(items.len());
        for item in items {
            match hydrate_item(item) {
                Some((entry, needs_pkg)) => {
                    out.push(Some(entry));
                    needs.push(needs_pkg);
                }
                None => {
                    out.push(None);
                    needs.push(false);
                }
            }
        }
        resolve_packages(
            &app,
            out.iter_mut()
                .zip(&needs)
                .filter(|(_, n)| **n)
                .filter_map(|(e, _)| e.as_mut())
                .collect(),
        );
        out
    })
    .await
}

/// Bulk stat: fully-hydrated entries for many paths in one IPC round-trip
/// (watcher upsert batches, search-fallback hydration). Icon tokens are
/// scoped to `owner` (the listingId for watcher upserts, the searchId for
/// search hits) and reused per path, so repeated upserts of a row keep its
/// token. Package checks for the whole batch share one main-thread trip.
#[tauri::command]
pub async fn stat_paths(
    app: AppHandle,
    owner: String,
    paths: Vec<String>,
) -> Result<Vec<Option<Entry>>> {
    blocking(move || {
        let state = app.state::<AppState>();
        let mut needs: Vec<bool> = Vec::with_capacity(paths.len());
        let mut out: Vec<Option<Entry>> = paths
            .iter()
            .map(|p| {
                let p = Path::new(p);
                let built = p
                    .symlink_metadata()
                    .ok()
                    .and_then(|meta| build_entry_unresolved(&state.tokens, p, &meta, &owner));
                needs.push(built.as_ref().is_some_and(|(_, n)| *n));
                built.map(|(e, _)| e)
            })
            .collect();
        resolve_packages(
            &app,
            out.iter_mut()
                .zip(&needs)
                .filter(|(_, n)| **n)
                .filter_map(|(e, _)| e.as_mut())
                .collect(),
        );
        out
    })
    .await
}

/// Entry for an ad-hoc path, package check NOT yet resolved (the bool says
/// whether it needs one). Public for benchmarks.
pub fn build_entry_unresolved(
    tokens: &TokenTable,
    p: &Path,
    meta: &std::fs::Metadata,
    owner: &str,
) -> Option<(Entry, bool)> {
    // Ids for ad-hoc entries (watcher upserts, get-info) come from a global
    // counter offset far above any listing sequence, so they never collide
    // with pass-1 ids inside the same listing session.
    static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1 << 40);
    p.parent()?;
    let name = p.file_name()?.to_string_lossy().into_owned();
    // Same (owner, path) → same token as pass 1 / earlier upserts.
    let token = tokens.register(owner, p);
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let mut entry =
        pass1_entry_owned(id, p.to_string_lossy().into_owned(), name, EntryKind::Unknown, token);
    let needs_pkg = hydrate_with_meta(&mut entry, meta);
    Some((entry, needs_pkg))
}

pub fn build_entry<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    p: &Path,
    owner: &str,
) -> Option<Entry> {
    let meta = p.symlink_metadata().ok()?;
    build_entry_with_meta(app, state, p, &meta, owner)
}

/// `build_entry` for callers that already lstat'ed `p`.
pub fn build_entry_with_meta<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    p: &Path,
    meta: &std::fs::Metadata,
    owner: &str,
) -> Option<Entry> {
    let (mut entry, needs_pkg) = build_entry_unresolved(&state.tokens, p, meta, owner)?;
    if needs_pkg {
        resolve_packages(app, vec![&mut entry]);
    }
    Some(entry)
}

/// Convenience used by other commands to mint conflict-side icons etc.
pub fn icon_token_for(app: &AppHandle, owner: &str, path: &Path) -> String {
    let state = app.state::<AppState>();
    state.tokens.register(owner, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("fazi-hydrate-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn hydrate_item_preserves_caller_id_and_token() {
        let d = tmp("preserve");
        std::fs::write(d.join("doc.txt"), b"hello").unwrap();
        let item = HydrateItem {
            id: 4242,
            path: d.join("doc.txt").to_string_lossy().into_owned(),
            icon: "existing-token-abc".into(),
        };
        let (entry, needs_pkg) = hydrate_item(item).expect("file exists");
        // The whole point of the patch API: the row id and icon token are the
        // caller's — no new id counter, no TokenTable growth.
        assert_eq!(entry.id, 4242);
        assert_eq!(entry.icon, "existing-token-abc");
        assert_eq!(entry.name, "doc.txt");
        assert!(entry.hydrated);
        assert_eq!(entry.size, Some(5));
        assert!(!needs_pkg);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn hydrate_item_mixed_existing_and_missing() {
        let d = tmp("mixed");
        std::fs::write(d.join("real.txt"), b"x").unwrap();
        let real = HydrateItem {
            id: 1,
            path: d.join("real.txt").to_string_lossy().into_owned(),
            icon: "t1".into(),
        };
        let gone = HydrateItem {
            id: 2,
            path: d.join("vanished.txt").to_string_lossy().into_owned(),
            icon: "t2".into(),
        };
        assert!(hydrate_item(real).is_some());
        // Vanished between passes → None (the watcher removes the row).
        assert!(hydrate_item(gone).is_none());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn hydrate_item_flags_ambiguous_package_dirs() {
        let d = tmp("pkg");
        std::fs::create_dir(d.join("Thing.weirdext")).unwrap();
        std::fs::create_dir(d.join("plain")).unwrap();
        let ambiguous = HydrateItem {
            id: 1,
            path: d.join("Thing.weirdext").to_string_lossy().into_owned(),
            icon: "t".into(),
        };
        let plain = HydrateItem {
            id: 2,
            path: d.join("plain").to_string_lossy().into_owned(),
            icon: "t".into(),
        };
        let (_, needs_pkg) = hydrate_item(ambiguous).unwrap();
        assert!(needs_pkg, "dir with an unknown extension needs the NSWorkspace check");
        let (_, needs_pkg) = hydrate_item(plain).unwrap();
        assert!(!needs_pkg);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn package_resolution_asks_once_per_extension_and_caches() {
        let mk = |name: &str| {
            pass1_entry_owned(0, format!("/x/{name}"), name.into(), EntryKind::Dir, String::new())
        };
        let mut a = mk("one.fazi-res-ext-yes");
        let mut b = mk("two.fazi-res-ext-yes");
        let mut c = mk("three.fazi-res-ext-no");
        let mut asked: Vec<PathBuf> = Vec::new();
        resolve_packages_with(vec![&mut a, &mut b, &mut c], |paths| {
            asked = paths.clone();
            paths.iter().map(|p| p.to_string_lossy().ends_with("-yes")).collect()
        });
        assert_eq!(asked.len(), 2, "one question per distinct extension");
        assert!(a.is_package && b.is_package && !c.is_package);
        // Later dirs with those extensions never hit the main thread.
        assert_eq!(crate::core::entry::package_precheck("fazi-res-ext-yes", 0), Some(true));
        assert_eq!(crate::core::entry::package_precheck("fazi-res-ext-no", 0), Some(false));
    }

    #[test]
    fn watcher_upserts_reuse_the_listing_token() {
        let d = tmp("reuse");
        for i in 0..10 {
            std::fs::write(d.join(format!("f{i}.txt")), b"x").unwrap();
        }
        let tokens = TokenTable::default();
        let dir = d.to_string_lossy().into_owned();
        let mut first: Vec<Entry> = Vec::new();
        let out = pass1_scan(
            std::fs::read_dir(&d).unwrap(),
            &dir,
            "listing-1",
            &tokens,
            &AtomicBool::new(false),
            |chunk| {
                first.extend(chunk);
                true
            },
        );
        assert!(matches!(out, Pass1::Listed { total: 10, retained: Some(_) }));
        assert_eq!(tokens.len(), 10);
        for _ in 0..100 {
            for e in &first {
                let p = Path::new(&e.path);
                let meta = p.symlink_metadata().unwrap();
                let (upsert, _) = build_entry_unresolved(&tokens, p, &meta, "listing-1").unwrap();
                assert_eq!(upsert.icon, e.icon, "icon URL must stay stable across upserts");
            }
        }
        assert_eq!(tokens.len(), 10, "1000 upserts must not grow the token table");
        assert_eq!(
            tokens.resolve(&first[0].icon).as_deref(),
            Some(Path::new(&first[0].path))
        );
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn pass1_paths_match_dir_join_and_read_links() {
        let d = tmp("pass1");
        std::fs::write(d.join("a.txt"), b"x").unwrap();
        std::os::unix::fs::symlink("a.txt", d.join("ln")).unwrap();
        let tokens = TokenTable::default();
        for dir in [d.to_string_lossy().into_owned(), format!("{}/", d.display())] {
            let mut got: Vec<Entry> = Vec::new();
            pass1_scan(
                std::fs::read_dir(&d).unwrap(),
                &dir,
                &dir,
                &tokens,
                &AtomicBool::new(false),
                |c| {
                    got.extend(c);
                    true
                },
            );
            got.sort_by(|a, b| a.name.cmp(&b.name));
            assert_eq!(got[0].path, d.join("a.txt").to_string_lossy());
            assert_eq!(got[1].kind, EntryKind::Symlink);
            assert_eq!(got[1].link_target.as_deref(), Some("a.txt"));
        }
        std::fs::remove_dir_all(&d).ok();
    }
}
