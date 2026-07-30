import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "../../types/ipc";

let resolveStat: (entries: (Entry | null)[]) => void = () => {};

vi.mock("../../lib/ipc", () => ({
  listDir: () => Promise.resolve(),
  cancelListing: () => Promise.resolve(),
  watchDir: () => Promise.resolve(),
  unwatch: () => Promise.resolve(),
  statPaths: () =>
    new Promise((res) => {
      resolveStat = res;
    }),
}));

import { activeTabOf, usePanes } from "../panes";

function entry(id: number, name: string, patch: Partial<Entry> = {}): Entry {
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
    ...patch,
  };
}

/** Boot + settle a /dir listing with the given entries. */
function seed(entries: Entry[]): string {
  usePanes.getState().boot("/dir");
  const tab = activeTabOf(usePanes.getState().panes[0]);
  usePanes.getState().applyListEvent("left", tab.id, tab.listingId, {
    event: "chunk",
    entries,
  });
  usePanes.getState().applyListEvent("left", tab.id, tab.listingId, {
    event: "listed",
    total: entries.length,
  });
  return tab.id;
}

describe("upsertEntriesNow", () => {
  beforeEach(() => {
    seed([entry(1, "alpha"), entry(2, "beta"), entry(3, "gamma")]);
  });

  it("merges the whole batch: stable ids for updates, sorted-in new entries, ghosts cleared", () => {
    const tabId = usePanes.getState().panes[0].activeTabId;
    usePanes.getState().addGhosts("/dir", ["/dir/delta"]);
    usePanes.getState().setSelection("left", tabId, {
      selected: new Set([2]),
      anchor: 2,
      lead: 2,
    });

    const ids = usePanes.getState().upsertEntriesNow("left", tabId, [
      entry(101, "beta", { size: 99 }), // watcher re-stat of an existing row
      entry(102, "delta"), // pending ghost materializing
      entry(103, "aardvark"), // brand-new row, sorts first
    ]);
    expect(ids).toEqual([2, 102, 103]);

    const tab = activeTabOf(usePanes.getState().panes[0]);
    // one sort placed the new rows; updates stayed put
    expect(tab.entries.map((e) => e.name)).toEqual([
      "aardvark",
      "alpha",
      "beta",
      "delta",
      "gamma",
    ]);
    // updated row kept its store-assigned id but took the fresh stat
    const beta = tab.entries.find((e) => e.name === "beta");
    expect(beta?.id).toBe(2);
    expect(beta?.size).toBe(99);
    // ghost for the materialized name is gone
    expect(tab.ghosts).toEqual([]);
    expect(tab.total).toBe(5);
    // selection survives the batch untouched
    expect([...tab.selection.selected]).toEqual([2]);
    expect(tab.selection.anchor).toBe(2);
    expect(tab.selection.lead).toBe(2);
  });

  it("returns null when the tab is gone", () => {
    const ids = usePanes.getState().upsertEntriesNow("left", "no-such-tab", [entry(9, "x")]);
    expect(ids).toBeNull();
  });

  it("re-sorts on metadata-only updates when sorting by that field", () => {
    const tabId = usePanes.getState().panes[0].activeTabId;
    usePanes.getState().setSort("left", tabId, "size", "asc");
    // seed sizes are all 1; grow alpha past the others so size-sort must move it
    usePanes.getState().upsertEntriesNow("left", tabId, [entry(201, "alpha", { size: 500 })]);

    const tab = activeTabOf(usePanes.getState().panes[0]);
    expect(tab.entries.map((e) => e.name)).toEqual(["beta", "gamma", "alpha"]);
    // still the same stable row id
    expect(tab.entries.find((e) => e.name === "alpha")?.id).toBe(1);
  });
});

describe("applyWatchBatch stale stat guard", () => {
  it("drops stat results that resolve after the tab moved on", async () => {
    const tabId = seed([entry(1, "alpha")]);
    // the watch starts on the "done" event
    const seeded = activeTabOf(usePanes.getState().panes[0]);
    usePanes.getState().applyListEvent("left", tabId, seeded.listingId, { event: "done" });
    const tab = activeTabOf(usePanes.getState().panes[0]);
    expect(tab.watchId).toBeTruthy();

    usePanes.getState().applyWatchBatch("left", tabId, tab.watchId!, {
      event: "batch",
      rescan: false,
      upserted: ["intruder"],
      removed: [],
    });
    // the tab refreshes while the bulk stat is still in flight
    usePanes.getState().refresh("left", tabId);
    resolveStat([entry(999, "intruder")]);
    await Promise.resolve();
    await Promise.resolve();

    const after = activeTabOf(usePanes.getState().panes[0]);
    expect(after.entries.some((e) => e.name === "intruder")).toBe(false);
  });
});

describe("upsertEntryNow returned id", () => {
  beforeEach(() => {
    seed([entry(1, "alpha"), entry(2, "beta")]);
  });

  it("returns the existing row's stable id on update and the entry's own id when new", () => {
    const tabId = usePanes.getState().panes[0].activeTabId;
    expect(usePanes.getState().upsertEntryNow("left", tabId, entry(500, "Beta"))).toBe(2);
    expect(usePanes.getState().upsertEntryNow("left", tabId, entry(501, "zeta"))).toBe(501);
  });

  it("returns null when the tab is gone", () => {
    expect(usePanes.getState().upsertEntryNow("left", "no-such-tab", entry(9, "x"))).toBeNull();
  });
});
