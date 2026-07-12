/**
 * Sidebar favorites drag & drop — the bug-prone contracts:
 * 1. pin reorder is POINTER-event based (HTML5 drop events never reach the
 *    DOM in the running app — wry swallows them on macOS): pointerdown +
 *    move past the threshold shows the insertion line, pointerup commits,
 *    Escape cancels, and the click after a reorder must not navigate;
 * 2. file-path drops on a favorite row's CENTER must stopPropagate and stay
 *    move-into (never a pin);
 * 3. file-path drops on a row's top/bottom edge band must bubble to the
 *    section and pin at the insertion slot (with the insertion line shown).
 *
 * jsdom rects are 0×0, which the row treats as center — edge-zone tests mock
 * getBoundingClientRect on the row divs and their [data-fav-index] wrappers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Entry } from "../../../types/ipc";

const mocks = vi.hoisted(() => ({
  runOpCalls: [] as Array<{ kind: string; sources: string[]; destDir: string }>,
}));

// Sidebar/ops import "lib/ipc" — same module id from this test dir.
vi.mock("../../../lib/ipc", () => ({
  runOp: (args: { kind: string; sources: string[]; destDir: string }) => {
    mocks.runOpCalls.push({ kind: args.kind, sources: args.sources, destDir: args.destDir });
    return Promise.resolve();
  },
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

import { Sidebar } from "../Sidebar";
import { FAZI_DND_MIME } from "../../../lib/dnd";
import { useSettings } from "../../../stores/settings";
import { useVolumes } from "../../../stores/volumes";
import { useOps } from "../../../stores/ops";
import { usePanes } from "../../../stores/panes";

const FOLDERS = {
  home: "/Users/me",
  desktop: "/Users/me/Desktop",
  documents: "/Users/me/Documents",
  downloads: "/Users/me/Downloads",
  pictures: "/Users/me/Pictures",
  music: "/Users/me/Music",
  movies: "/Users/me/Movies",
  applications: "/Applications",
  trash: "/Users/me/.Trash",
};

/** jsdom has no DataTransfer — a minimal stand-in for fireEvent. */
function dt(types: string[], data: Record<string, string>) {
  return {
    types,
    getData: (t: string) => data[t] ?? "",
    setData: () => {},
    dropEffect: "",
    effectAllowed: "",
  };
}

/** Dispatch a pointer event as a MouseEvent (jsdom lacks PointerEvent; the
 *  type string is what React's listeners and the window listeners match). */
function firePointer(
  target: Element | Window,
  type: "pointerdown" | "pointermove" | "pointerup",
  init: MouseEventInit,
) {
  fireEvent(target, new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
}

/** Fire a drag event carrying clientY — jsdom has no DragEvent, and RTL's
 *  fallback event drops coordinate init fields, so define them directly. */
function fireDragAt(
  el: Element,
  type: "dragOver" | "drop",
  clientY: number,
  dataTransfer: ReturnType<typeof dt>,
) {
  const event = createEvent[type](el);
  Object.defineProperty(event, "clientY", { value: clientY });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  fireEvent(el, event);
}

/** Give an element a real rect (jsdom defaults to 0×0). */
function mockRect(el: Element, top: number, bottom: number) {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      top,
      bottom,
      height: bottom - top,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }),
  });
}

/** Mock rects on a favorite row's div AND its [data-fav-index] wrapper. */
function mockRowRects(label: string, top: number, bottom: number): HTMLElement {
  const row = screen.getByText(label).parentElement as HTMLElement;
  mockRect(row, top, bottom);
  if (row.parentElement?.hasAttribute("data-fav-index")) {
    mockRect(row.parentElement, top, bottom);
  }
  return row;
}

/** Seed the first pane's first tab with entries so the pin resolver finds
 *  them without IPC. */
function seedListing(entries: Entry[]) {
  const s = usePanes.getState();
  usePanes.setState({
    panes: s.panes.map((pane, i) =>
      i === 0
        ? {
            ...pane,
            tabs: pane.tabs.map((tab, j) => (j === 0 ? { ...tab, entries } : tab)),
          }
        : pane,
    ),
  });
}

function dirEntry(id: number, name: string, path: string): Entry {
  return {
    id,
    name,
    path,
    kind: "dir",
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
  };
}

