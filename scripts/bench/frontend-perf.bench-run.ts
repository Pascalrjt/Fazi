/**
 * Frontend perf benchmark on synthetic 100k-entry tabs, through the real
 * store/lib functions. Runs under Node/V8 (vitest + jsdom), NOT the app's
 * JavaScriptCore — absolute numbers differ, ratios are indicative.
 *
 *   BENCH_IMPL=after BENCH_OUT=/tmp/fazi-bench/frontend-after.json \
 *     npx vitest run --config scripts/bench/vitest.bench.config.ts
 *
 * The same file runs against the baseline tree with BENCH_IMPL=before; the
 * impl.* adapters hold only code that moved out of components.
 */
import { it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Entry } from "../../src/types/ipc";

vi.mock("../../src/lib/ipc", () => ({
  listDir: () => Promise.resolve(),
  cancelListing: () => Promise.resolve(),
  watchDir: () => Promise.resolve(),
  unwatch: () => Promise.resolve(),
  statPath: () => Promise.resolve(null),
  hydratePaths: () => Promise.resolve([]),
  statPaths: (_owner: string, paths: string[]) =>
    Promise.resolve(paths.map((p) => statResult(p))),
}));

import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { usePanes, type Tab } from "../../src/stores/panes";
import { useApp } from "../../src/stores/app";
import { sortEntries } from "../../src/lib/sort";
import { moveLeadBy, rebuildRegistry } from "../../src/lib/commands";
import { useKeyboard } from "../../src/hooks/useKeyboard";

const N = 100_000;
const IMPL = process.env.BENCH_IMPL ?? "after";
const OUT = process.env.BENCH_OUT ?? `/tmp/fazi-bench/frontend-${IMPL}.json`;

// ---------------------------------------------------------------------------
// synthetic data
// ---------------------------------------------------------------------------

let seed = 12345;
function rand(): number {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
}
const WORDS = ["Report", "photo", "IMG_", "invoice", "Notes", "draft", "Screen Shot ", "data", "build", "readme"];
const EXTS = ["txt", "png", "jpg", "pdf", "md", "json", "ts", ""];

let nextId = 1;
function makeEntry(name: string, kind: "file" | "dir" = "file", hydrated = true): Entry {
  const id = nextId++;
  const dot = name.lastIndexOf(".");
  return {
    id,
    name,
    path: `/big/${name}`,
    kind,
    hidden: name.startsWith("."),
    icon: `tok-${id}`,
    ext: dot > 0 ? name.slice(dot + 1) : "",
    hydrated,
    size: hydrated && kind === "file" ? Math.floor(rand() * 1e7) : null,
    mtime: hydrated ? 1.6e12 + Math.floor(rand() * 1e10) : null,
    btime: null,
    isPackage: false,
    isAlias: false,
    linkTarget: null,
    tags: [],
    noAccess: false,
    customIcon: false,
  };
}

function makeName(i: number): string {
  const w = WORDS[i % WORDS.length];
  const ext = EXTS[i % EXTS.length];
  const hidden = i % 50 === 0 ? "." : "";
  // a sprinkle of non-ASCII names exercises the collator fallback
  const accent = i % 97 === 0 ? "é" : "";
  return `${hidden}${w}${accent}${i}${ext ? `.${ext}` : ""}`;
}

function makeEntries(n: number, hydrated = true): Entry[] {
  const out: Entry[] = [];
  for (let i = 0; i < n; i++) {
    out.push(makeEntry(makeName(i), i % 40 === 0 ? "dir" : "file", hydrated));
  }
  return out;
}

function statResult(path: string): Entry {
  return makeEntry(path.slice(path.lastIndexOf("/") + 1));
}

const BASE = makeEntries(N);
const SORTED = sortEntries(BASE, { key: "name", dir: "asc" });

function baseTab(entries: Entry[], over: Partial<Tab> = {}): Tab {
  return {
    id: "t1",
    path: "/big",
    back: [],
    forward: [],
    listingId: "L1",
    watchId: "W1",
    entries,
    total: entries.length,
    listed: true,
    loading: false,
    sorting: false,
    error: null,
    sort: { key: "name", dir: "asc" },
    filter: "",
    showHidden: false,
    selection: { selected: new Set(), anchor: null, lead: null },
    scrollTop: 0,
    pendingRestore: null,
    ghosts: [],
    ...over,
  };
}

function install(tab: Tab): void {
  usePanes.setState({ panes: [{ id: "left", tabs: [tab], activeTabId: tab.id }], split: false });
  useApp.setState({ activePaneId: "left" });
}
const cur = (): Tab => usePanes.getState().panes[0].tabs[0];

// ---------------------------------------------------------------------------
// timing
// ---------------------------------------------------------------------------

interface Result {
  name: string;
  unit: "ms";
  median: number;
  iterations: number;
  note: string;
}
const results: Result[] = [];

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Run `body` (timed) after `setup` (untimed) at least `min` times, up to
 * `max`, stopping early once `budgetMs` of timed work has accumulated.
 * `per` divides each sample (per-event cost for multi-event bodies).
 */
