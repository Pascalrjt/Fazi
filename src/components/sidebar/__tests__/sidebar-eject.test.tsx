/**
 * Sidebar volume rows while ejecting: a spinner replaces the free-space
 * label and the eject button, and the context-menu item is disabled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ ejects: [] as string[] }));

vi.mock("../../../lib/ipc", () => ({
  statPath: () => Promise.resolve(null),
  trashStats: () => Promise.resolve({ count: 0, externalCount: 0, unreadable: [] }),
  eject: (path: string) => {
    mocks.ejects.push(path);
    return new Promise(() => {}); // stays in flight
  },
}));

import { Sidebar } from "../Sidebar";
import { useVolumes } from "../../../stores/volumes";
import { useSettings } from "../../../stores/settings";
import { useOps } from "../../../stores/ops";
import { useMenu } from "../../../stores/menu";

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

const USB = {
  name: "USB",
  path: "/Volumes/USB",
  isRemovable: true,
  isEjectable: true,
  isRoot: false,
  totalBytes: 8e9,
  availableBytes: 4e9,
};

describe("sidebar volume eject", () => {
  beforeEach(() => {
    mocks.ejects.length = 0;
    useVolumes.setState({ folders: FOLDERS, volumes: [USB], loaded: true, error: null, ejecting: [] });
    useSettings.setState({ favorites: [], vimMode: false, sidebarCollapsed: false });
    useOps.setState({ cards: [], conflicts: [] });
    useMenu.getState().close();
  });

  afterEach(() => {
    cleanup();
  });

  it("clicking eject swaps the button for a spinner until the eject settles", () => {
    render(<Sidebar />);
    expect(screen.queryByRole("status", { name: "Ejecting USB" })).toBeNull();
    fireEvent.click(screen.getByTitle("Eject USB"));
    expect(mocks.ejects).toEqual(["/Volumes/USB"]);
    expect(screen.getByRole("status", { name: "Ejecting USB" })).toBeTruthy();
    expect(screen.queryByTitle("Eject USB")).toBeNull();
  });

  it("the context-menu item is disabled while ejecting", () => {
    useVolumes.setState({ ejecting: ["/Volumes/USB"] });
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByText("USB"));
    const items = useMenu.getState().open?.items ?? [];
    const item = items.find(
      (i) => i.type === "item" && i.label.startsWith("Ejecting “USB”"),
    ) as { disabled?: boolean } | undefined;
    expect(item?.disabled).toBe(true);
  });
});
