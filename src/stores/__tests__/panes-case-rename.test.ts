import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "../../types/ipc";

vi.mock("../../lib/ipc", () => ({
  listDir: () => Promise.resolve(),
  cancelListing: () => Promise.resolve(),
  watchDir: () => Promise.resolve(),
  unwatch: () => Promise.resolve(),
}));

import { activeTabOf, usePanes } from "../panes";

function entry(id: number, name: string): Entry {
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
  };
}

describe("case-only rename reconciliation", () => {
  beforeEach(() => {
    usePanes.getState().boot("/dir");
  });

  it("coalesces the watcher upsert and preserves the optimistic row id", () => {
    const tab = activeTabOf(usePanes.getState().panes[0]);
    usePanes.getState().applyListEvent("left", tab.id, tab.listingId, {
      event: "chunk",
      entries: [entry(1, "foo"), entry(2, "bar")],
    });
    usePanes.getState().applyListEvent("left", tab.id, tab.listingId, {
      event: "listed",
      total: 2,
    });

    usePanes.getState().renameLocal("left", tab.id, 1, "Foo", "/dir/Foo");
    usePanes.getState().upsertEntryNow("left", tab.id, entry(1 << 30, "Foo"));

    const settled = activeTabOf(usePanes.getState().panes[0]);
    expect(settled.entries.map((item) => item.name).sort()).toEqual(["Foo", "bar"]);
    expect(settled.entries.find((item) => item.name === "Foo")?.id).toBe(1);
    expect(settled.entries).toHaveLength(2);
    expect(settled.total).toBe(2);
  });
});