describe("sidebar favorites drag & drop", () => {
  beforeEach(() => {
    mocks.runOpCalls.length = 0;
    useVolumes.setState({ folders: FOLDERS, volumes: [], loaded: true, error: null });
    useSettings.setState({
      favorites: [
        { path: "/p/A", name: "FavA" },
        { path: "/p/B", name: "FavB" },
      ],
    });
    useOps.setState({ cards: [], conflicts: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it("pointer-drag on a pin shows the insertion line and reorders on pointerup", () => {
    render(<Sidebar />);
    mockRowRects("FavA", 100, 128);
    mockRowRects("FavB", 128, 156);
    const rowA = screen.getByText("FavA").parentElement as HTMLElement;

    firePointer(rowA, "pointerdown", { button: 0, clientX: 50, clientY: 110 });
    // Past the threshold and below FavB's midpoint (142) → insertion slot 2.
    firePointer(window, "pointermove", { clientX: 50, clientY: 150 });
    expect(screen.getByTestId("insertion-line")).toBeTruthy();
    firePointer(window, "pointerup", { clientX: 50, clientY: 150 });

    expect(useSettings.getState().favorites.map((f) => f.path)).toEqual(["/p/B", "/p/A"]);
    expect(screen.queryByTestId("insertion-line")).toBeNull();
    // A reorder is never a file move…
    expect(mocks.runOpCalls).toHaveLength(0);
    expect(useOps.getState().cards).toHaveLength(0);
    // …and the click that follows the reorder must not navigate.
    const tabPath = usePanes.getState().panes[0].tabs[0].path;
    fireEvent.click(rowA);
    expect(usePanes.getState().panes[0].tabs[0].path).toBe(tabPath);
  });

  it("Escape cancels a pointer reorder; a plain press stays a click", () => {
    render(<Sidebar />);
    mockRowRects("FavA", 100, 128);
    mockRowRects("FavB", 128, 156);
    const rowB = screen.getByText("FavB").parentElement as HTMLElement;

    firePointer(rowB, "pointerdown", { button: 0, clientX: 50, clientY: 140 });
    firePointer(window, "pointermove", { clientX: 50, clientY: 105 });
    expect(screen.getByTestId("insertion-line")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("insertion-line")).toBeNull();
    firePointer(window, "pointerup", { clientX: 50, clientY: 105 });
    expect(useSettings.getState().favorites.map((f) => f.path)).toEqual(["/p/A", "/p/B"]);

    // A press without movement past the threshold never starts a reorder.
    firePointer(rowB, "pointerdown", { button: 0, clientX: 50, clientY: 140 });
    firePointer(window, "pointermove", { clientX: 51, clientY: 141 });
    expect(screen.queryByTestId("insertion-line")).toBeNull();
    firePointer(window, "pointerup", { clientX: 51, clientY: 141 });
    expect(useSettings.getState().favorites.map((f) => f.path)).toEqual(["/p/A", "/p/B"]);
  });

  it("file-path drop on a favorite row stays move-into and never pins", () => {
    render(<Sidebar />);
    const rowA = screen.getByText("FavA");
    const payload = JSON.stringify(["/files/notes.txt"]);

    fireEvent.dragOver(rowA, {
      dataTransfer: dt([FAZI_DND_MIME], { [FAZI_DND_MIME]: payload }),
    });
    fireEvent.drop(rowA, {
      dataTransfer: dt([FAZI_DND_MIME], { [FAZI_DND_MIME]: payload }),
    });

    // Move-into the favorite folder…
    const cards = useOps.getState().cards;
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe("move");
    expect(cards[0].sources).toEqual(["/files/notes.txt"]);
    expect(cards[0].destDir).toBe("/p/A");
    // …and the bubbled pin handler never ran (stopPropagation regression).
    expect(useSettings.getState().favorites.map((f) => f.path)).toEqual(["/p/A", "/p/B"]);
  });

  it("file-path drop on section chrome pins folders (dirs only)", async () => {
    // Seed a listing so the pin resolver finds the entries without IPC.
    seedListing([
      dirEntry(1, "Projects", "/files/Projects"),
      { ...dirEntry(2, "notes.txt", "/files/notes.txt"), kind: "file" as const },
    ]);

    render(<Sidebar />);
    const label = screen.getByText("Favorites");
    const payload = JSON.stringify(["/files/Projects", "/files/notes.txt"]);
    fireEvent.drop(label, {
      dataTransfer: dt([FAZI_DND_MIME], { [FAZI_DND_MIME]: payload }),
    });

    await waitFor(() => {
      expect(useSettings.getState().favorites.map((f) => f.path)).toEqual([
        "/p/A",
        "/p/B",
        "/files/Projects", // the file was skipped, the dir was pinned
      ]);
    });
    expect(mocks.runOpCalls).toHaveLength(0);
  });

  // FavA row spans y 100–128, FavB y 128–156 in the edge-zone tests below;
  // edge bands are the top/bottom 7px (25%) of each 28px row.

  it("file-path drop on a row's edge band pins at that insertion slot", async () => {
    seedListing([dirEntry(1, "Projects", "/files/Projects")]);
    render(<Sidebar />);
    mockRowRects("FavA", 100, 128);
    const rowB = mockRowRects("FavB", 128, 156);
    const payload = JSON.stringify(["/files/Projects"]);

    // y=130 is inside FavB's top edge band → insertion between A and B.
    fireDragAt(rowB, "dragOver", 130, dt([FAZI_DND_MIME], { [FAZI_DND_MIME]: payload }));
    expect(screen.getByTestId("insertion-line")).toBeTruthy();
    fireDragAt(rowB, "drop", 130, dt([FAZI_DND_MIME], { [FAZI_DND_MIME]: payload }));

    await waitFor(() => {
      expect(useSettings.getState().favorites.map((f) => f.path)).toEqual([
        "/p/A",
        "/files/Projects",
        "/p/B",
      ]);
    });
    // An edge pin is never a file move.
    expect(mocks.runOpCalls).toHaveLength(0);
    expect(useOps.getState().cards).toHaveLength(0);
  });

  it("file-path drop on a row's center still moves into the folder", () => {
    render(<Sidebar />);
    const rowA = mockRowRects("FavA", 100, 128);
    mockRowRects("FavB", 128, 156);
    const payload = JSON.stringify(["/files/notes.txt"]);

    // y=114 is FavA's center band.
    fireDragAt(rowA, "dragOver", 114, dt([FAZI_DND_MIME], { [FAZI_DND_MIME]: payload }));
    fireDragAt(rowA, "drop", 114, dt([FAZI_DND_MIME], { [FAZI_DND_MIME]: payload }));

    const cards = useOps.getState().cards;
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe("move");
    expect(cards[0].destDir).toBe("/p/A");
    expect(useSettings.getState().favorites.map((f) => f.path)).toEqual(["/p/A", "/p/B"]);
  });

  it("edge drop over a default row pins at slot 0", async () => {
    seedListing([dirEntry(1, "Projects", "/files/Projects")]);
    render(<Sidebar />);
    // Documents sits above the pins; its edge band clamps to slot 0.
    const docs = mockRowRects("Documents", 40, 68);
    mockRowRects("FavA", 100, 128);
    mockRowRects("FavB", 128, 156);
    const payload = JSON.stringify(["/files/Projects"]);

    fireDragAt(docs, "dragOver", 42, dt([FAZI_DND_MIME], { [FAZI_DND_MIME]: payload }));
    fireDragAt(docs, "drop", 42, dt([FAZI_DND_MIME], { [FAZI_DND_MIME]: payload }));

    await waitFor(() => {
      expect(useSettings.getState().favorites.map((f) => f.path)).toEqual([
        "/files/Projects",
        "/p/A",
        "/p/B",
      ]);
    });
    expect(mocks.runOpCalls).toHaveLength(0);
  });

  it("hovering a row's center clears the insertion line from a prior edge hover", () => {
    render(<Sidebar />);
    const rowA = mockRowRects("FavA", 100, 128);
    mockRowRects("FavB", 128, 156);
    const payload = JSON.stringify(["/files/Projects"]);

    // edge band → line
    fireDragAt(rowA, "dragOver", 102, dt([FAZI_DND_MIME], { [FAZI_DND_MIME]: payload }));
    expect(screen.getByTestId("insertion-line")).toBeTruthy();
    // center → line must clear
    fireDragAt(rowA, "dragOver", 114, dt([FAZI_DND_MIME], { [FAZI_DND_MIME]: payload }));
    expect(screen.queryByTestId("insertion-line")).toBeNull();
  });
});
