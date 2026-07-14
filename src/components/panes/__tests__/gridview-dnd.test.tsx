/**
 * Grid native drop zone: dir cells resolve as individual copyTo targets with
 * spring specs, files and whitespace fall back to the tab dir, and dragged
 * items are refused as their own targets. The cell arithmetic must mirror
 * the layout: rows of `columns` cells inside the p-2 (8px) padded container.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { Entry } from "../../../types/ipc";

vi.mock("../../../lib/ipc", () => ({
  runOp: () => Promise.resolve(),
  duplicatePaths: () => Promise.resolve(),
  compressPaths: () => Promise.resolve(),
  extractPaths: () => Promise.resolve(),
  cancelOp: () => Promise.resolve(),
  respondConflict: () => Promise.resolve(),
  undoLast: () => Promise.resolve(null),
  redoLast: () => Promise.resolve(null),
  statPath: () => Promise.resolve(null),
  trashPaths: () => Promise.resolve(),
  eject: () => Promise.resolve(),
  revealInFinder: () => Promise.resolve(),
}));

import { GridView } from "../GridView";
import {
  beginNativeDragState,
  endNativeDragState,
  hitTestDropZones,
  type DropHit,
} from "../../../lib/dnd";
import { usePanes } from "../../../stores/panes";

function entry(id: number, name: string, kind: "dir" | "file", isPackage = false): Entry {
  return {
    id,
    name,
    path: `/g/${name}`,
    kind,
    hidden: false,
    icon: "",
    ext: "",
    hydrated: true,
    size: null,
    mtime: null,
    btime: null,
    isPackage,
    isAlias: false,
    linkTarget: null,
    tags: [],
    noAccess: false,
  } as Entry;
}

// 2 columns × CELL 112: row 0 = [DirA, file1], row 1 = [DirB, PkgC].
const ENTRIES = [
  entry(1, "DirA", "dir"),
  entry(2, "file1", "file"),
  entry(3, "DirB", "dir"),
  entry(4, "PkgC", "dir", true),
];

const PAD = 8;
const CELL = 112;

function seed(): { paneId: "left"; tabId: string } {
  const s = usePanes.getState();
  const pane = s.panes[0];
  const tab = pane.tabs[0];
  usePanes.setState({
    panes: [
      {
        ...pane,
        activeTabId: tab.id,
        tabs: [{ ...tab, path: "/g", entries: ENTRIES, loading: false, listed: true }],
      },
      ...s.panes.slice(1),
    ],
  });
  return { paneId: "left", tabId: tab.id };
}

/** The grid scroll container, given a real rect, width, and scrollTop. */
function mockScroller(container: HTMLElement, scrollTop: number) {
  const el = container.firstElementChild as HTMLElement;
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: 0,
      right: 240,
      width: 240,
      top: 0,
      bottom: 300,
      height: 300,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: 240 }); // 2 columns
  Object.defineProperty(el, "scrollTop", { configurable: true, value: scrollTop, writable: true });
}

describe("grid drop zone", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    endNativeDragState();
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderGrid(scrollTop = 0) {
    const { paneId, tabId } = seed();
    const { container } = render(<GridView paneId={paneId} tabId={tabId} />);
    mockScroller(container, scrollTop);
  }

  function hitAtCell(col: number, row: number, scrolled = 0): DropHit | null {
    // Center of the cell, in client coords with the given scroll applied.
    const x = PAD + col * CELL + CELL / 2;
    const y = PAD + row * CELL + CELL / 2 - scrolled;
    return hitTestDropZones(x, y);
  }

  it("a dir cell resolves to that dir with a spring; a package cell does not", () => {
    renderGrid();
    const hit = hitAtCell(0, 0);
    expect(hit?.action).toBe("copyTo");
    if (hit?.action !== "copyTo") throw new Error("expected copyTo");
    expect(hit.destDir).toBe("/g/DirA");
    expect(hit.spring?.key).toBe(hit.targetKey);
    // Package dirs are files for DnD purposes → background.
    expect(hitAtCell(1, 1)).toEqual({ action: "copyTo", destDir: "/g" });
  });

  it("file cells and whitespace fall back to the tab dir without a spring", () => {
    renderGrid();
    expect(hitAtCell(1, 0)).toEqual({ action: "copyTo", destDir: "/g" }); // file1
    expect(hitAtCell(0, 2)).toEqual({ action: "copyTo", destDir: "/g" }); // below last row
    expect(hitTestDropZones(3, 150)).toEqual({ action: "copyTo", destDir: "/g" }); // left padding
  });

  it("scrollTop shifts the cell arithmetic", () => {
    renderGrid(CELL); // scrolled one row down
    const hit = hitAtCell(0, 1, CELL); // client point where row 1 now sits
    if (hit?.action !== "copyTo") throw new Error("expected copyTo");
    expect(hit.destDir).toBe("/g/DirB");
  });

  it("refuses the dragged dir itself and its parent as targets", () => {
    renderGrid();
    beginNativeDragState(["/g/DirA"], false);
    // Its own cell → invalid → background (which dispatch no-ops on same dir).
    expect(hitAtCell(0, 0)).toEqual({ action: "copyTo", destDir: "/g" });
    // Another dir is still a valid target.
    const hit = hitAtCell(0, 1);
    if (hit?.action !== "copyTo") throw new Error("expected copyTo");
    expect(hit.destDir).toBe("/g/DirB");
  });
});
