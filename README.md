# Fazi

A keyboard-first, power-user **macOS file manager** built as a daily-driver
Finder replacement. Tauri 2 + React 19 + TypeScript on the front, Rust on
everything that touches disk.

**Why:** Finder stalls on copy/move operations that are instant in the
terminal. Fazi's file-operations engine is built around never doing that —
same-volume moves are one atomic `rename(2)`, same-volume copies are APFS
clones, everything else is a staged, journaled, verified `copyfile(3)` with
real progress and kill-safety.

## Highlights

- **Fast ops, honestly scoped** — rename → clonefile → copyfile attempt
  ladder per item; no blocking "Preparing to copy…", ever
- **Transactional** — hidden staging + atomic promote, durable op journal
  with startup recovery, cross-volume moves verified before the source is
  deleted; `kill -9` mid-copy never leaves a half-written file under its
  real name
- **Full conflict matrix** — Keep Both / Replace / Merge / Skip with
  apply-to-all, Finder-familiar dialog, merge as the safe default
- **Keyboard-first** — Finder-parity shortcuts, one command registry feeding
  both the dispatcher and a ⌘K palette
- **Multi-select as a first-class citizen** — click/⇧/⌘/marquee/type-ahead;
  every operation takes the whole selection
- Tabs + dual pane, spacebar previews (Quick Look's renderer), streamed
  mdfind search, Finder tags, Open With, real pasteboard interop both
  directions, iCloud awareness, live FSEvents updates
- **100k-entry directories** — two-stage streamed listing, first paint <50 ms

## Development

```bash
npm install
npm run tauri dev      # run the app
npm test               # frontend tests (vitest)
cargo test             # Rust tests, in src-tauri/ (46 tests incl. ops engine)
npm run tauri build    # release build (DMG)
```

Grant your terminal Full Disk Access during development — TCC binds to the
signing identity.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — process split, IPC
  contract, ops engine design, webview threat model
- [`docs/MACOS_NOTES.md`](docs/MACOS_NOTES.md) — TCC, packages, aliases,
  iCloud, case-insensitivity, known infeasibilities
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — phases and open items
- [`docs/MANUAL_TESTS.md`](docs/MANUAL_TESTS.md) — real-device checklist

Distribution target: Developer ID + notarized DMG. Mac App Store is ruled out
by design (the sandbox is incompatible with a full-disk file manager).
