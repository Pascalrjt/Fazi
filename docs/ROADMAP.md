# Fazi Roadmap

Estimates assume one experienced developer and are **best-case** — treat them
as sequencing weights, not commitments. Each milestone is independently
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

Since then: user-pinnable sidebar favorites and the archive engine
(compress/extract with staging + journal crash safety) have landed.
Current suites: **89 Rust tests, 84 frontend tests** (tsc clean).

**Direction change (2026-07):** iCloud support is being removed — dataless
(not-downloaded) files become per-item copy errors instead of
download-and-retry UX; "iCloud download/evict UX" is dropped from the plan.
The daily-driver Tier structure below supersedes the old Phase 2/3/4 lists.

## Daily-driver milestones

Ordered for optimal build sequencing, not strict tier order. Tier 0 =
blocks daily-driver adoption; Tier 1 = high-value quality of life.

- [x] **M1 — De-iCloud + free wins** (Tier 1 #6, Tier 0 #5, #3):
      remove iCloud plumbing (dataless files → per-item copy errors;
      same-volume moves/renames of trees containing dataless descendants
      remain allowed — the fast rename path never touches file content),
      Filename/Contents search toggle in the toolbar, Empty Trash
      (all-volume stats, streamed progress, undo-history purge) + Trash
      sidebar row with drop-to-trash semantics.
- [x] **M2 — Drag-out + PDF preview** (Tier 0 #1, #4): native drag-out via
      `tauri-plugin-drag` (self-drop bridge, ⌥-copy, kill-switch setting;
      copy-only + static drag image are documented limitations), pdf.js
      preview overlay (CORS on `preview://` + CSP delta prerequisite).
- [x] **M3 — Fuzzy finder** (Tier 0 #2): ⌘P overlay backed by a concurrent
      Rust index (`nucleo-matcher`, jwalk walk, live query refinement while
      indexing, per-query cancellation, capped at 2M entries). Index is a
      snapshot of the walk moment (watchers are non-recursive); footer shows
      age + explicit Rebuild.
- [x] **M4 — Search predicates + cap** (Tier 1 #9): `kind:/date:/size:`
      predicate tokens compiled to raw mdfind queries, configurable result
      cap on both sides with a truncation note, not-indexed volume detection
      with automatic fuzzy-walker fallback (This-Mac scope and Contents mode
      excluded), bulk `stat_paths` (watcher-upsert debt payoff).
- [x] **M5 — Settings + keybindings** (Tier 1 #10, #8): in-app settings
      overlay on ⌘, (General/Appearance/Keyboard/Search/Operations/Sidebar/
      Advanced), opt-in BLAKE3 copy verification with a wire-level
      "verifying" phase, custom keybindings with recorder + conflict
      detection.
- [ ] **M6 — Batch rename + paste-as-file** (Tier 1 #7, #11): all-or-nothing
      two-phase batch rename (regex/numbering, live preview, ⌘⇧R, single
      undo entry), paste clipboard image/text as a new file with full
      undo/redo through Trash.
- [ ] **M7 — Viewport hydration + folder sizes** (Phase 1 leftover, Tier 1
      #12): listings >5,000 entries hydrate on demand from the viewport
      outward via an id-preserving `hydrate_paths` patch API (single shared
      scheduler), lazy folder sizes in list view (opt-in, cached,
      explicitly approximate, 5-min TTL).

## Phase 1 leftovers

- [ ] Real-device passes over `docs/MANUAL_TESTS.md` (TCC prompts,
      external volumes, 100k-dir perf, kill -9 mid-copy)
- [ ] Viewport-priority hydration (→ M7)
- [ ] Paste image/text from clipboard as a new file (→ M6)

## Done (former Phase 2/3 items)

- [x] User-pinnable sidebar favorites (context menu + drag-to-pin onto the
      Favorites section, drag-to-reorder, remove; persisted in settings)
- [x] Archives — compress any selection to Finder-compatible `.zip` via
      `ditto`; extract `.zip` + tar family (`.tar/.tgz/.tar.gz/.tar.bz2/.tar.xz`)
      via `ditto`/`bsdtar`, with staging + journal crash safety, post-extract
      path validation, typed undo ("Undo Compress/Extract of N Items")

## Later

Everything below is preserved from the old phase lists; none of it blocks
daily-driver use.

- [ ] Columns (Miller) view
- [ ] Tag sidebar filters
- [ ] Share sheet / AirDrop **send** (NSSharingServicePicker)
- [ ] Per-directory view settings (placeholder lands in M5 Advanced pane)
- [ ] Signed + notarized DMG, auto-update (Developer ID; Mac App Store is
      ruled out — sandbox off by design)
- [ ] Multi-window
- [ ] Rust-side directory sessions (escape hatch if 100k-entry dirs ever hurt
      the JS-side model)
- [ ] Smart folders (saved searches)
- [ ] Theming beyond dark/light (M5 ships accent + density)
- [ ] Network volume polish (connect-to-server, credential UX)
- [ ] True embedded QLPreviewPanel attempt (fragile responder-chain surgery)
- [ ] Services menu integration
- [ ] Git status column
- [ ] Pane diff (compare two folders)
- [ ] CLI + URL scheme (`fazi /path`)

Dropped: iCloud download/evict UX (iCloud support removed in M1).

## Engineering debt / known simplifications

- Volume mount detection is a 2 s path-set poll → replace with NSWorkspace
  notification observers.
- Merge outcomes and Replace are not undoable via ⌘Z (originals recoverable
  from Trash; UI says so). Per-entry merge undo is a possible later item.
- ~~Watcher upserts stat one path per changed name~~ — resolved: `stat_paths`
  bulk command (M4); M7 adds the id-preserving `hydrate_paths` patch API.
- ~~mdfind result cap at 2000 rows~~ — resolved in M4 (configurable cap on
  both sides, truncation note).
- Icon cache clears wholesale past 4096 entries (crude but bounded).
- TokenTable grows with every listing/search; at ~100k-entry listings the
  icon-token table becomes a memory concern — M7 stops minting new tokens on
  rehydrate, and search/fuzzy owner scopes are revoked on replacement/close.
- Drag-out (M2) is copy-only with a static drag image — a
  `tauri-plugin-drag` limitation, documented, revisit if the plugin grows
  promise-file support.