async function bench(
  name: string,
  note: string,
  opts: { min?: number; max?: number; budgetMs?: number; per?: number; warmup?: number },
  setup: () => unknown,
  body: (ctx: unknown) => unknown | Promise<unknown>,
): Promise<void> {
  const { min = 5, max = 15, budgetMs = 20_000, per = 1, warmup = 1 } = opts;
  for (let i = 0; i < warmup; i++) {
    const ctx = setup();
    await body(ctx);
  }
  const samples: number[] = [];
  let spent = 0;
  while (samples.length < max && (samples.length < min || spent < budgetMs)) {
    const ctx = setup();
    const t0 = performance.now();
    await body(ctx);
    const dt = performance.now() - t0;
    spent += dt;
    samples.push(dt / per);
  }
  const m = median(samples);
  results.push({ name, unit: "ms", median: m, iterations: samples.length, note });
  console.log(`[${IMPL}] ${name}: ${m.toFixed(3)} ms (n=${samples.length})`);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// benchmarks
// ---------------------------------------------------------------------------

it("frontend perf", async () => {
  const impl = await import(`./impl.${IMPL}.ts`);
  rebuildRegistry();

  // F1 — watcher batch: 500 new files into 100k entries, stat → apply.
  await bench(
    "watcher batch: 500 new files into 100k",
    "applyWatchBatch + resolved statPaths; old path ran upsertEntryNow per entry (draft findIndex + full sort + index rebuild each)",
    { min: 3, max: 7, budgetMs: 60_000, warmup: 0 },
    () => install(baseTab(SORTED)),
    async () => {
      const names = Array.from({ length: 500 }, (_, i) => `new-file-${i}.txt`);
      usePanes.getState().applyWatchBatch("left", "t1", "W1", {
        event: "batch",
        upserted: names,
        removed: [],
        rescan: false,
      });
      for (let i = 0; i < 5; i++) await flush();
      if (cur().entries.length !== N + 500) throw new Error("watcher batch not applied");
    },
  );

  // F1/F2 — watcher removals (50 names) on a 100k listing.
  await bench(
    "watcher batch: remove 50 of 100k",
    "applyWatchBatch removals (old: filter on the Immer draft + full id Set + index rebuild)",
    { min: 5, max: 15 },
    () => install(baseTab(SORTED, { selection: { selected: new Set([SORTED[10].id]), anchor: null, lead: null } })),
    async () => {
      const names = SORTED.slice(1000, 1050).map((e) => e.name);
      usePanes.getState().applyWatchBatch("left", "t1", "W1", {
        event: "batch",
        upserted: [],
        removed: names,
        rescan: false,
      });
      for (let i = 0; i < 2; i++) await flush();
      if (cur().entries.length !== N - 50) throw new Error("removal not applied");
    },
  );

  // F2/F3 — setSort on 100k (warm: entry objects seen before).
  await bench(
    "setSort name asc/desc toggle on 100k",
    "store.setSort (old: draft + collator compare per comparison)",
    { min: 5, max: 11 },
    () => install(baseTab(SORTED)),
    () => usePanes.getState().setSort("left", "t1", "name"),
  );
  const BY_SIZE = sortEntries(BASE, { key: "size", dir: "asc" });
  await bench(
    "setSort size → name on 100k",
    "store.setSort name from size order (a full re-sort, not a reversal)",
    { min: 5, max: 11 },
    () => install(baseTab(BY_SIZE, { sort: { key: "size", dir: "asc" } })),
    () => usePanes.getState().setSort("left", "t1", "name"),
  );
  await bench(
    "setSort by size on 100k",
    "store.setSort size key (name tiebreak)",
    { min: 5, max: 11 },
    () => install(baseTab(SORTED)),
    () => usePanes.getState().setSort("left", "t1", "size"),
  );
  // F3 — cold sort of a fresh listing (commitIngest / finishHydration).
  await bench(
    "sortEntries 100k fresh listing (cold)",
    "sortEntries on never-seen entry objects (listing settle)",
    { min: 5, max: 11 },
    () => BASE.map((e) => ({ ...e })),
    (fresh) => sortEntries(fresh as Entry[], { key: "name", dir: "asc" }),
  );

  // F2 — navigate away (history snapshot) with 1,000 selected rows.
  const sel = new Set(SORTED.slice(5000, 6000).map((e) => e.id));
  await bench(
    "navigate away from 100k (snapshot, 1k selected)",
    "store.navigate: history snapshot + reset (old: snapshot over the Immer draft)",
    { min: 5, max: 15 },
    () => install(baseTab(SORTED, { selection: { selected: new Set(sel), anchor: null, lead: SORTED[5999].id } })),
    () => usePanes.getState().navigate("left", "t1", "/elsewhere"),
  );
  await bench(
    "refresh 100k (snapshot, 1k selected)",
    "store.refresh (old: two snapshots over the draft)",
    { min: 5, max: 15 },
    () => install(baseTab(SORTED, { selection: { selected: new Set(sel), anchor: null, lead: SORTED[5999].id } })),
    () => usePanes.getState().refresh("left", "t1"),
  );

  // F6 — moveLead key press (lead near the end; 50 presses per sample).
  await bench(
    "moveLead key press on 100k",
    "moveLeadBy(1) per ↓ press, lead at row 90k (old: visibleEntries + map + indexOf per press)",
    { min: 5, max: 15, per: 50 },
    () => {
      const lead = SORTED[90_000].id;
      install(baseTab(SORTED, { selection: { selected: new Set([lead]), anchor: lead, lead } }));
    },
    () => {
      for (let i = 0; i < 50; i++) moveLeadBy(1, false);
    },
  );

  // F6 — type-ahead keystroke through the real window listener.
  function Probe() {
    useKeyboard();
    return null;
  }
  render(createElement(Probe));
  await bench(
    "type-ahead keystroke on 100k",
    "window keydown → handleTypeAhead, prefix with no match (full scan; old: visibleEntries + map(name) + toLowerCase per name)",
    { min: 5, max: 15, per: 20 },
    () => install(baseTab(SORTED)),
    () => {
      for (let i = 0; i < 20; i++) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: i % 2 ? "z" : "q", bubbles: true }));
      }
    },
  );
  cleanup();

  // F4/F5 — per pane update (a selection change) computations.
  const selTab = (k: number) =>
    baseTab(SORTED, { selection: { selected: new Set(SORTED.slice(k, k + 200).map((e) => e.id)), anchor: null, lead: null } });
  await bench(
    "PaneFooter computation per pane update",
    "footer numbers after a selection change, 200 selected (old: visibleEntries + entries.filter(selected) unmemoized)",
    { min: 5, max: 21, per: 20 },
    () => Array.from({ length: 20 }, (_, i) => selTab(i * 10)),
    (tabs) => {
      for (const t of tabs as Tab[]) impl.footer(t);
    },
  );
  await bench(
    "Preview+GetInfo (closed) per pane update",
    "work done by the always-mounted closed overlays per pane update (old: 2× visibleEntries + selection filter; new: not subscribed)",
    { min: 5, max: 21, per: 20 },
    () => Array.from({ length: 20 }, (_, i) => selTab(i * 10)),
    (tabs) => {
      for (const t of tabs as Tab[]) impl.overlaysClosed(t);
    },
  );

  // Hydration commit + FileList visible memo (hidden rows filtered).
  const unhydrated = sortEntries(makeEntries(N, false), { key: "name", dir: "asc" });
  await bench(
    "hydration commit (128 rows) + visible memo on 100k",
    "applyListEvent hydrate + the FileList/GridView visible list recompute",
    { min: 5, max: 21, per: 10 },
    () => {
      install(baseTab(unhydrated, { listingId: "H1" }));
      impl.visibleMemo(cur());
      return null;
    },
    () => {
      for (let b = 0; b < 10; b++) {
        const start = 20_000 + b * 128;
        const patches = unhydrated
          .slice(start, start + 128)
          .map((e) => ({ ...e, hydrated: true, size: 1, mtime: 1 }));
        usePanes.getState().applyListEvent("left", "t1", "H1", { event: "hydrate", entries: patches });
        impl.visibleMemo(cur());
      }
    },
  );

  // F9 — hydration background queue drain (100k ids, batches of 128).
  const ids = BASE.map((e) => e.id);
  await bench(
    "hydration queue drain 100k ids",
    "take all batches of 128 (old: Array.shift per id)",
    { min: 3, max: 9, budgetMs: 60_000 },
    () => null,
    () => impl.drainQueue(ids),
  );

  // F12 — marquee over a 100k list.
  const ROW_H = 28;
  const WIDTH = 900;
  await bench(
    "marquee mousedown setup on 100k",
    "per-drag setup (old: one rect object per visible row)",
    { min: 5, max: 21 },
    () => install(baseTab(SORTED)),
    () => impl.marqueeSetup(cur().entries, ROW_H, WIDTH),
  );
  await bench(
    "marquee mousemove on 100k",
    "selection recompute per mousemove, 40-row marquee (old: scan all rects)",
    { min: 5, max: 21, per: 50 },
    () => {
      install(baseTab(SORTED));
      const visible = (impl.visibleMemo(cur()) as Entry[]);
      return impl.marqueeSetup(visible, ROW_H, WIDTH);
    },
    (state) => {
      for (let i = 0; i < 50; i++) {
        const rect = { x: 10, y: 40_000 * ROW_H + i * 3, width: 200, height: 40 * ROW_H };
        impl.marqueeMove(state, rect, ROW_H, WIDTH, cur());
      }
    },
  );

  // F7 — first produce() after a plain listing install.
  await bench(
    "first Immer update after installing a fresh 100k listing",
    "setSelection right after a plain commit of fresh entry objects (auto-freeze deep-walks them when on)",
    { min: 5, max: 15 },
    () => install(baseTab(SORTED.map((e) => ({ ...e })))),
    () => usePanes.getState().setSelection("left", "t1", { selected: new Set([1]), anchor: 1, lead: 1 }),
  );

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ impl: IMPL, engine: `node ${process.version} (V8)`, results }, null, 2));
});
