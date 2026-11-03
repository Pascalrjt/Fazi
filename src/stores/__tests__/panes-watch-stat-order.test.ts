/**
 * Watcher upserts: stat_paths runs on backend worker threads, so a newer
 * batch's stat can resolve before an older one. Results must still apply in
 * batch order — a growing file never ends up showing a stale size.
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

import { activeTabOf, usePanes } from "../panes";

function entry(id: number, name: string, size: number): Entry {
  return {
    id,
    name,
    path: `/dir/${name}`,
    kind: "file",
    hidden: false,
    icon: `token-${id}`,
    ext: "",
    hydrated: true,
    size,
    mtime: 1,
    btime: 1,
    isPackage: false,
    isAlias: false,
    linkTarget: null,
    tags: [],
    noAccess: false,
    customIcon: false,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const sizeOf = (name: string) =>
  activeTabOf(usePanes.getState().panes[0]).entries.find((e) => e.name === name)?.size;

describe("watcher stat ordering", () => {
  beforeEach(() => {
    mocks.stats.length = 0;
    usePanes.getState().boot("/dir");
    const tab = activeTabOf(usePanes.getState().panes[0]);
    usePanes.getState().applyListEvent("left", tab.id, tab.listingId, {
      event: "chunk",
      entries: [entry(1, "log.txt", 10)],
    });
    usePanes.getState().applyListEvent("left", tab.id, tab.listingId, { event: "listed", total: 1 });
  });

  function batch(): void {
    const tab = activeTabOf(usePanes.getState().panes[0]);
    usePanes.getState().applyWatchBatch("left", tab.id, tab.watchId as string, {
      event: "batch",
      upserted: ["log.txt"],
      removed: [],
      rescan: false,
    });
  }

  it("applies an older stat before a newer one, even when it resolves last", async () => {
    batch();
    batch();
    expect(mocks.stats).toHaveLength(2); // both requested immediately
    mocks.stats[1].resolve([entry(99, "log.txt", 300)]); // newer, resolves first
    await flush();
    expect(sizeOf("log.txt")).toBe(10); // held until the older one lands
    mocks.stats[0].resolve([entry(98, "log.txt", 200)]);
    await flush();
    expect(sizeOf("log.txt")).toBe(300);
  });

  it("a failed stat doesn't stall the batches after it", async () => {
    batch();
    batch();
    mocks.stats[0].resolve(Promise.reject(new Error("gone")) as never);
    mocks.stats[1].resolve([entry(99, "log.txt", 42)]);
    await flush();
    expect(sizeOf("log.txt")).toBe(42);
  });
});
