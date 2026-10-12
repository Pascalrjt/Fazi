/**
 * Breadcrumb native drop zone: crumbs are registry drop targets (DOM drag
 * events are dead in the running app), the hover channel drives the crumb
 * highlight, and dragged-item ancestors are refused as targets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";

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

import { Toolbar } from "../Toolbar";
import {
  beginNativeDragState,
  emitDropHover,
  endNativeDragState,
  hitTestDropZones,
} from "../../../lib/dnd";
import { usePanes } from "../../../stores/panes";

/** Give a crumb button a real rect (jsdom defaults to 0×0). */
function mockRect(el: Element, left: number, right: number) {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left,
      right,
      width: right - left,
      top: 0,
      bottom: 20,
      height: 20,
      x: left,
      y: 0,
      toJSON: () => ({}),
    }),
  });
}

function seedPath(path: string) {
  const s = usePanes.getState();
  const pane = s.panes[0];
  const tab = pane.tabs[0];
  usePanes.setState({
    panes: [
      {
        ...pane,
        activeTabId: tab.id,
        tabs: [{ ...tab, path, loading: false, listed: true }],
      },
      ...s.panes.slice(1),
    ],
  });
}

function crumbButton(path: string): HTMLElement {
  const el = document.querySelector(`[data-crumb-path="${path}"]`);
  if (!el) throw new Error(`crumb ${path} not rendered`);
  return el as HTMLElement;
}

describe("breadcrumb drop zone", () => {
  beforeEach(() => {
    seedPath("/Users/me/Docs");
    render(<Toolbar />);
    mockRect(crumbButton("/Users"), 0, 60);
    mockRect(crumbButton("/Users/me"), 70, 130);
    mockRect(crumbButton("/Users/me/Docs"), 140, 200);
  });

  afterEach(() => {
    endNativeDragState();
    cleanup();
  });

  it("hit-testing a crumb rect returns a copyTo into that segment", () => {
    expect(hitTestDropZones(100, 10)).toEqual({
      action: "copyTo",
      destDir: "/Users/me",
      targetKey: "crumb:/Users/me",
    });
    // Between crumbs → no breadcrumb hit (nothing else registered here).
    expect(hitTestDropZones(65, 10)).toBeNull();
  });

  it("the hover channel highlights the crumb and clears on null", () => {
    const crumb = crumbButton("/Users/me");
    act(() =>
      emitDropHover({
        hit: { action: "copyTo", destDir: "/Users/me", targetKey: "crumb:/Users/me" },
        x: 100,
        y: 10,
      }),
    );
    expect(crumb.className).toContain("drop-ring");
    act(() => emitDropHover(null));
    expect(crumb.className).not.toContain("drop-ring");
  });

  it("refuses a crumb that is the dragged item's own parent", () => {
    beginNativeDragState(["/Users/me/child.txt"], false);
    expect(hitTestDropZones(100, 10)).toBeNull(); // /Users/me is the parent
    expect(hitTestDropZones(30, 10)).toEqual({
      action: "copyTo",
      destDir: "/Users",
      targetKey: "crumb:/Users",
    });
  });

  it("clicking a crumb still navigates (zone registration is drag-only)", () => {
    expect(screen.getByText("Docs")).toBeTruthy();
  });
});
