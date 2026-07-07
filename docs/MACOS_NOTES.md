# macOS Notes — hard problems and how Fazi handles them

## TCC / Full Disk Access
- Usage strings live in `src-tauri/Info.plist` (Desktop, Documents, Downloads,
  removable/network volumes). macOS shows per-folder consent prompts on first
  access.
- **FDA cannot be requested programmatically.** Fazi probes a TCC-gated path
  (`~/Library/Safari`, `/Library/Application Support/com.apple.TCC`); when the
  probe fails, an onboarding card deep-links to
  `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles`.
- Every listing error renders in-pane (lock icon + "Grant access") — never a
  silent empty folder.
- **Dev pitfall:** TCC binds to the signing identity. Grant FDA to your
  terminal (or the dev binary) during development, and expect prompts to reset
  when the identity changes.

## Packages (.app, .photoslibrary, …)
- Extension fast path (`core/entry.rs::PACKAGE_EXTS`), plus batched
  NSWorkspace `isFilePackageAtPath:` for ambiguous dirs-with-extensions
  during hydration (one main-thread trip per ~256-entry batch).
- Packages are one logical item everywhere: open = launch, conflict UI and
  progress count them once, "Show Package Contents" is explicit navigation.

## Symlinks vs Finder aliases — two different beasts
- Symlinks: `lstat`, never followed by the ops engine (`COPYFILE_NOFOLLOW`,
  `CLONE_NOFOLLOW`); copied as links; broken links copy as-is.
- Finder aliases are regular *files* holding bookmark data. Detection reads
  the `kIsAlias` bit (0x8000) in the FinderInfo xattr's finderFlags — no
  per-file objc2 call needed. (Resolution with no-UI/no-mount flags is a
  Phase 2+ item.)

## Case-insensitive APFS
- Conflict detection compares names case-insensitively everywhere
  (`walker::exists_ci`), matching APFS defaults.
- Case-only rename (`foo` → `Foo`) is allowed: the rename command detects the
  self-collision by comparing lowercased old/new names rather than testing
  existence (which would false-positive on APFS).

## iCloud
- Placeholders are `.<name>.icloud` binary plists; listings merge them in
  under their real names with a cloud badge and the plist's size.
- Dataless files carry `SF_DATALESS` in `st_flags`.
- **Ops policy (decided): copy/move batches SKIP non-downloaded placeholders,
  never silently** — the op reports "N items skipped (not downloaded from
  iCloud)" with a one-click "Download & retry". This avoids surprise
  bandwidth/disk and the dataless edge cases in Apple's clone/copy paths.
- Download trigger: `startDownloadingUbiquitousItemAtURL:`.

## Trash
- `NSFileManager trashItemAtURL:resultingItemURL:` — Finder's "Put Back"
  works, and the resulting URL is recorded for undo. Never `rm`.
- NSFileManager is thread-safe; trash runs directly on op threads.

## Main-thread discipline
- NSWorkspace, NSPasteboard, NSImage rasterization: main thread only,
  marshaled via `macos/main_thread.rs::on_main` (inline when already on
  main). Getting this wrong = random-looking crashes.
- QLThumbnailGenerator dispatches internally; its completion handler converts
  CGImage→PNG off-main via `NSBitmapImageRep initWithCGImage:` (safe).

## Pasteboard
- Copy writes real `public.file-url` items — pastes into Finder, Mail, Slack,
  terminals, open/save dialogs.
- Paste reads file URLs from any app.
- Cut is a Fazi-side marker: we remember the changeCount of our own write; if
  the pasteboard's changeCount moved on, another app wrote it and cut no
  longer applies.

## Watching
- FSEvents via `notify` + 150 ms debouncer, non-recursive per open dir.
- FSEvents reports canonical paths: the watcher canonicalizes its root or
  deltas silently vanish (e.g. `/var` vs `/private/var`, `/tmp`).
- Batches are name-level upsert/remove deltas classified by what exists *now*
  (robust across rename-semantics differences).

## mtime tolerance in verification (cross-volume moves)
| Destination fs | Tolerance |
|---|---|
| apfs, hfs | exact (2 ms for ns→ms rounding) |
| msdos, exfat | 2 s (FAT timestamp granularity) |
| smbfs, nfs, webdav | 5 s |
| anything else | 2 s |

## Flagged infeasibilities (no surprises)
- **Receiving AirDrop: impossible** for a third-party app (send works via
  NSSharingServicePicker — Phase 2).
- **Embedded QLPreviewPanel**: fragile responder-chain surgery — deferred to
  Phase 4. `Cmd+Y` shells to `qlmanage -p` meanwhile.
- **Drag-out to Finder**: `tauri-plugin-drag` gives copy-only semantics with
  a static drag image (Phase 2, documented limitation).
- **Mac App Store: ruled out** (sandbox off by design; Developer ID +
  notarized DMG distribution).
- **Spotlight on unindexed volumes** returns nothing — the search UI says so
  instead of showing an empty list.

## Icon / thumbnail serving
- `icon://` = NSWorkspace `iconForFile:` rasterized to PNG at the requested
  pixel size on the main thread, cached by extension (per-path for apps,
  packages, custom-icon files — `kHasCustomIcon` FinderInfo bit).
- `thumb://` = QLThumbnailGenerator (Quick Look's own renderer → real
  previews for Office/Sketch/etc.), disk cache keyed (path, mtime, size),
  pruned to ~300 MB at startup, falls back to the icon.
- Both resolve opaque tokens, never paths (see ARCHITECTURE.md threat model).
