/** Scroll offsets live outside the store (module Map) — cover the history
 *  snapshot/pendingRestore round trip and the close-tab cleanup. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry } from "../../types/ipc";

vi.mock("../../lib/ipc", () => ({
  listDir: () => Promise.resolve(),
  cancelListing: () => Promise.resolve(),
  watchDir: () => Promise.resolve(),
  unwatch: () => Promise.resolve(),
}));

import {
  activeTabOf,
  getTabScrollTop,
  hasTabScrollTop,
  setTabScrollTop,
  usePanes,
} from "../panes";

function entry(id: number, name: string, dir: string): Entry {
  return {
    id,
    name,
    path: `${dir}/${name}`,
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

/** Stream a chunk and settle the active tab's current listing. */
function settleListing(names: string[], dir: string): void {
  const tab = activeTabOf(usePanes.getState().panes[0]);
  usePanes.getState().applyListEvent("left", tab.id, tab.listingId, {
    event: "chunk",
    entries: names.map((name, i) => entry(i + 1, name, dir)),
  });
  usePanes.getState().applyListEvent("left", tab.id, tab.listingId, {
    event: "listed",
    total: names.length,
  });
}

describe("tab scroll offsets", () => {
  beforeEach(() => {
    usePanes.getState().boot("/dir");
  });

  it("restores the scroll position through history back", () => {
    const tab = activeTabOf(usePanes.getState().panes[0]);
    settleListing(["a.txt", "b.txt"], "/dir");
    setTabScrollTop(tab.id, 420);

    usePanes.getState().navigate("left", tab.id, "/dir/sub");
    // navigating to a new path starts at the top
    expect(getTabScrollTop(tab.id)).toBe(0);
    settleListing(["c.txt"], "/dir/sub");

    usePanes.getState().back("left", tab.id);
    // the restore lands only once the listing settles (pendingRestore path)
    expect(getTabScrollTop(tab.id)).toBe(0);
    settleListing(["a.txt", "b.txt"], "/dir");

    const restored = activeTabOf(usePanes.getState().panes[0]);
    expect(restored.path).toBe("/dir");
    expect(restored.listed).toBe(true);
    expect(restored.pendingRestore).toBeNull();
    expect(getTabScrollTop(tab.id)).toBe(420);
  });

  it("restores the scroll position through history forward", () => {
    const tab = activeTabOf(usePanes.getState().panes[0]);
    settleListing(["a.txt"], "/dir");

    usePanes.getState().navigate("left", tab.id, "/dir/sub");
    settleListing(["c.txt"], "/dir/sub");
    setTabScrollTop(tab.id, 99);

    usePanes.getState().back("left", tab.id);
    settleListing(["a.txt"], "/dir");
    usePanes.getState().forward("left", tab.id);
    settleListing(["c.txt"], "/dir/sub");

    expect(activeTabOf(usePanes.getState().panes[0]).path).toBe("/dir/sub");
    expect(getTabScrollTop(tab.id)).toBe(99);
  });

  it("drops a tab's entry when the tab closes", () => {
    usePanes.getState().openTab("left", "/other");
    const pane = usePanes.getState().panes[0];
    const opened = pane.tabs[pane.tabs.length - 1];
    setTabScrollTop(opened.id, 100);
    expect(hasTabScrollTop(opened.id)).toBe(true);

    usePanes.getState().closeTab("left", opened.id);
    expect(usePanes.getState().panes[0].tabs).toHaveLength(1);
    expect(hasTabScrollTop(opened.id)).toBe(false);
  });
});
