/**
 * Sidebar favorites drag & drop — the two bug-prone handler-order contracts:
 * 1. favorite-reorder drags (FAZI_FAV_MIME) must bubble THROUGH SidebarRow
 *    (MIME checked before stopPropagation) and reach the section's reorder
 *    handler;
 * 2. file-path drops on a favorite row must stopPropagate and stay move-into
 *    (never a pin).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  downloadIcloud: () => Promise.resolve(),
  statPath: () => Promise.resolve(null),
  trashPaths: () => Promise.resolve(),
  eject: () => Promise.resolve(),
  revealInFinder: () => Promise.resolve(),
}));

import { Sidebar } from "../Sidebar";
import { FAZI_DND_MIME, FAZI_FAV_MIME } from "../../../lib/dnd";
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
  icloudDrive: null,
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
    icloud: "none",
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

  it("reorder drags bubble through SidebarRow to the section handler", () => {
    render(<Sidebar />);
    const rowB = screen.getByText("FavB");

    // dragOver a favorite ROW with the reorder MIME: the row must bail before
    // stopPropagation so the section computes an insertion index…
    fireEvent.dragOver(rowB, {
      dataTransfer: dt([FAZI_FAV_MIME], { [FAZI_FAV_MIME]: "/p/A" }),
    });
    // …and the drop (also on the row) must reach the section's moveFavorite.
    fireEvent.drop(rowB, {
      dataTransfer: dt([FAZI_FAV_MIME], { [FAZI_FAV_MIME]: "/p/A" }),
    });

    expect(useSettings.getState().favorites.map((f) => f.path)).toEqual(["/p/B", "/p/A"]);
    // A reorder is never a file move.
    expect(mocks.runOpCalls).toHaveLength(0);
    expect(useOps.getState().cards).toHaveLength(0);
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
    const s = usePanes.getState();
    usePanes.setState({
      panes: s.panes.map((pane, i) =>
        i === 0
          ? {
              ...pane,
              tabs: pane.tabs.map((tab, j) =>
                j === 0
                  ? {
                      ...tab,
                      entries: [
                        dirEntry(1, "Projects", "/files/Projects"),
                        { ...dirEntry(2, "notes.txt", "/files/notes.txt"), kind: "file" as const },
                      ],
                    }
                  : tab,
              ),
            }
          : pane,
      ),
    });

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
});
