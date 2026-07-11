//! Shared app state managed by Tauri.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use dashmap::DashMap;

use crate::core::journal::InterruptedOp;
use crate::core::op_queue::Engine;
use crate::core::watcher::DirDebouncer;
use crate::macos::icons::IconCache;
use crate::search::fuzzy::FuzzyIndex;

/// Opaque per-session tokens for the custom protocols — protocol handlers
/// never accept raw paths (webview threat model, see ARCHITECTURE.md).
#[derive(Default)]
pub struct TokenTable {
    tokens: DashMap<String, PathBuf>,
    owners: DashMap<String, HashSet<String>>,
}

impl TokenTable {
    /// Mint a token for `path`, scoped to `owner` (listing id / search id /
    /// op id / fuzzy-index generation).
    pub fn register(&self, owner: &str, path: &Path) -> String {
        let token = uuid::Uuid::new_v4().simple().to_string();
        self.tokens.insert(token.clone(), path.to_path_buf());
        self.owners.entry(owner.to_string()).or_default().insert(token.clone());
        token
    }

    /// Unknown token → None → the protocol handler 404s.
    pub fn resolve(&self, token: &str) -> Option<PathBuf> {
        self.tokens.get(token).map(|p| p.clone())
    }

    /// Revoke ONE token from `owner` (the fuzzy icon-token cache eviction
    /// path) — every other token in the scope stays valid.
    pub fn revoke(&self, owner: &str, token: &str) {
        self.tokens.remove(token);
        if let Some(mut owned) = self.owners.get_mut(owner) {
            owned.remove(token);
        }
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
    /// fuzzy-index root → live index (cap 2, LRU order in fuzzy_lru).
    /// Arc-shared with the engine's invalidate_fuzzy closure.
    pub fuzzy: Arc<DashMap<PathBuf, Arc<FuzzyIndex>>>,
    /// Least-recently-used order of warm fuzzy roots (front = oldest).
    pub fuzzy_lru: Mutex<Vec<PathBuf>>,
    /// fuzzy query id → cancel flag (the listing-cancel pattern).
    pub fuzzy_queries: DashMap<String, Arc<AtomicBool>>,
    pub engine: Arc<Engine>,
    pub icon_cache: Arc<IconCache>,
    pub thumb_cache_dir: PathBuf,
    /// Journal recovery report from startup.
    pub interrupted: Vec<InterruptedOp>,
    /// (changeCount, isCut) of the last Fazi-originated pasteboard write.
    pub pb_mark: Mutex<Option<(isize, bool)>>,
}
