/**
 * New tabs open directly below the active tab (not at the end of the list),
 * and a run of opens keeps its order.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { usePanes } from "../panes";

const paths = () => usePanes.getState().panes[0].tabs.map((t) => t.path);
const activePath = () => {
  const pane = usePanes.getState().panes[0];
  return pane.tabs.find((t) => t.id === pane.activeTabId)?.path;
};

describe("openTab placement", () => {
  beforeEach(() => {
    usePanes.getState().boot("/a");
    const s = usePanes.getState();
    s.openTab("left", "/b");
    s.openTab("left", "/c");
  });

  it("appends after the active tab when it is last", () => {
    expect(paths()).toEqual(["/a", "/b", "/c"]);
    expect(activePath()).toBe("/c");
  });

  it("inserts below a middle active tab and activates the new tab", () => {
    const s = usePanes.getState();
    s.activateTab("left", s.panes[0].tabs[0].id); // /a
    usePanes.getState().openTab("left", "/new");
    expect(paths()).toEqual(["/a", "/new", "/b", "/c"]);
    expect(activePath()).toBe("/new");
  });

  it("keeps the order of several tabs opened in a row", () => {
    const s = usePanes.getState();
    s.activateTab("left", s.panes[0].tabs[0].id); // /a
    for (const p of ["/x", "/y", "/z"]) usePanes.getState().openTab("left", p);
    expect(paths()).toEqual(["/a", "/x", "/y", "/z", "/b", "/c"]);
  });
});

describe("moveTab", () => {
  const pathsOf = (id: "left" | "right") =>
    usePanes.getState().panes.find((p) => p.id === id)?.tabs.map((t) => t.path);

  beforeEach(() => {
    usePanes.getState().boot("/a");
    const s = usePanes.getState();
    s.openTab("left", "/b");
    s.openTab("left", "/c");
  });

  it("reorders within a pane (insertion index counted before the move)", () => {
    const c = usePanes.getState().panes[0].tabs[2].id;
    usePanes.getState().moveTab("left", c, "left", 0);
    expect(pathsOf("left")).toEqual(["/c", "/a", "/b"]);
    const a = usePanes.getState().panes[0].tabs[1].id;
    usePanes.getState().moveTab("left", a, "left", 3);
    expect(pathsOf("left")).toEqual(["/c", "/b", "/a"]);
  });

  it("moves a tab into the other pane and activates it there", () => {
    usePanes.getState().setSplit(true, "/r");
    const b = usePanes.getState().panes[0].tabs[1].id;
    usePanes.getState().moveTab("left", b, "right", 0);
    expect(pathsOf("left")).toEqual(["/a", "/c"]);
    expect(pathsOf("right")).toEqual(["/b", "/r"]);
    const right = usePanes.getState().panes.find((p) => p.id === "right");
    expect(right?.tabs.find((t) => t.id === right.activeTabId)?.path).toBe("/b");
  });

  it("keeps the left pane's last tab, and closes dual pane when the right one empties", () => {
    usePanes.getState().boot("/solo");
    usePanes.getState().setSplit(true, "/r");
    const solo = usePanes.getState().panes[0].tabs[0].id;
    usePanes.getState().moveTab("left", solo, "right", 0);
    expect(pathsOf("left")).toEqual(["/solo"]);

    const r = usePanes.getState().panes.find((p) => p.id === "right")!.tabs[0].id;
    usePanes.getState().moveTab("right", r, "left", 1);
    expect(usePanes.getState().split).toBe(false);
    expect(usePanes.getState().panes.map((p) => p.id)).toEqual(["left"]);
    expect(pathsOf("left")).toEqual(["/solo", "/r"]);
  });
});
