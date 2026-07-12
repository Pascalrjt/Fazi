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
- [ ] Sidebar Trash row navigates to ~/.Trash; the banner shows the item
      count; dragging items onto the row trashes them (Put Back still works).
- [ ] Empty Trash… (banner button / palette / row context menu): confirm
      dialog totals items across volumes ("N items (M on external volumes)"
      with a seeded external-volume .Trashes fixture); after emptying, ⌘Z has
      nothing referencing the emptied content (purged undo history).
- [ ] Empty Trash with an undeletable item (chmod 555 dir) reports the error
      and still deletes the rest.
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

## Dataless (evicted cloud) files
- [ ] Copying a dataless file ("Remove Download" in Finder first) fails that
      item with "content not downloaded (dataless); can't be copied" — the op
      is partial, other items succeed.
- [ ] Same-volume move/rename of a folder containing dataless descendants
      succeeds instantly (fast rename never touches file content; the
      descendants stay dataless and intact).
- [ ] Cross-volume move of a folder containing a dataless descendant fails
      that top-level item (verification) and the source is left untouched.

## Volumes
- [ ] Plugging a USB disk adds it to the sidebar ≤2 s; eject button works;
      ejecting while browsing it walks the tab up + toast.
- [ ] SMB share: browse (DT_UNKNOWN pass-1 rows hydrate correctly), copy to
      and from, search shows the unindexed-volume notice.

## Search
- [ ] Filename/Contents pill: switching to Contents re-runs the query and
      returns kMDItemTextContent hits; the results header notes "matching
      file contents".
- [ ] Predicates: `kind:image`, `date:7d`, `size:>10mb` narrow results;
      the "?" popover lists the syntax; unparseable values search as text.
- [ ] A query with >2,000 matches renders past the old cap (default 10,000)
      with a "showing the first N results" note when truncated; scrolling a
      10k-hit list stays smooth (batched updates).
- [ ] Unindexed volume (mdutil -i off on a test stick): searching This Folder
      on it auto-falls back to the walker with the "searched by walking"
      caption; predicates still apply; This Mac scope and Contents mode show
      their explanatory notices instead of falling back.

## Fuzzy finder (⌘P)
- [ ] ⌘P on a ~100k-file tree: overlay opens instantly, results refine live
      while the footer counts up "indexing… N items"; typing mid-index keeps
      refining without stalls.
- [ ] Tab toggles This Folder ↔ Home; the old scope's in-flight query is
      cancelled (no stale rows flash in).
- [ ] Enter opens the hit; ⌘Enter navigates to its parent with the hit
      selected; Esc closes and ⌘P over a previously-warm root reuses the
      index (footer shows its age).
- [ ] Rebuild (footer button / ⌘R) re-walks; after a copy INTO the indexed
      root completes, reopening ⌘P rebuilds automatically (stale marking).
- [ ] With fuzzyIndexMaxEntries lowered, the footer shows "index capped".

## Previews
- [ ] Space on: JPEG/PNG/HEIC (zoom/pan), MP4/MOV (plays, seeks), MP3,
      .txt/.rs/.ts (text with line numbers), .docx / .sketch (QL thumbnail
      render), a 0-byte file, a broken symlink (no crash).
- [ ] PDF: multi-page renders via pdf.js; PageUp/PageDown and the on-screen
      arrows page; ←/→ still walk file-to-file; a >100 MB PDF falls back to
      the thumbnail. Verify in `tauri dev` AND the bundled app (worker URL
      forms differ dev vs prod).
- [ ] ←/→ walks the selection; title shows "n of m"; Esc and Space close.
- [ ] ⌘Y opens qlmanage for anything exotic.

## Packages & links
- [ ] .app opens on double-click/⏎; "Show Package Contents" browses inside;
      progress counts it as one item.
- [ ] `.photoslibrary` behaves as a file.
- [ ] Symlink shows badge + target; copying a symlink copies the link;
      broken symlinks list and copy without error.
- [ ] A Finder alias shows the alias badge.

## Share
- [ ] Right-click a file → Share: spinner, then the system's destinations
      with icons (AirDrop, Mail, Messages, plus any installed share
      extensions); AirDrop opens its window with the file attached; Mail
      opens a draft with the attachment.
- [ ] Multi-select → Share sends all selected files; the list narrows to
      services that accept the whole set.
- [ ] ⌘⇧S (and palette "Share…") opens the same menu centered; no-op with
      nothing selected; rebinding it in Settings → Keyboard works.
- [ ] Open Share, dismiss, open again and pick a destination — still works
      (each open re-enumerates; a stale pick shows a toast, never a crash).

## Perf
- [ ] 100k-file directory: first rows <50 ms, scrolling never hitches,
      sort settles once, filter-as-you-type stays instant.
- [ ] 100k-file directory hydrates from the viewport outward: visible rows
      lose their shimmer first (even after jumping to the middle), the rest
      trickles in the background, and navigating away mid-hydration leaves
      no stray updates in the next folder.
- [ ] Folder sizes (Advanced → on): list-view dirs show "…" then the value
      as rows scroll into view (max 2 computing at once); copying INTO a
      cached folder refreshes its size; values recompute after ~5 min TTL.
- [ ] Open a dir on a slow SMB share: thin indeterminate bar, pane stays
      interactive, no blank white pane.

## Settings (⌘,)
- [ ] ⌘, opens the overlay; browse shortcuts don't fire underneath; Esc
      closes. Theme Light/Dark/System applies live (System follows the OS);
      accent swatches recolor selection/focus; Compact density tightens list
      rows without breaking marquee selection.
- [ ] Operations → Verify copies: a large copy shows "Verifying…" after the
      bytes land; flip a byte in the source mid-copy is impractical — instead
      verify a normal copy passes clean, and confirm cross-volume moves still
      verify with the toggle OFF (mandatory gate unaffected).
