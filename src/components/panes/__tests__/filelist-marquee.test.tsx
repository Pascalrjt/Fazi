/**
 * Marquee selection: edge auto-scroll extends the selection past the
 * viewport, wheel-scrolling mid-drag recomputes it, and Escape cancels the
 * drag restoring the pre-drag selection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
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

import { FileList, rowHeight } from "../FileList";
import { usePanes } from "../../../stores/panes";

const ROW_H = rowHeight("normal"); // 28

function entry(id: number, name: string): Entry {
  return {
    id,
    name,
    path: `/m/${name}`,
    kind: "file",
    hidden: false,
    icon: "",
    ext: "",
    hydrated: true,
    size: null,
    mtime: null,
    btime: null,
    isPackage: false,
    isAlias: false,
    linkTarget: null,
    tags: [],
    noAccess: false,
  } as Entry;
}

const N = 30;
const ENTRIES = Array.from({ length: N }, (_, i) => entry(i + 1, `f${String(i).padStart(2, "0")}`));
const VIEW_H = 200;

function seed(): { paneId: "left"; tabId: string } {
  const s = usePanes.getState();
  const pane = s.panes[0];
  const tab = pane.tabs[0];
  usePanes.setState({
    panes: [
      {
        ...pane,
        activeTabId: tab.id,
        tabs: [
          {
            ...tab,
            path: "/m",
            entries: ENTRIES,
            loading: false,
            listed: true,
            selection: { selected: new Set<number>(), anchor: null, lead: null },
          },
        ],
      },
      ...s.panes.slice(1),
    ],
  });
  return { paneId: "left", tabId: tab.id };
}

function selectedIds(tabId: string): Set<number> {
  const t = usePanes.getState().panes[0].tabs.find((tt) => tt.id === tabId);
  return t ? t.selection.selected : new Set();
}

describe("marquee selection", () => {
  const rafCbs: FrameRequestCallback[] = [];

  beforeEach(() => {
    rafCbs.length = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCbs.push(cb);
      return rafCbs.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    fireEvent(window, new MouseEvent("mouseup", { bubbles: true })); // end any live drag
    cleanup();
    vi.unstubAllGlobals();
  });

  /** Run the next pending auto-scroll frame. */
  function runFrame() {
    const cb = rafCbs.shift();
    if (!cb) throw new Error("no pending animation frame");
    cb(0);
  }

  function renderList(): { tabId: string; el: HTMLElement } {
    const { paneId, tabId } = seed();
    const { container } = render(<FileList paneId={paneId} tabId={tabId} />);
    const el = container.querySelector(".overflow-auto") as HTMLElement;
    if (!el) throw new Error("scroll container not rendered");
    Object.defineProperty(el, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        right: 200,
        width: 200,
        top: 0,
        bottom: VIEW_H,
        height: VIEW_H,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: VIEW_H });
    Object.defineProperty(el, "clientWidth", { configurable: true, value: 200 });
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: N * ROW_H });
    return { tabId, el };
  }

  it("selects rows under the drag rectangle", () => {
    const { tabId, el } = renderList();
    fireEvent.mouseDown(el, { button: 0, clientX: 20, clientY: 10 });
    fireEvent(window, new MouseEvent("mousemove", { clientX: 100, clientY: 3 * ROW_H - 5 }));
    // Rows 0..2 intersect y 10..(3*28-5).
    expect([...selectedIds(tabId)].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("auto-scrolls at the bottom edge and extends the selection offscreen", () => {
    const { tabId, el } = renderList();
    fireEvent.mouseDown(el, { button: 0, clientX: 20, clientY: 10 });
    // Park the pointer inside the bottom edge band (past VIEW_H - 24).
    fireEvent(window, new MouseEvent("mousemove", { clientX: 100, clientY: VIEW_H - 4 }));
    const before = selectedIds(tabId).size;
    for (let i = 0; i < 40; i++) runFrame();
    expect(el.scrollTop).toBeGreaterThan(0);
    const after = selectedIds(tabId);
    expect(after.size).toBeGreaterThan(before);
    // A row that starts below the viewport is now selected.
    const offscreenRow = Math.ceil(VIEW_H / ROW_H) + 1;
    expect(after.has(offscreenRow + 1)).toBe(true);
  });

  it("wheel-scrolling mid-drag recomputes the selection", () => {
    const { tabId, el } = renderList();
    fireEvent.mouseDown(el, { button: 0, clientX: 20, clientY: 10 });
    fireEvent(window, new MouseEvent("mousemove", { clientX: 100, clientY: 100 }));
    const before = selectedIds(tabId).size;
    el.scrollTop = 3 * ROW_H; // stationary pointer, content moved under it
    fireEvent.scroll(el);
    expect(selectedIds(tabId).size).toBeGreaterThan(before);
  });

  it("Escape cancels the drag and restores the pre-drag selection", () => {
    const { tabId, el } = renderList();
    usePanes
      .getState()
      .setSelection("left", tabId, { selected: new Set([7]), anchor: null, lead: null });
    fireEvent.mouseDown(el, { button: 0, clientX: 20, clientY: 10 });
    fireEvent(window, new MouseEvent("mousemove", { clientX: 100, clientY: 100 }));
    expect(selectedIds(tabId).has(1)).toBe(true); // marquee replaced it
    fireEvent.keyDown(window, { key: "Escape" });
    expect([...selectedIds(tabId)]).toEqual([7]);
    // The drag is dead: further movement changes nothing.
    fireEvent(window, new MouseEvent("mousemove", { clientX: 150, clientY: 150 }));
    expect([...selectedIds(tabId)]).toEqual([7]);
  });
});
