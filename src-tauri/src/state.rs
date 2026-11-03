//! Shared app state managed by Tauri.

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::BuildHasher;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use dashmap::DashMap;

use crate::core::journal::InterruptedOp;
use crate::core::op_queue::Engine;
use crate::core::volume_gate::VolumeGate;
use crate::core::watcher::DirDebouncer;
use crate::macos::icons::IconCache;
use crate::search::fuzzy::FuzzyIndex;

/// Opaque per-session tokens for the custom protocols — protocol handlers
/// never accept raw paths (webview threat model, see ARCHITECTURE.md).
///
/// Token = 16 hex digits of a per-table counter + 16 hex digits of a keyed
/// SipHash MAC over it (random 128-bit key per table). Minting costs no
/// syscall (`Uuid::new_v4` did one `getentropy` per entry) and the MAC keeps
/// tokens unforgeable and never path-derived.
///
/// Tokens are deduplicated per (owner, path): re-registering a path under the
/// same owner (watcher upserts, Open With menus) returns the existing token,
/// so the table stays bounded and icon URLs stay stable (no re-fetch).
pub struct TokenTable {
    key: RandomState,
    next: AtomicU64,
    tokens: DashMap<u64, Arc<Path>>,
    owners: DashMap<String, OwnerScope>,
}

/// One owner's tokens, keyed by path for reuse.
#[derive(Default)]
pub struct OwnerScope {
    by_path: HashMap<Arc<Path>, u64>,
}

impl OwnerScope {
    pub fn len(&self) -> usize {
        self.by_path.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_path.is_empty()
    }
}

impl Default for TokenTable {
    fn default() -> Self {
        TokenTable {
            key: RandomState::new(),
            next: AtomicU64::new(1),
            tokens: DashMap::new(),
            owners: DashMap::new(),
        }
    }
}

fn push_hex_u64(out: &mut String, v: u64) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for shift in (0..16).rev() {
        out.push(HEX[((v >> (shift * 4)) & 0xf) as usize] as char);
    }
}

fn parse_hex_u64(s: &str) -> Option<u64> {
    if s.len() != 16 || !s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return None;
    }
    u64::from_str_radix(s, 16).ok()
}

impl TokenTable {
    fn mac(&self, id: u64) -> u64 {
        self.key.hash_one(id)
    }

    fn encode(&self, id: u64) -> String {
        let mut s = String::with_capacity(32);
        push_hex_u64(&mut s, id);
        push_hex_u64(&mut s, self.mac(id));
        s
    }

    fn decode(&self, token: &str) -> Option<u64> {
        if token.len() != 32 || !token.is_ascii() {
            return None;
        }
        let id = parse_hex_u64(&token[..16])?;
        let mac = parse_hex_u64(&token[16..])?;
        (mac == self.mac(id)).then_some(id)
    }

