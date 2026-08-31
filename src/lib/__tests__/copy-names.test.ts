/** Copy Name / Copy as Pathname: one line per selected entry, folder fallback. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "../../types/ipc";

const mocks = vi.hoisted(() => ({ written: [] as string[] }));

vi.mock("../ipc", () => ({
  pbWriteText: (text: string) => {
    mocks.written.push(text);
    return Promise.resolve();
  },
  listDir: () => Promise.resolve(),
  cancelListing: () => Promise.resolve(),
  watchDir: () => Promise.resolve(),
  unwatch: () => Promise.resolve(),
}));

import { copyNames, copyPathnames } from "../actions";
import { activeTabOf, usePanes } from "../../stores/panes";

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

function seed(selected: number[]) {
  usePanes.getState().boot("/dir");
  const tab = activeTabOf(usePanes.getState().panes[0]);
  usePanes.getState().applyListEvent("left", tab.id, tab.listingId, {
    event: "chunk",
    entries: [entry(1, "a.txt"), entry(2, "b.md"), entry(3, "c")],
  });
  usePanes.getState().applyListEvent("left", tab.id, tab.listingId, { event: "listed", total: 3 });
  usePanes.getState().setSelection("left", tab.id, {
    selected: new Set(selected),
    anchor: selected[0] ?? null,
    lead: selected[0] ?? null,
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("copyNames", () => {
  beforeEach(() => {
    mocks.written.length = 0;
  });

  it("copies a single selected name", async () => {
    seed([2]);
    copyNames();
    await flush();
    expect(mocks.written).toEqual(["b.md"]);
  });

  it("copies multiple selected names one per line", async () => {
    seed([1, 3]);
    copyNames();
    await flush();
    expect(mocks.written).toEqual(["a.txt\nc"]);
  });

  it("falls back to the current folder name when nothing is selected", async () => {
    seed([]);
    copyNames();
    await flush();
    expect(mocks.written).toEqual(["dir"]);
  });

  it("copyPathnames still copies full paths", async () => {
    seed([1, 2]);
    copyPathnames();
    await flush();
    expect(mocks.written).toEqual(["/dir/a.txt\n/dir/b.md"]);
  });
});
