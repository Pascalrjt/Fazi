# Fazi Architecture

Fazi is a keyboard-first macOS file manager built on Tauri 2 (Rust backend,
React 19 + TypeScript frontend). It exists because Finder stalls on copy/move
operations that are instant in the terminal; Fazi's file-operations engine is
designed to never do that.

## The rule

**Anything touching disk or macOS APIs lives in Rust; presentation, selection,
and input live in TypeScript.**

- **Rust owns:** directory listing (two-stage, streamed), file ops on
  dedicated op threads (progress + cancellation), FSEvents watching, search
  (mdfind subprocess, streamed), icons/thumbnails (served via custom `icon://`
  / `thumb://` / `preview://` URI schemes — never base64 over IPC), all
  objc2/AppKit integration, the durable op journal, and the in-memory undo
  stack.
- **Frontend owns:** tabs/panes/selection/sort/filter state (zustand),
  virtualized views, the keyboard system, and the command palette. Full
  directory listings ship to the frontend (chunked); sort/filter/type-ahead
  happen in JS in memory — instant at 100k entries.

## IPC (Tauri 2 primitives, one job each)

| Primitive | Used for |
|---|---|
| Commands (`invoke`) | request/response — stat, rename, tags, Open With, launch |
| Channels (`tauri::ipc::Channel<T>`) | streaming — `list_dir` (~1000-entry chunks), `watch_dir` (debounced ~150 ms batches), `run_op` (progress + conflicts), `search`, `dir_size` |
| Events (broadcast) | volume mount/unmount (`fazi://volumes-changed`) |

The wire contract is `src/types/ipc.ts`, mirrored by hand in the Rust structs
(`#[serde(rename_all = "camelCase")]`, event enums tagged with `event`).
`src/lib/ipc/` is the only frontend module allowed to import
`@tauri-apps/api`.

`@tauri-apps/plugin-fs` is deliberately not used — its glob-scoped allowlist
is wrong for a full-disk file manager and it can't provide tags, packages,
aliases, or progress. All FS access goes through custom `#[tauri::command]`s.

## Two-stage listing (perf-critical)

A single stat+xattr pass over 100k entries cannot hit a <50 ms first paint.

- **Pass 1** streams what one `readdir` gives nearly free: name, `d_type`
  hint, dotfile-hidden flag — chunks of ~1000 render immediately in directory
  order. `d_type` is a hint only: network/foreign filesystems return
  `DT_UNKNOWN`, which renders as a neutral row until pass 2 corrects it.
- **Pass 2** hydrates in background batches of ~256: lstat (real type,
  size/dates/flags), Finder tags, package/alias detection — streamed as
  `hydrate` delta events over the same channel. Ambiguous
  package checks (dirs with unknown extensions) batch into one main-thread
  `isFilePackageAtPath:` trip per hydration batch.

Sorting is the frontend's job: small dirs re-sort per chunk; large dirs render
in arrival order and settle once when enumeration completes.

## Webview threat model

With the sandbox off (Developer ID distribution, never Mac App Store) and
full-disk commands exposed, a compromised webview would mean full disk access.
Assume any XSS gains `invoke` access; the defense is layered:

1. **No remote content ever.** No CDNs, no remote fonts, no fetch to the
   network from the UI.
2. **Strict CSP** (see `tauri.conf.json`): `default-src 'self'`, images/media
   limited to self + our custom schemes, no eval, no frames.
3. **Untrusted bytes are data, never markup.** Preview renderers (text, PDF)
   must never `innerHTML` file content.
4. **Custom protocols never accept raw paths.** `icon://`, `thumb://`, and
   `preview://` resolve *opaque per-session tokens* minted by the listing /
   search / preview commands and stored in a Rust-side map. Unknown token →
   404. `preview://` serves only paths explicitly registered by the
   open-preview command and revoked on close.
5. Command-side validation: name validation on rename/new-folder, op-shape
   checks, journal path sanitization.
6. Tauri's `assetProtocol` stays disabled; `withGlobalTauri` off.

## File Operations Engine

Why Finder stalls: (1) it deep-enumerates the whole source tree *before*
moving a byte ("Preparing to copy…"), (2) it runs synchronous hooks inside the
op path, (3) modal-feeling progress UI for one-syscall operations. Fazi:

### Fast paths, precisely scoped
- **Same-volume move** (any size) = one atomic `rename(2)`.
- **Single-file same-volume copy** = `clonefile(2)` CoW clone.
- **Directory copy, same APFS volume** = our walker clones *per entry* —
  seconds for a 10k-file folder, real per-entry progress. (Note from
  `man copyfile`: progress callbacks don't fire on the clone path, so clone
  progress is counted in entries, not bytes — the `cloned` flag on progress
  events tells the UI which count to show.)
