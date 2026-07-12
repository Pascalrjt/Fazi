/**
 * FuzzyFinder key dispatch: Enter opens the selected hit; ⌘Enter reveals it
 * (navigate to parent + select) instead of opening.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  openPathsCalls: [] as string[][],
}));

vi.mock("../../../lib/ipc", () => ({
  openPaths: (paths: string[]) => {
    mocks.openPathsCalls.push(paths);
    return Promise.resolve();
  },
  fuzzyWarm: () =>
    Promise.resolve({ indexed: 1, indexing: false, capped: false, builtAtMs: 1 }),
  fuzzyQuery: () => Promise.resolve(),
  fuzzyCancel: () => Promise.resolve(),
  fuzzyDrop: () => Promise.resolve(),
  listDir: () => Promise.resolve(),
  cancelListing: () => Promise.resolve(),
  watchDir: () => Promise.resolve(),
  unwatch: () => Promise.resolve(),
}));

import { FuzzyFinder } from "../FuzzyFinder";
import { useFuzzy } from "../../../stores/fuzzy";
import { usePanes } from "../../../stores/panes";
import { useVolumes } from "../../../stores/volumes";

describe("FuzzyFinder key dispatch", () => {
  beforeEach(() => {
    mocks.openPathsCalls.length = 0;
    usePanes.getState().boot("/Users/me");
    useVolumes.setState({
      folders: {
        home: "/Users/me",
        desktop: "/Users/me/Desktop",
        documents: "/Users/me/Documents",
        downloads: "/Users/me/Downloads",
        pictures: "/Users/me/Pictures",
        music: "/Users/me/Music",
        movies: "/Users/me/Movies",
        applications: "/Applications",
        trash: "/Users/me/.Trash",
      },
      volumes: [],
      loaded: true,
      error: null,
    });
    useFuzzy.setState({
      open: true,
      scope: "folder",
      root: "/Users/me",
      query: "notes",
      hits: [
        { path: "/Users/me/docs/notes.md", name: "notes.md", isDir: false, icon: "t", score: 5 },
        { path: "/Users/me/notes2.md", name: "notes2.md", isDir: false, icon: "t", score: 4 },
      ],
      status: "done",
      indexed: 2,
      indexing: false,
      capped: false,
      builtAtMs: Date.now(),
      queryId: null,
      stale: false,
      error: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("Enter opens the selected hit and closes", () => {
    render(<FuzzyFinder />);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(mocks.openPathsCalls).toEqual([["/Users/me/docs/notes.md"]]);
    expect(useFuzzy.getState().open).toBe(false);
  });

  it("⌘Enter reveals: navigates to the parent with the hit selected", () => {
    render(<FuzzyFinder />);
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(mocks.openPathsCalls).toHaveLength(0);
    expect(useFuzzy.getState().open).toBe(false);
    const at = usePanes.getState().panes[0];
    const tab = at.tabs.find((t) => t.id === at.activeTabId) ?? at.tabs[0];
    expect(tab.path).toBe("/Users/me/docs");
  });

  it("ArrowDown moves the selection before Enter", () => {
    render(<FuzzyFinder />);
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(mocks.openPathsCalls).toEqual([["/Users/me/notes2.md"]]);
  });
});
