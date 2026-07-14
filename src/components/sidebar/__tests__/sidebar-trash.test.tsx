/**
 * Sidebar Trash row: renders from DefaultFolders.trash, and a file-path drop
 * dispatches trash_paths (Finder Trash semantics) — never a generic move
 * into ~/.Trash.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  runOpCalls: [] as Array<{ kind: string; sources: string[]; destDir: string }>,
  trashPathsCalls: [] as string[][],
}));

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
  trashPaths: (paths: string[]) => {
    mocks.trashPathsCalls.push(paths);
    return Promise.resolve();
  },
  trashStats: () => Promise.resolve({ count: 0, externalCount: 0, unreadable: [] }),
  emptyTrash: () => Promise.resolve(),
  eject: () => Promise.resolve(),
  revealInFinder: () => Promise.resolve(),
}));

import { Sidebar } from "../Sidebar";
import { startPointerDrag } from "../../../lib/pointerDrag";
import { useVolumes } from "../../../stores/volumes";
import { useSettings } from "../../../stores/settings";
import { useOps } from "../../../stores/ops";

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

/** Dispatch a pointer event as a MouseEvent (jsdom lacks PointerEvent). */
function firePointer(target: Element | Window, type: "pointermove" | "pointerup", init: MouseEventInit) {
  fireEvent(target, new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
}

/** Give the row div a real rect (jsdom defaults to 0×0). */
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

describe("sidebar Trash row", () => {
  beforeEach(() => {
    mocks.runOpCalls.length = 0;
    mocks.trashPathsCalls.length = 0;
    useVolumes.setState({ folders: FOLDERS, volumes: [], loaded: true, error: null });
    useSettings.setState({ favorites: [] });
    useOps.setState({ cards: [], conflicts: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the Trash row from DefaultFolders.trash", () => {
    render(<Sidebar />);
    expect(screen.getByText("Trash")).toBeTruthy();
  });

  it("pointer-drag drop on the Trash row dispatches trash_paths, never a move", async () => {
    render(<Sidebar />);
    const row = screen.getByText("Trash").parentElement as HTMLElement;
    mockRect(row, 100, 128);

    startPointerDrag(["/files/doomed.txt", "/files/old"]);
    firePointer(window, "pointermove", { clientX: 50, clientY: 114 });
    firePointer(window, "pointerup", { clientX: 50, clientY: 114 });

    await waitFor(() => {
      expect(mocks.trashPathsCalls).toEqual([["/files/doomed.txt", "/files/old"]]);
    });
    // No copy/move op was started toward ~/.Trash.
    expect(mocks.runOpCalls).toHaveLength(0);
    expect(useOps.getState().cards).toHaveLength(0);
  });
});
