/** Regression coverage for the 100k pass-1 ingestion path. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "../../types/ipc";

vi.mock("../../lib/ipc", () => ({
  listDir: () => Promise.resolve(),
  cancelListing: () => Promise.resolve(),
  watchDir: () => Promise.resolve(),
  unwatch: () => Promise.resolve(),
}));

import { activeTabOf, usePanes } from "../panes";

function entry(id: number): Entry {
  return {
    id,
    name: `file-${String(100_000 - id).padStart(6, "0")}.txt`,
    path: `/big/file-${id}.txt`,
    kind: "file",
    hidden: false,
    icon: `token-${id}`,
    ext: "txt",
    hydrated: false,
    size: null,
    mtime: null,
    btime: null,
    isPackage: false,
    isAlias: false,
    linkTarget: null,
    tags: [],
    noAccess: false,
  };
}

describe("large listing ingestion", () => {
  beforeEach(() => {
    usePanes.getState().boot("/big");
  });

  it("ingests and settles 100k rows without per-chunk Immer finalization", () => {
    const pane = usePanes.getState().panes[0];
    const tab = activeTabOf(pane);
    const started = performance.now();

    for (let chunk = 0; chunk < 100; chunk++) {
      const first = chunk * 1_000;
      const entries = Array.from({ length: 1_000 }, (_, offset) => entry(first + offset));
      usePanes
        .getState()
        .applyListEvent("left", tab.id, tab.listingId, { event: "chunk", entries });
      if (chunk === 0) {
        expect(activeTabOf(usePanes.getState().panes[0]).entries).toHaveLength(1_000);
      }
    }
    usePanes
      .getState()
      .applyListEvent("left", tab.id, tab.listingId, { event: "listed", total: 100_000 });

    const settled = activeTabOf(usePanes.getState().panes[0]);
    const elapsed = performance.now() - started;
    expect(settled.entries).toHaveLength(100_000);
    expect(settled.total).toBe(100_000);
    expect(settled.listed).toBe(true);
    expect(settled.sorting).toBe(false);
    expect(settled.entries[0].name).toBe("file-000001.txt");
    // This took over 50 seconds through Immer. Leave substantial CI headroom
    // while still protecting against the original pathological path.
    expect(elapsed).toBeLessThan(3_000);
  });
});