- **Everything else** = byte copy via `copyfile(3)` `COPYFILE_ALL` (metadata,
  xattrs, resource forks, ACLs) with byte-level progress callbacks.

### Attempt first, fall back second
`st_dev` comparison is a scheduling *hint*, never a correctness decision —
firmlinks and foreign filesystems lie. Per item: attempt `rename(2)` → on
`EXDEV` fall through; attempt `clonefile` → on any failure fall through;
byte-copy via `copyfile`. Every rung handles its errno.

`std::fs::copy` is dead on arrival for a Finder replacement (drops xattrs,
tags, resource forks). `COPYFILE_RECURSIVE` is explicitly not used (cancelled
recursive copies leave created objects behind; it hides per-entry control).
The one `unsafe` module is `core/copier.rs`.

### Transactional design — no partial output, kill-safe
- **Fresh copy/replace of a top-level item:** copy into a hidden staging name
  (`.<name>.fazi-partial-<opid>`) on the destination volume, then one
  `renamex_np(RENAME_EXCL)` promote. Observers never see a half-copied item
  under its real name.
- **Directory merge:** per-entry staging — each file stages and promotes
  atomically. Guarantee is explicitly weaker: a crash leaves a
  *partially-merged directory* (reported as "N of M entries done") but never
  a half-written file.
- **Replace transaction:** stage fully, swap atomically via
  `renamex_np(RENAME_SWAP)` (APFS), then trash the swapped-out original. On
  non-swap filesystems: trash original → promote → on promote failure restore
  the original from the Trash. The "original in Trash + empty destination"
  window does not exist on APFS and is recoverable elsewhere.
- **Cross-volume move** = staged copy + **verify** + delete source, per item.
  Verify re-lstats every copied entry (size, presence, mtime with
  per-filesystem tolerance — exact on APFS, 2 s on FAT/exFAT, 5 s on
  SMB/NFS) plus metadata spot-checks (full xattr name-set + Finder-tag value
  for a sample; all files when ≤20). A source item is deleted only after
  *that item* verifies.
- **Durable journal** (`~/Library/Application Support/Fazi/ops-journal/`, one
  JSON per op): written before bytes move, updated as items promote, deleted
  on completion. On startup Fazi scans the journal, deletes orphaned staging
  artifacts (including per-entry merge staging via recorded merge roots), and
  reports interrupted ops.
- **Crash safety ≠ undo.** The journal exists for recovery. The user-facing
  undo stack lives in memory (`core/undo.rs`): inverse ops, capped at 50,
  invalidated by existence checks before applying. Replace and merge outcomes
  are not undoable (the UI says so); trashed originals remain recoverable in
  the Trash.

### Responsiveness rules
- **No blocking preflight.** Bytes move immediately; total-size enumeration
  runs concurrently and the progress denominator arrives when it lands.
- Ops on different volumes run in parallel; ops to the same destination
  volume serialize (per-device mutex).
- Conflicts pause only the asking op: the walker parks on a rendezvous
  channel; `respond_conflict` (or cancel) releases it. `fileDir`/`dirFile`
  conflicts are always per-item — never covered by apply-to-all.
- Cancellation at entry granularity; cancel = stop walker → delete staging →
  clear journal entry.

## AppKit main-thread discipline

All objc2 calls that require the main thread are confined to
`src-tauri/src/macos/` and marshaled via `main_thread::on_main` (inline when
already on main; `run_on_main_thread` + rendezvous otherwise). NSFileManager
calls (trash) are documented thread-safe and run directly on op threads.

## Module map

```
src/                       # frontend (React 19 + TS)
  types/ipc.ts             # THE wire contract (lockstep with Rust)
  lib/ipc/                 # typed wrappers — only importer of @tauri-apps/api
  lib/commands/            # command registry (palette + shortcuts single source)
  lib/{selection,sort,keyboard}.ts
  stores/                  # zustand: panes, ops, app, settings, volumes
  components/{chrome,sidebar,panes,ops,palette,preview,menus,info}/
src-tauri/src/
  commands/                # thin #[tauri::command] layer
  core/                    # entry, copier (unsafe), walker, op_queue,
                           # journal, undo, watcher, tags
  macos/                   # main_thread, icons, thumbnails, workspace,
                           # pasteboard, volumes, trash
  search/mdfind.rs
  protocols/               # icon:// thumb:// preview:// token handlers
```
