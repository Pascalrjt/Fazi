//! Shared app state managed by Tauri.

use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use dashmap::DashMap;

use crate::core::journal::InterruptedOp;
use crate::core::op_queue::Engine;
use crate::core::watcher::DirDebouncer;
use crate::macos::icons::IconCache;

/// Opaque per-session tokens for the custom protocols — protocol handlers
/// never accept raw paths (webview threat model, see ARCHITECTURE.md).
#[derive(Default)]
pub struct TokenTable {
    tokens: DashMap<String, PathBuf>,
    owners: DashMap<String, Vec<String>>,
}

impl TokenTable {
    /// Mint a token for `path`, scoped to `owner` (listing id / search id / op id).
    pub fn register(&self, owner: &str, path: &Path) -> String {
        let token = uuid::Uuid::new_v4().simple().to_string();
        self.tokens.insert(token.clone(), path.to_path_buf());
        self.owners.entry(owner.to_string()).or_default().push(token.clone());
        token
    }

    /// Unknown token → None → the protocol handler 404s.
    pub fn resolve(&self, token: &str) -> Option<PathBuf> {
        self.tokens.get(token).map(|p| p.clone())
    }

    /// Drop every token owned by `owner` (listing replaced / search done).
    pub fn drop_owner(&self, owner: &str) {
        if let Some((_, tokens)) = self.owners.remove(owner) {
            for t in tokens {
                self.tokens.remove(&t);
            }
        }
    }
}

pub struct AppState {
    pub tokens: Arc<TokenTable>,
    /// preview:// serves only explicitly registered paths, revoked on close.
    pub previews: DashMap<String, PathBuf>,
    /// listing id → cancel flag.
    pub listings: DashMap<String, Arc<AtomicBool>>,
    /// watch id → live debouncer (dropping stops the watch).
    pub watchers: DashMap<String, DirDebouncer>,
    /// search id → mdfind child handle.
    pub searches: DashMap<String, Arc<Mutex<Option<Child>>>>,
    pub engine: Arc<Engine>,
    pub icon_cache: Arc<IconCache>,
    pub thumb_cache_dir: PathBuf,
    /// Journal recovery report from startup.
    pub interrupted: Vec<InterruptedOp>,
    /// (changeCount, isCut) of the last Fazi-originated pasteboard write.
    pub pb_mark: Mutex<Option<(isize, bool)>>,
}
