/**
 * Tab sessions: a saved layout survives a relaunch, malformed storage is
 * ignored, and folders that vanished reopen at their nearest surviving
 * ancestor.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { usePanes } from "../panes";
import { useApp } from "../app";
import { useSettings } from "../settings";
import { captureSession, parseSession, resolvePaths, restoreOrBoot } from "../session";

const KEY = "fazi-session";
const all = (existing: string[]) => (paths: string[]) =>
  Promise.resolve(paths.map((p) => p === "/" || existing.includes(p)));
const tabPaths = (paneIndex = 0) =>
  usePanes.getState().panes[paneIndex]?.tabs.map((t) => t.path) ?? [];
const activePath = (paneIndex = 0) => {
  const pane = usePanes.getState().panes[paneIndex];
  return pane?.tabs.find((t) => t.id === pane.activeTabId)?.path;
};

describe("parseSession", () => {
  it("rejects garbage and sessions without a left pane", () => {
    expect(parseSession(null)).toBeNull();
    expect(parseSession("{not json")).toBeNull();
    expect(parseSession(JSON.stringify({ version: 2, panes: [] }))).toBeNull();
    expect(
      parseSession(JSON.stringify({ version: 1, panes: [{ id: "right", activeIndex: 0, tabs: [{ path: "/a" }] }] })),
    ).toBeNull();
  });

  it("drops bad tabs, clamps the active index, and needs a right pane for split", () => {
    const s = parseSession(
      JSON.stringify({
        version: 1,
        split: true,
        activePane: "right",
        panes: [{ id: "left", activeIndex: 9, tabs: [{ path: "relative" }, { path: "/ok", sort: { key: "bogus" } }] }],
      }),
    );
    expect(s?.split).toBe(false);
    expect(s?.activePane).toBe("left");
    expect(s?.panes[0].tabs.map((t) => t.path)).toEqual(["/ok"]);
    expect(s?.panes[0].activeIndex).toBe(0);
    expect(s?.panes[0].tabs[0].sort.key).toBe(useSettings.getState().defaultSortKey);
  });
});

describe("resolvePaths", () => {
  it("keeps existing paths and walks missing ones up to a survivor", async () => {
    const map = await resolvePaths(["/a/b", "/x/y/z", "/gone"], all(["/a/b", "/x"]));
    expect(map.get("/a/b")).toBe("/a/b");
    expect(map.get("/x/y/z")).toBe("/x");
    expect(map.get("/gone")).toBe("/");
  });
});

describe("restoreOrBoot", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettings.setState({ restoreTabs: true });
    usePanes.getState().boot("/home");
    usePanes.getState().setSplit(false);
    useApp.getState().setActivePane("left");
  });

  it("boots a single Home tab when nothing was saved", async () => {
    await restoreOrBoot("/home", all([]));
    expect(tabPaths()).toEqual(["/home"]);
    expect(usePanes.getState().split).toBe(false);
  });

  it("round-trips tabs, active tab, dual pane, focus, sort, and history", async () => {
    const s = usePanes.getState();
    s.openTab("left", "/b");
    s.setSort("left", usePanes.getState().panes[0].activeTabId, "size", "desc");
    s.setSplit(true, "/r");
    useApp.getState().setActivePane("right");
    const saved = captureSession();
    saved.panes[0].tabs[1].back = ["/home"];
    localStorage.setItem(KEY, JSON.stringify(saved));

    usePanes.getState().boot("/elsewhere"); // a fresh launch
    await restoreOrBoot("/home", all(["/home", "/b", "/r"]));

    expect(tabPaths(0)).toEqual(["/home", "/b"]);
    expect(activePath(0)).toBe("/b");
    expect(tabPaths(1)).toEqual(["/r"]);
    expect(usePanes.getState().split).toBe(true);
    expect(useApp.getState().activePaneId).toBe("right");
    const b = usePanes.getState().panes[0].tabs[1];
    expect(b.sort).toEqual({ key: "size", dir: "desc" });
    expect(b.back.map((h) => h.path)).toEqual(["/home"]);
  });

  it("reopens a vanished folder at its nearest surviving ancestor", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ version: 1, split: false, activePane: "left", panes: [{ id: "left", activeIndex: 0, tabs: [{ path: "/Volumes/USB/photos" }] }] }),
    );
    await restoreOrBoot("/home", all(["/Volumes"]));
    expect(tabPaths()).toEqual(["/Volumes"]);
  });

  it("ignores the saved session when the setting is off", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ version: 1, split: false, activePane: "left", panes: [{ id: "left", activeIndex: 0, tabs: [{ path: "/b" }] }] }),
    );
    useSettings.setState({ restoreTabs: false });
    await restoreOrBoot("/home", all(["/b"]));
    expect(tabPaths()).toEqual(["/home"]);
  });
});