- [ ] Keyboard pane: Record ⌘⇧M for New Folder → palette label updates, old
      binding dead, new one fires; recording ⌘D (Duplicate's) is blocked with
      "unbind the other command"; Unbind removes a shortcut; Reset restores
      the default; all of it survives relaunch.
- [ ] Corrupt-blob recovery: hand-edit localStorage fazi-settings
      keybindingOverrides to garbage → app still boots with default
      shortcuts.
- [ ] Confirm toggles: disabling "Confirm permanent delete" / "Confirm Empty
      Trash" skips those dialogs; Reset-to-defaults restores everything but
      keeps pinned folders and column widths.

## Batch rename & paste-as-file
- [ ] Select 5 files → ⌘⇧R: live preview updates per keystroke; a colliding
      target flags its row and disables Rename; regex capture groups and
      numbering work; Apply renames all 5 and ONE ⌘Z restores every name.
- [ ] Permutation: select 1.jpg + 2.jpg, rename to each other's names →
      contents swap correctly; ⌘Z swaps back.
- [ ] Copy an image in Preview.app → ⌘V in Fazi creates "Pasted Image.png"
      (selected); copy text → "Pasted Text.txt"; ⌘V again uniquifies
      ("Pasted Image 2.png"). ⌘Z trashes it; ⌘⇧Z restores it from the Trash.
- [ ] ⌘⌥V with no file paths on the pasteboard stays a no-op (never creates
      a clipboard file).

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

## Drag-out (native)
- [ ] Drag a file from Fazi into Finder → copies there; into Mail → attaches;
      into Slack/a browser upload field → uploads. Multi-select shows the
      count badge on the drag image.
- [ ] Self-drop: drag a row onto another Fazi folder row → internal MOVE
      (not copy); ⌥ during the drag → copy. Drop onto the sidebar Trash row →
      trashed with Put Back intact.
- [ ] Self-drop onto the row's own parent folder is a no-op (no duplicate).
- [ ] A cancelled native drag (Esc / drop on nothing) leaves the next
      Finder→Fazi drag-in a COPY (the self-drop flag cleared).
- [ ] Kill-switch: Advanced → disable drag-out → rows drag HTML5-only again
      (internal DnD works, Finder drop does nothing).
- [ ] Sidebar favorite reorder still works with drag-out enabled (it is
      pointer-event based, independent of any drag system).

## Archives
- [ ] Compress a large folder and cancel mid-way → op card disappears, no
      `.fazi-partial-*` leftovers in the destination, no zip produced.
- [ ] Force-quit (`kill -9`) mid-compress → relaunch cleans all staging and
      the interruption toast reads "0 of 1 item" (never "0 of N sources").
- [ ] Finder opens the produced zip and shows the expected layout: single
      file → the file at zip root; single folder → one top-level folder;
      multi-select → all items at zip root (named `Archive.zip`).
- [ ] Multi-select compress including a dataless file ("Remove Download" in
      Finder first) → the op fails all-or-nothing with the dataless item
      error; no zip is produced.
- [ ] Extract a `.tar.gz` → contents promoted next to the archive; a
      single-root tarball promotes under the inner name (no `X/X` nesting).
- [ ] ⌘Z after compress trashes the zip; Edit menu reads "Undo Compress of
      1 Item"; ⌘⇧Z restores it and the menu still says Compress.
- [ ] Compress/extract progress: compress card shows bytes (no rate/ETA) and
      never exceeds 100%; multi-archive extract shows "N of M archives" and
      advances past a failed archive.

## Sidebar favorites
- [ ] Right-click a folder → "Add to Sidebar" pins it under the default
      Favorites; pinning ~/Downloads again is refused (no duplicate row).
- [ ] Drag a folder from the file list over the Favorites section: hovering
      a row's top/bottom edge shows the 2 px insertion line; hovering its
      center shows the row drop-ring — exactly one indicator at a time.
      Edge drop pins at that slot; center drop moves INTO that folder
      (⌥ = copy) — it must not pin.
- [ ] Hovering the defaults region (Home…Applications) shows the line above
      the first pin and drops at slot 0; section whitespace pins at the end;
      works with zero existing pins.
- [ ] Dragging a file (non-folder) to an edge is refused with "Only folders
      can be added to the sidebar"; an already-pinned folder toasts "Already
      in the sidebar".
- [ ] Drag a pinned favorite row up/down (press + move ≥4 px) → 2 px
      insertion line follows the pointer, drop reorders, order persists
      across relaunch; Escape mid-drag cancels; a plain click (no movement)
      still navigates, and the release after a reorder does NOT navigate.
- [ ] Right-click a pinned row → "Remove from Sidebar"; default rows offer no
      such item.
- [ ] Finder drag-in over Favorites: the insertion line appears as soon as
      the drag enters the window and tracks the cursor; dropping on a row
      edge / whitespace pins at that slot, on a row center copies into that
      folder. Finder drops on panes still copy; on the Trash row still trash.
- [ ] Native self-drop (drag a Fazi row out and back onto Favorites): row
      edge / whitespace pins, row center moves (⌥ = copy).

## Sidebar icons
- [ ] All sidebar rows show lucide icons (no emoji): Home, Desktop,
      Documents, Downloads, Applications, pinned folders, Trash, volumes
      (internal vs USB differ); tint follows the row (accent-dim current
      row, secondary otherwise) in light AND dark themes.
- [ ] Eject icon appears on ejectable-volume hover and still ejects.
- [ ] Lock icon renders in the FDA banner, the permission-denied pane state,
      and the no-access row badge; the error pane shows the warning triangle
      in the danger color.
