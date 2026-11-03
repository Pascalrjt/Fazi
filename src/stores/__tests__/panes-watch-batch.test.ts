/**
 * Watcher batches apply as ONE plain update: exact-name removals,
 * case-insensitive in-place replacements (row id kept), and new names merged
 * into sort order — in batch order, removals included.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "../../types/ipc";

const mocks = vi.hoisted(() => ({
  stats: [] as Array<{ paths: string[]; resolve(entries: Array<Entry | null>): void }>,
}));

vi.mock("../../lib/ipc", () => ({
  listDir: () => Promise.resolve(),
  cancelListing: () => Promise.resolve(),
  watchDir: () => Promise.resolve(),
  unwatch: () => Promise.resolve(),
  statPaths: (_owner: string, paths: string[]) =>
    new Promise<Array<Entry | null>>((resolve) => mocks.stats.push({ paths, resolve })),
}));

import { activeTabOf, applyWatchDelta, usePanes, type Tab } from "../panes";

function entry(id: number, name: string, extra: Partial<Entry> = {}): Entry {
  return {
    id,
    name,
    path: `/dir/${name}`,
    kind: "file",
    hidden: false,
    icon: `token-${id}`,
    ext: "",
    hydrated: true,
    size: 1,
    mtime: 1,
    btime: 1,
    isPackage: false,
    isAlias: false,
    linkTarget: null,
    tags: [],
    noAccess: false,
    customIcon: false,
    ...extra,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const tab = (): Tab => activeTabOf(usePanes.getState().panes[0]);
const names = () => tab().entries.map((e) => e.name);

function batch(upserted: string[], removed: string[]): void {
  const t = tab();
  usePanes.getState().applyWatchBatch("left", t.id, t.watchId as string, {
    event: "batch",
    upserted,
    removed,
    rescan: false,
  });
}

describe("batched watcher apply", () => {
  beforeEach(() => {
    mocks.stats.length = 0;
    usePanes.getState().boot("/dir");
    const t = tab();
    usePanes.getState().applyListEvent("left", t.id, t.listingId, {
      event: "chunk",
      entries: [entry(1, "b.txt"), entry(2, "Docs", { kind: "dir" }), entry(3, "file10"), entry(4, "file2")],
    });
    usePanes.getState().applyListEvent("left", t.id, t.listingId, { event: "listed", total: 4 });
    usePanes.getState().applyListEvent("left", t.id, t.listingId, { event: "done" });
  });

  it("starts sorted, dirs first, natural order", () => {
    expect(names()).toEqual(["Docs", "b.txt", "file2", "file10"]);
  });

  it("replaces case-insensitively in place, inserts in sort order, one commit", async () => {
    const t = tab();
    usePanes.getState().setSelection("left", t.id, { selected: new Set([1]), anchor: 1, lead: 1 });
    let commits = 0;
    const unsub = usePanes.subscribe(() => commits++);
    batch(["B.TXT", "file3", "a.md", "Alpha"], []);
    mocks.stats[0].resolve([
      entry(100, "B.TXT", { size: 99 }),
      entry(101, "file3"),
      entry(102, "a.md"),
      entry(103, "Alpha", { kind: "dir" }),
    ]);
    await flush();
    unsub();
    expect(commits).toBe(1);
    expect(names()).toEqual(["Alpha", "Docs", "a.md", "B.TXT", "file2", "file3", "file10"]);
    const replaced = tab().entries.find((e) => e.name === "B.TXT");
    expect(replaced?.id).toBe(1); // id kept → selection survives
    expect(replaced?.size).toBe(99);
    expect(tab().selection.selected.has(1)).toBe(true);
    expect(tab().total).toBe(7);
  });

  it("removes by exact name only and prunes the selection", () => {
    const t = tab();
    usePanes.getState().setSelection("left", t.id, { selected: new Set([3, 4]), anchor: 3, lead: 4 });
    batch([], ["file2", "B.TXT"]); // B.TXT ≠ b.txt for removals
    expect(names()).toEqual(["Docs", "b.txt", "file10"]); // applied synchronously
    expect(tab().total).toBe(3);
    expect([...tab().selection.selected]).toEqual([3]);
    expect(tab().selection.lead).toBeNull();
  });

  it("a removal waits behind an earlier batch's upsert of the same name", async () => {
    batch(["new.txt"], []);
    batch([], ["new.txt"]); // queued: the stat above hasn't landed yet
    expect(names()).not.toContain("new.txt");
    mocks.stats[0].resolve([entry(50, "new.txt")]);
    await flush();
    expect(names()).not.toContain("new.txt");
    expect(tab().total).toBe(4);
  });

  it("removal + upsert of one batch land together", async () => {
    batch(["c.txt"], ["b.txt"]);
    expect(names()).toContain("b.txt"); // not yet: same commit as the upsert
    mocks.stats[0].resolve([entry(60, "c.txt")]);
    await flush();
    expect(names()).toEqual(["Docs", "c.txt", "file2", "file10"]);
  });

  it("applyWatchDelta dedupes repeated new names and returns the same tab when idle", () => {
    const t = tab();
    expect(applyWatchDelta(t, [], [])).toBe(t);
    expect(applyWatchDelta(t, ["missing"], [])).toBe(t);
    const next = applyWatchDelta(t, [], [entry(70, "zz"), entry(71, "ZZ", { size: 5 })]);
    const zz = next.entries.filter((e) => e.name.toLowerCase() === "zz");
    expect(zz).toHaveLength(1);
    expect(zz[0].id).toBe(70);
    expect(zz[0].size).toBe(5);
    expect(next.total).toBe(5);
  });

  it("many new rows fall back to one full sort with the same result", () => {
    const t = tab();
    const adds = Array.from({ length: 50 }, (_, i) => entry(200 + i, `n${49 - i}`));
    const next = applyWatchDelta(t, [], adds);
    const ns = next.entries.map((e) => e.name);
    expect(ns.slice(0, 2)).toEqual(["Docs", "b.txt"]);
    expect(ns.indexOf("n2")).toBeLessThan(ns.indexOf("n10"));
    expect(ns).toHaveLength(54);
  });
});
