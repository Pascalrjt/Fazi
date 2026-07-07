# Manual Test Checklist

Things automated tests can't cover — run on a real machine before calling a
phase done. Check items off per release.

## Setup / TCC
- [ ] Fresh signing identity: launching Fazi and browsing ~/Desktop,
      ~/Documents, ~/Downloads shows the macOS consent prompts once each;
      denying renders the designed lock/error pane (never a silent empty list).
- [ ] FDA banner appears without Full Disk Access; "Open Settings" lands on
      Privacy & Security → Full Disk Access; after granting + relaunch the
      banner is gone and ~/Library/Safari lists.
- [ ] Dev note: grant FDA to the dev terminal, or `~/Library` browsing fails
      in `npm run tauri dev`.

## The reason this app exists (ops acceptance)
- [ ] Same-volume move of a 100 GB folder → completes <1 s, **no progress
      card** (parity with `mv`).
- [ ] Same-volume copy of a 10k-file folder → per-entry clone: seconds, not
      minutes; negligible extra disk; progress counts entries.
- [ ] Cross-volume copy to a USB disk → bytes flowing within 250 ms (card
      appears ~250 ms in, already showing "X copied"), UI fully interactive
      throughout, live rate + ETA.
- [ ] `kill -9` mid cross-volume copy → relaunch reports "Copy interrupted —
      N of M items completed"; destination contains **only fully-promoted
      items**; zero `.fazi-partial-*` anywhere; source untouched.
- [ ] Cancel mid-copy → destination clean, source untouched.
- [ ] Copy onto an exFAT/FAT32 USB stick → succeeds; verify does not
      false-positive on mtime (2 s granularity); tags/xattrs silently dropped
      by the filesystem do not corrupt the copy itself.

## Clipboard interop (both directions)
- [ ] Copy files in Fazi → paste in Finder works.
- [ ] Copy files in Fazi → ⌘V in Terminal pastes path(s).
- [ ] Copy files in Finder → paste in Fazi copies them into the current dir.
- [ ] Copy in Fazi → copy something else in another app → paste in Fazi uses
      the other app's content (changeCount logic).
- [ ] Cut (⌘X) dims sources; pasting moves; cutting then copying elsewhere
      un-dims.
- [ ] "Copy as Pathname" (⌘⌥C) pastes absolute paths as text.

## Trash & undo
- [ ] ⌘⌫ → toast with Undo; item appears in Finder's Trash with working
      "Put Back".
- [ ] ⌘Z after trash restores to the original folder.
- [ ] ⌘Z after a move returns items; ⌘⇧Z re-applies.
- [ ] Replace in a conflict: old file is in Trash; ⌘Z does NOT undo the
      replace (UI marked it); the file is recoverable from Trash manually.
- [ ] ⌘⌥⌫ permanent delete shows the confirm dialog (the only one).

## Conflicts
- [ ] File vs file: dialog shows both sizes + dates; Keep Both produces
      "name 2.ext"; Apply to All asks once for N collisions.
- [ ] Folder vs folder: Merge is the highlighted default; merge unions
      contents and prompts per colliding file lazily.
- [ ] File vs folder: per-item prompt; no Apply-to-all offered.
- [ ] Case-only rename `foo` → `Foo` works; `foo` → existing `BAR` variant
      `bar` is a collision.

## iCloud
- [ ] iCloud Drive shows placeholders with cloud badges and real names/sizes.
- [ ] Opening a placeholder triggers download.
- [ ] Copying a folder containing non-downloaded items skips them and the op
      card offers "Download & retry skipped".

## Volumes
- [ ] Plugging a USB disk adds it to the sidebar ≤2 s; eject button works;
      ejecting while browsing it walks the tab up + toast.
- [ ] SMB share: browse (DT_UNKNOWN pass-1 rows hydrate correctly), copy to
      and from, search shows the unindexed-volume notice.

## Previews
- [ ] Space on: JPEG/PNG/HEIC (zoom/pan), MP4/MOV (plays, seeks), MP3, PDF
      (page thumbnail render), .txt/.rs/.ts (text with line numbers), .docx /
      .sketch (QL thumbnail render), a 0-byte file, a broken symlink (no
      crash).
- [ ] ←/→ walks the selection; title shows "n of m"; Esc and Space close.
- [ ] ⌘Y opens qlmanage for anything exotic.

## Packages & links
- [ ] .app opens on double-click/⏎; "Show Package Contents" browses inside;
      progress counts it as one item.
- [ ] `.photoslibrary` behaves as a file.
- [ ] Symlink shows badge + target; copying a symlink copies the link;
      broken symlinks list and copy without error.
- [ ] A Finder alias shows the alias badge.

## Perf
- [ ] 100k-file directory: first rows <50 ms, scrolling never hitches,
      sort settles once, filter-as-you-type stays instant.
- [ ] Open a dir on a slow SMB share: thin indeterminate bar, pane stays
      interactive, no blank white pane.

## Keyboard sweep
- [ ] ⏎ rename (stem preselected), Tab serial-rename, Esc cancels.
- [ ] ⌘⇧N new folder appears in rename mode, sorted into place.
- [ ] ⌘K palette lists every command with its shortcut; fuzzy search works.
- [ ] ⌘⇧D dual pane, Tab swaps panes, ⌘T/⌘W tabs, ⌘1/⌘2 views, ⌘⇧. hidden
      files, ⌘F filter, ⌘⇧F global search, ⌘I Get Info, ⌘⇧G edit path.
- [ ] Marquee selection over a scrolled 10k list selects offscreen rows
      (verify via status-bar count).

## Drag & drop
- [ ] Drag from Finder into a Fazi folder row / pane background copies there.
- [ ] Within Fazi: drag to folder rows, breadcrumbs, sidebar, other pane;
      spring-loaded folders open after ~600 ms hover; ⌥ shows copy behavior.
