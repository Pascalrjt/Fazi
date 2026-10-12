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
