/**
 * Shared hydration scheduler: viewport preempts the background trickle, at
 * most one request per lane in flight, batches ≤128, dedupe by id, and the
 * whole queue drops on listing change.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "../../types/ipc";

const mocks = vi.hoisted(() => ({
  calls: [] as Array<{ listingId: string; ids: number[] }>,
  resolvers: [] as Array<(v: (Entry | null)[]) => void>,
}));

vi.mock("../ipc", () => ({
  hydratePaths: (listingId: string, items: Array<{ id: number; path: string; icon: string }>) => {
    mocks.calls.push({ listingId, ids: items.map((i) => i.id) });
    return new Promise<(Entry | null)[]>((resolve) => {
      mocks.resolvers.push(resolve);
    });
  },
  listDir: () => Promise.resolve(),
  cancelListing: () => Promise.resolve(),
  watchDir: () => Promise.resolve(),
  unwatch: () => Promise.resolve(),
}));

import {
  dropHydrator,
  hydratorPending,
  initHydrator,
  requestViewportHydration,
} from "../hydration";
import { usePanes } from "../../stores/panes";

function entry(id: number, hydrated = false): Entry {
  return {
    id,
    name: `f${id}.txt`,
    path: `/dir/f${id}.txt`,
    kind: "file",
    hidden: false,
    icon: `tok${id}`,
    ext: "txt",
    hydrated,
    size: hydrated ? 1 : null,
    mtime: null,
    btime: null,
    isPackage: false,
    isAlias: false,
    linkTarget: null,
    tags: [],
    noAccess: false,
  };
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("hydration scheduler", () => {
  beforeEach(() => {
    mocks.calls.length = 0;
    mocks.resolvers.length = 0;
    dropHydrator();
    usePanes.getState().boot("/dir");
  });

  it("background trickle starts on init, viewport requests preempt", async () => {
    const entries = Array.from({ length: 300 }, (_, i) => entry(i));
    initHydrator("left", "t1", "L1", entries);
    // One background batch of ≤128 goes out immediately, nothing more.
    expect(mocks.calls).toHaveLength(1);
    expect(mocks.calls[0].ids).toHaveLength(128);
    expect(mocks.calls[0].ids[0]).toBe(0);

    // Viewport request while background is in flight → its own lane fires.
    requestViewportHydration("L1", [250, 251, 252]);
    expect(mocks.calls).toHaveLength(2);
    expect(mocks.calls[1].ids).toEqual([250, 251, 252]);

    // Another viewport request queues (1 in flight per lane max).
    requestViewportHydration("L1", [260]);
    expect(mocks.calls).toHaveLength(2);

    // Resolving the viewport request pumps the queued viewport work first.
    mocks.resolvers[1]([]);
    await tick();
    expect(mocks.calls).toHaveLength(3);
    expect(mocks.calls[2].ids).toEqual([260]);
  });

  it("dedupes by id: hydrated/unknown/duplicate ids never re-request", () => {
    const entries = [entry(1), entry(2, true), entry(3)];
    initHydrator("left", "t1", "L2", entries);
    expect(mocks.calls[0].ids).toEqual([1, 3]); // 2 was already hydrated

    // 1 is in flight but still pending in itemsById → a viewport request for
    // it is allowed to queue only once; 999 is unknown; 2 was hydrated.
    requestViewportHydration("L2", [1, 1, 2, 999]);
    requestViewportHydration("L2", [1]);
    expect(mocks.calls).toHaveLength(2);
    expect(mocks.calls[1].ids).toEqual([1]);
  });

  it("listing change drops the queue and stale responses are discarded", async () => {
    initHydrator("left", "t1", "L3", [entry(1), entry(2)]);
    expect(mocks.calls).toHaveLength(1);
    const resolve = mocks.resolvers[0];

    // Navigation: new listing replaces the scheduler.
    dropHydrator("L3");
    expect(hydratorPending()).toBe(0);
    requestViewportHydration("L3", [2]);
    expect(mocks.calls).toHaveLength(1); // nothing new — queue is gone

    // The in-flight response for the dead listing resolves without effect.
    resolve([{ ...entry(1, true) }]);
    await tick();
    expect(mocks.calls).toHaveLength(1);
  });
});