    fn register_in(&self, scope: &mut OwnerScope, path: &Path) -> u64 {
        if let Some(&id) = scope.by_path.get(path) {
            return id;
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let shared: Arc<Path> = Arc::from(path);
        self.tokens.insert(id, shared.clone());
        scope.by_path.insert(shared, id);
        id
    }

    /// Mint (or reuse) the token for `path`, scoped to `owner` (listing id /
    /// search id / op id / fuzzy-index generation).
    pub fn register(&self, owner: &str, path: &Path) -> String {
        // Look up first so the hot path never allocates the owner String.
        let id = match self.owners.get_mut(owner) {
            Some(mut scope) => self.register_in(&mut scope, path),
            None => {
                let mut scope = self.owners.entry(owner.to_string()).or_default();
                self.register_in(&mut scope, path)
            }
        };
        self.encode(id)
    }

    /// Unknown token → None → the protocol handler 404s.
    pub fn resolve(&self, token: &str) -> Option<Arc<Path>> {
        let id = self.decode(token)?;
        self.tokens.get(&id).map(|p| p.clone())
    }

    /// Revoke ONE token from `owner` (the fuzzy icon-token cache eviction
    /// path) — every other token in the scope stays valid.
    pub fn revoke(&self, owner: &str, token: &str) {
        let Some(id) = self.decode(token) else {
            return;
        };
        let Some((_, path)) = self.tokens.remove(&id) else {
            return;
        };
        if let Some(mut scope) = self.owners.get_mut(owner) {
            if scope.by_path.get(&path) == Some(&id) {
                scope.by_path.remove(&path);
            }
        }
    }

    /// Drop every token owned by `owner` (listing replaced / search done).
    pub fn drop_owner(&self, owner: &str) {
        if let Some(scope) = self.detach_owner(owner) {
            self.release(scope);
        }
    }

    /// Detach `owner`'s scope in O(1): later registrations under the same
    /// owner start a fresh scope. The detached tokens keep resolving until
    /// `release`, which callers run off the main thread (a 100k-entry
    /// listing drops 100k map entries).
    pub fn detach_owner(&self, owner: &str) -> Option<OwnerScope> {
        self.owners.remove(owner).map(|(_, scope)| scope)
    }

    pub fn release(&self, scope: OwnerScope) {
        for id in scope.by_path.into_values() {
            self.tokens.remove(&id);
        }
    }

    /// Live token count (tests/benchmarks).
    pub fn len(&self) -> usize {
        self.tokens.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty()
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
    /// Roots with an in-flight background refresh walk (serve-old-until-swap)
    /// → the index being built, so a drop or eject can abort the walk.
    /// Arc-shared with the refresh threads.
    pub fuzzy_pending: Arc<DashMap<PathBuf, Arc<FuzzyIndex>>>,
    /// Persisted fuzzy-index snapshots (instant warm on relaunch).
    pub fuzzy_cache_dir: PathBuf,
    pub engine: Arc<Engine>,
    pub native_menu: Arc<crate::macos::menu::NativeMenu>,
    pub icon_cache: Arc<IconCache>,
    pub thumb_cache_dir: PathBuf,
    /// Fazi's own open handles per volume; closed while ejecting.
    pub volume_gate: Arc<VolumeGate>,
    /// Journal recovery report from startup.
    pub interrupted: Vec<InterruptedOp>,
    /// (changeCount, isCut) of the last Fazi-originated pasteboard write.
    pub pb_mark: Mutex<Option<(isize, bool)>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_opaque_and_unforgeable() {
        let t = TokenTable::default();
        let a = t.register("l1", Path::new("/a/secret.txt"));
        assert_eq!(a.len(), 32);
        assert!(!a.contains("secret"));
        assert_eq!(t.resolve(&a).as_deref(), Some(Path::new("/a/secret.txt")));
        assert!(t.resolve("nope").is_none());
        // Right counter, wrong MAC.
        let forged = format!("{}{}", &a[..16], "0000000000000000");
        assert!(t.resolve(&forged).is_none());
        // Another table (another process/session) can't validate it.
        assert!(TokenTable::default().resolve(&a).is_none());
    }

    #[test]
    fn same_owner_same_path_reuses_token() {
        let t = TokenTable::default();
        let a = t.register("l1", Path::new("/d/x"));
        for _ in 0..1000 {
            // Watcher upserts re-register the same path over and over.
            assert_eq!(t.register("l1", Path::new("/d/x")), a);
        }
        assert_eq!(t.len(), 1, "table must not grow on re-register");
        let b = t.register("l2", Path::new("/d/x"));
        assert_ne!(a, b, "owners stay isolated");
        assert_eq!(t.len(), 2);
    }

    #[test]
    fn drop_owner_and_revoke() {
        let t = TokenTable::default();
        let a = t.register("l1", Path::new("/d/a"));
        let b = t.register("l1", Path::new("/d/b"));
        let c = t.register("l2", Path::new("/d/a"));
        t.revoke("l1", &a);
        assert!(t.resolve(&a).is_none());
        assert!(t.resolve(&b).is_some());
        // A revoked path mints a fresh token next time.
        let a2 = t.register("l1", Path::new("/d/a"));
        assert_ne!(a, a2);
        t.drop_owner("l1");
        assert!(t.resolve(&b).is_none() && t.resolve(&a2).is_none());
        assert!(t.resolve(&c).is_some());
        assert_eq!(t.len(), 1);
    }

    #[test]
    fn detached_scope_releases_later_without_touching_new_scope() {
        let t = TokenTable::default();
        let old = t.register("o", Path::new("/p"));
        let scope = t.detach_owner("o").unwrap();
        assert_eq!(scope.len(), 1);
        let fresh = t.register("o", Path::new("/p"));
        assert_ne!(old, fresh);
        t.release(scope);
        assert!(t.resolve(&old).is_none());
        assert!(t.resolve(&fresh).is_some());
    }
}
