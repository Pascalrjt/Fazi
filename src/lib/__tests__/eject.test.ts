/**
 * Eject flow: one eject per volume at a time, refused up front while a
 * file operation touches the volume, an "Ejecting…" toast only for slow
 * ejects, the backend's reason passed through on failure, and component-wise
 * volume matching for "Eject Volume" on the active tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Volume } from "../../types/ipc";

type Deferred = { resolve(): void; reject(err: unknown): void };

const mocks = vi.hoisted(() => ({
  ejects: [] as Array<{ path: string } & Deferred>,
}));

vi.mock("../ipc", () => ({
  eject: (path: string) =>
    new Promise<void>((resolve, reject) => {
      mocks.ejects.push({ path, resolve, reject });
    }),
  listDir: () => Promise.resolve(),
  cancelListing: () => Promise.resolve(),
  watchDir: () => Promise.resolve(),
  unwatch: () => Promise.resolve(),
}));

import { EJECT_PROGRESS_DELAY_MS, ejectActiveVolume, ejectVolume, isWithin } from "../actions";
import { useApp } from "../../stores/app";
import { ejectedByUser, useVolumes } from "../../stores/volumes";
import { useOps, type OpCard } from "../../stores/ops";
import { useDirSizes } from "../../stores/dirSizes";
import { usePanes } from "../../stores/panes";

function vol(name: string, path: string, isEjectable = true): Volume {
  return {
    name,
    path,
    isRemovable: true,
    isEjectable,
    isRoot: false,
    totalBytes: null,
    availableBytes: null,
  };
}

const messages = () => useApp.getState().toasts.map((t) => t.message);
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("ejectVolume", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.ejects.length = 0;
    useApp.setState({ toasts: [] });
    useVolumes.setState({ volumes: [], ejecting: [] });
    useOps.setState({ cards: [] });
    useDirSizes.getState().clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks the volume ejecting, ignores repeat clicks, and clears on success", async () => {
    ejectVolume("/Volumes/USB", "USB");
    ejectVolume("/Volumes/USB", "USB");
    expect(mocks.ejects.map((e) => e.path)).toEqual(["/Volumes/USB"]);
    expect(useVolumes.getState().ejecting).toEqual(["/Volumes/USB"]);

    mocks.ejects[0].resolve();
    await settle();
    expect(useVolumes.getState().ejecting).toEqual([]);
    expect(messages()).toEqual(["Ejected “USB”"]);
  });

  it("tabs on an ejecting or just-ejected volume need no vanished notice", async () => {
    expect(ejectedByUser("/Volumes/SD/photos")).toBe(false);
    ejectVolume("/Volumes/SD", "SD");
    expect(ejectedByUser("/Volumes/SD/photos")).toBe(true);
    expect(ejectedByUser("/Volumes/SD 2/photos")).toBe(false);
    mocks.ejects[0].resolve();
    await settle();
    expect(useVolumes.getState().ejecting).toEqual([]);
    expect(ejectedByUser("/Volumes/SD")).toBe(true); // the watcher can trail the eject
    vi.advanceTimersByTime(5_001);
    expect(ejectedByUser("/Volumes/SD")).toBe(false);
  });

  it("a failed eject leaves the vanished notice armed", async () => {
    ejectVolume("/Volumes/CAM", "CAM");
    mocks.ejects[0].reject("it's in use by another app");
    await settle();
    expect(ejectedByUser("/Volumes/CAM/DCIM")).toBe(false);
  });

  it("a fast eject shows no progress toast", async () => {
    ejectVolume("/Volumes/USB", "USB");
    vi.advanceTimersByTime(EJECT_PROGRESS_DELAY_MS - 100);
    mocks.ejects[0].resolve();
    await settle();
    vi.advanceTimersByTime(5_000);
    expect(messages()).not.toContain("Ejecting “USB”…");
  });

  it("a slow eject shows “Ejecting…” and replaces it with the reason on failure", async () => {
    ejectVolume("/Volumes/USB", "USB");
    vi.advanceTimersByTime(EJECT_PROGRESS_DELAY_MS + 1);
    expect(messages()).toEqual(["Ejecting “USB”…"]);

    mocks.ejects[0].reject("“Python” is using it (pid 87855)");
    await settle();
    expect(messages()).toEqual(["Couldn't eject “USB”: “Python” is using it (pid 87855)"]);
    expect(useApp.getState().toasts[0].danger).toBe(true);
    expect(useVolumes.getState().ejecting).toEqual([]);

    // Retry after a failure is allowed.
    ejectVolume("/Volumes/USB", "USB");
    expect(mocks.ejects).toHaveLength(2);
  });

  it("a slow eject swaps “Ejecting…” for “Ejected” on success", async () => {
    ejectVolume("/Volumes/CARD", "CARD");
    vi.advanceTimersByTime(EJECT_PROGRESS_DELAY_MS + 1);
    expect(messages()).toEqual(["Ejecting “CARD”…"]);
    mocks.ejects[0].resolve();
    await settle();
    expect(messages()).toEqual(["Ejected “CARD”"]);
  });

  it("refuses while a file operation touches the volume", () => {
    useOps.setState({
      cards: [
        { status: "running", sources: ["/Users/me/big.mov"], destDir: "/Volumes/USB/Movies" },
      ] as OpCard[],
    });
    ejectVolume("/Volumes/USB", "USB");
    expect(mocks.ejects).toEqual([]);
    expect(messages()).toEqual([
      "Couldn't eject “USB”: wait for the running file operation to finish",
    ]);
    expect(useVolumes.getState().ejecting).toEqual([]);
  });

  it("finished operations and other volumes don't block", () => {
    useOps.setState({
      cards: [
        { status: "done", sources: ["/Volumes/USB/a"], destDir: "/Users/me" },
        { status: "running", sources: ["/Volumes/USB 2/a"], destDir: "/Users/me" },
      ] as OpCard[],
    });
    ejectVolume("/Volumes/USB", "USB");
    expect(mocks.ejects.map((e) => e.path)).toEqual(["/Volumes/USB"]);
  });

  it("drops cached folder sizes on the volume before ejecting", () => {
    useDirSizes.setState({
      sizes: {
        "/Volumes/USB/a": { bytes: 1, computing: false, at: Date.now() },
        "/Users/me/b": { bytes: 2, computing: false, at: Date.now() },
      },
    });
    ejectVolume("/Volumes/USB", "USB");
    expect(Object.keys(useDirSizes.getState().sizes)).toEqual(["/Users/me/b"]);
  });
});

describe("ejectActiveVolume", () => {
  beforeEach(() => {
    mocks.ejects.length = 0;
    useApp.setState({ toasts: [] });
    useOps.setState({ cards: [] });
    useVolumes.setState({ ejecting: [] });
  });

  it("picks the volume the tab is on, not a prefix-alike sibling", () => {
    useVolumes.setState({
      volumes: [vol("USB", "/Volumes/USB"), vol("USB 2", "/Volumes/USB 2", false)],
    });
    usePanes.getState().boot("/Volumes/USB 2/photos");
    ejectActiveVolume();
    expect(mocks.ejects).toEqual([]);
    expect(messages()).toEqual(["This location can't be ejected"]);

    usePanes.getState().boot("/Volumes/USB/photos");
    ejectActiveVolume();
    expect(mocks.ejects.map((e) => e.path)).toEqual(["/Volumes/USB"]);
  });
});

describe("isWithin", () => {
  it("matches whole path components", () => {
    expect(isWithin("/Volumes/USB", "/Volumes/USB")).toBe(true);
    expect(isWithin("/Volumes/USB/a/b", "/Volumes/USB")).toBe(true);
    expect(isWithin("/Volumes/USB 2", "/Volumes/USB")).toBe(false);
    expect(isWithin("/Volumes/USBX/a", "/Volumes/USB")).toBe(false);
    expect(isWithin("/Volumes", "/Volumes/USB")).toBe(false);
    expect(isWithin("/anything", "/")).toBe(true);
  });
});
