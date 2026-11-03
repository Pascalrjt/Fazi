/**
 * Volume unmounted: every tab on it — including tabs deep in subfolders,
 * whose watchers FSEvents never tells about the unmount — walks up to the
 * nearest surviving ancestor. A user-initiated eject needs no extra notice;
 * an unexpected disappearance gets one per tab.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Volume } from "../../types/ipc";

const mocks = vi.hoisted(() => ({ existing: new Set<string>() }));

vi.mock("../../lib/ipc", () => ({
  statPath: (p: string) => Promise.resolve(mocks.existing.has(p) ? { path: p } : null),
  listDir: () => Promise.resolve(),
  cancelListing: () => Promise.resolve(),
  watchDir: () => Promise.resolve(),
  unwatch: () => Promise.resolve(),
}));

import { usePanes } from "../panes";
import { useVolumes } from "../volumes";
import { useApp } from "../app";

function vol(name: string, path: string): Volume {
  return {
    name,
    path,
    isRemovable: true,
    isEjectable: true,
    isRoot: false,
    totalBytes: null,
    availableBytes: null,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const paths = () => usePanes.getState().panes[0].tabs.map((t) => t.path);
const messages = () => useApp.getState().toasts.map((t) => t.message);

describe("volume disappears from the mounted list", () => {
  beforeEach(() => {
    mocks.existing = new Set(["/Volumes", "/Users/me"]);
    useApp.setState({ toasts: [] });
    useVolumes.setState({
      volumes: [vol("USB", "/Volumes/USB"), vol("USB 2", "/Volumes/USB 2")],
      loaded: true,
      ejecting: [],
    });
    usePanes.getState().boot("/Volumes/USB/Holiday/2026");
    usePanes.getState().openTab("left", "/Volumes/USB");
    usePanes.getState().openTab("left", "/Volumes/USB 2/Docs");
    usePanes.getState().openTab("left", "/Users/me");
  });

  it("walks every tab on it up to a surviving ancestor, leaving others alone", async () => {
    useVolumes.setState({ volumes: [vol("USB 2", "/Volumes/USB 2")] });
    await settle();
    expect(paths()).toEqual(["/Volumes", "/Volumes", "/Volumes/USB 2/Docs", "/Users/me"]);
    expect(messages()).toEqual(["“2026” is no longer available", "“USB” is no longer available"]);
  });

  it("stays quiet about tabs on a volume the user is ejecting", async () => {
    useVolumes.setState({ ejecting: ["/Volumes/USB"] });
    useVolumes.setState({ volumes: [vol("USB 2", "/Volumes/USB 2")] });
    await settle();
    expect(paths()).toEqual(["/Volumes", "/Volumes", "/Volumes/USB 2/Docs", "/Users/me"]);
    expect(messages()).toEqual([]);
  });

  it("a watcher rootGone for the same tab doesn't recover it twice", async () => {
    const pane = usePanes.getState().panes[0];
    const rootTab = pane.tabs[1];
    usePanes.getState().applyWatchBatch("left", rootTab.id, rootTab.watchId as string, {
      event: "rootGone",
    });
    useVolumes.setState({ volumes: [vol("USB 2", "/Volumes/USB 2")] });
    await settle();
    expect(paths()[1]).toBe("/Volumes");
    expect(messages().filter((m) => m === "“USB” is no longer available")).toHaveLength(1);
  });
});
