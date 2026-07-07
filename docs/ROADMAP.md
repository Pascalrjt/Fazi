# Fazi Roadmap

Estimates assume one experienced developer and are **best-case** — treat them
as sequencing weights, not commitments. Each sub-phase is independently
shippable and testable. UI polish is continuous, not a phase.

## Status

**Phases 0 + 1a–1d scaffolded end-to-end in the initial build:** two-stage
streamed listing, virtualized list + grid, navigation/history/tabs/dual pane,
the full transactional ops engine (ladder, staging, journal + recovery,
conflicts incl. merge, progress, cancel, undo/redo), multi-select
(click/shift/cmd/marquee/type-ahead), keyboard registry + command palette,
watcher deltas, filter + mdfind global search, preview overlay, custom context
menus + Open With, Get Info + tag editor, sidebar/volumes/eject, path bar,
hidden-files toggle, trash, pasteboard interop, FDA onboarding, iCloud
badges + skip-and-report ops policy. Rust suite: 46 tests. Frontend: 61 tests.

Remaining from the original phase list, still open:

## Phase 1 leftovers
- [ ] Real-device passes over `docs/MANUAL_TESTS.md` (TCC prompts, iCloud,
      external volumes, 100k-dir perf, kill -9 mid-copy)
- [ ] Viewport-priority hydration (frontend reports visible range)
- [ ] Paste image/text from clipboard as a new file

## Phase 2 — Hardening (~4 wk)
- [ ] Columns (Miller) view
- [ ] Tag sidebar filters
- [ ] iCloud download/evict UX (beyond skip-and-retry)
- [ ] Share sheet / AirDrop **send** (NSSharingServicePicker)
- [ ] Drag-out to Finder (`tauri-plugin-drag`; copy-only, static image —
      documented limitation)
- [ ] Empty Trash (with warning) + Trash browsing polish
- [ ] Folder sizes in list view (lazy, cached)
- [ ] Per-directory view settings
- [ ] Settings window (accent color, defaults, full-checksum verify toggle)
- [ ] Signed + notarized DMG, auto-update (Developer ID; Mac App Store is
      ruled out — sandbox off by design)

## Phase 3 — Power tools (~4–6 wk)
- [ ] Batch rename (regex/numbering, live preview)
- [ ] Archives (zip crate + `ditto` fallback)
- [ ] Multi-window
- [ ] Rust-side directory sessions (escape hatch if 100k-entry dirs ever hurt
      the JS-side model)
- [ ] Smart folders (saved searches)
- [ ] Theming beyond dark/light
- [ ] Network volume polish (connect-to-server, credential UX)

## Phase 4 — Parity stretch
- [ ] True embedded QLPreviewPanel attempt (fragile responder-chain surgery)
- [ ] Services menu integration
- [ ] Git status column
- [ ] Pane diff (compare two folders)
- [ ] CLI + URL scheme (`fazi /path`)

## Engineering debt / known simplifications
- Volume mount detection is a 2 s path-set poll → replace with NSWorkspace
  notification observers.
- Merge outcomes and Replace are not undoable via ⌘Z (originals recoverable
  from Trash; UI says so). Per-entry merge undo is a possible Phase 3 item.
- Watcher upserts stat one path per changed name → add a bulk `stat_paths`
  command if hot dirs get chatty.
- mdfind result cap at 2000 rows (UI truncation note lives in the search
  view).
- Icon cache clears wholesale past 4096 entries (crude but bounded).
