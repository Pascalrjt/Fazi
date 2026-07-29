/**
 * Vim mode through the real window keydown path: the interpreter runs before
 * the registry, type-ahead is disabled while Vim is on, global search results
 * and text-field contexts are excluded, and visual mode drives the selection
 * model. (Reducer semantics are covered in lib/__tests__/vim.test.ts.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Entry } from "../../types/ipc";

vi.mock("../../lib/ipc", () => ({
  runOp: () => Promise.resolve(),
  duplicatePaths: () => Promise.resolve(),
  cancelOp: () => Promise.resolve(),
  respondConflict: () => Promise.resolve(),
  undoLast: () => Promise.resolve(null),
  redoLast: () => Promise.resolve(null),
  statPath: () => Promise.resolve(null),
  listDir: () => Promise.resolve(null),
}));

import { useKeyboard } from "../useKeyboard";
import { rebuildRegistry } from "../../lib/commands";
import { useApp } from "../../stores/app";
import { usePanes } from "../../stores/panes";
import { useSettings } from "../../stores/settings";
import { useVim } from "../../stores/vim";

function Probe() {
  useKeyboard();
  return null;
}

function entry(id: number, name: string): Entry {
  return {
    id,
    name,
    path: `/v/${name}`,
    kind: "file",
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
  } as Entry;
}

const ENTRIES = Array.from({ length: 10 }, (_, i) => entry(i + 1, `file${i}`));

function seed(): void {
  const s = usePanes.getState();
  const pane = s.panes[0];
  const tab = pane.tabs[0];
  usePanes.setState({
    panes: [
      {
        ...pane,
        activeTabId: tab.id,
        tabs: [
          {
            ...tab,
            path: "/v",
            entries: ENTRIES,
            loading: false,
            listed: true,
            selection: { selected: new Set<number>(), anchor: null, lead: null },
          },
        ],
      },
      ...s.panes.slice(1),
    ],
  });
}

function selection() {
  return usePanes.getState().panes[0].tabs[0].selection;
}

function press(key: string, code: string, mods: Partial<KeyboardEventInit> = {}) {
  fireEvent.keyDown(window, { key, code, ...mods });
}

beforeEach(() => {
  useSettings.setState({ vimMode: true, viewMode: "list" });
  rebuildRegistry();
  useApp.setState({
    activePaneId: "left",
    renaming: null,
    settingsOpen: false,
    batchRenameOpen: false,
    paletteOpen: false,
    previewOpen: false,
    confirm: null,
    searchFieldFocused: false,
    pathBarEditing: false,
  });
  seed();
  useVim.getState().reset();
});

afterEach(() => {
  cleanup();
  useSettings.setState({ vimMode: false });
  rebuildRegistry();
});

describe("vim motions through the window listener", () => {
  it("j/k move the cursor; counts multiply", () => {
    render(<Probe />);
    press("j", "KeyJ");
    expect(selection().lead).toBe(1);
    press("j", "KeyJ");
    expect(selection().lead).toBe(2);
    press("3", "Digit3");
    press("j", "KeyJ");
    expect(selection().lead).toBe(5);
    press("k", "KeyK");
    expect(selection().lead).toBe(4);
  });

  it("gg and G jump to the edges", () => {
    render(<Probe />);
    press("j", "KeyJ");
    press("G", "KeyG", { shiftKey: true });
    expect(selection().lead).toBe(10);
    press("g", "KeyG");
    expect(selection().lead).toBe(10); // pending — nothing moved yet
    expect(useVim.getState().state.pending).toBe("g");
    press("g", "KeyG");
    expect(selection().lead).toBe(1);
  });

  it("visual mode extends and Escape collapses to the lead", () => {
    render(<Probe />);
    press("j", "KeyJ"); // cursor on 1
    press("v", "KeyV");
    expect(useVim.getState().state.mode).toBe("visual");
    press("2", "Digit2");
    press("j", "KeyJ");
    expect([...selection().selected].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(selection().lead).toBe(3);
    press("Escape", "Escape");
    expect(useVim.getState().state.mode).toBe("normal");
    expect([...selection().selected]).toEqual([3]); // collapsed to the cursor
  });

  it("entering visual with no cursor selects the first row", () => {
    render(<Probe />);
    press("v", "KeyV");
    expect(selection().lead).toBe(1);
    expect(useVim.getState().state.mode).toBe("visual");
  });
});

describe("routing order", () => {
  it("type-ahead is off while vim is on, back on when disabled", () => {
    render(<Probe />);
    press("f", "KeyF"); // every name starts with "file" — type-ahead would jump
    expect(selection().lead).toBeNull();
    useSettings.setState({ vimMode: false });
    press("f", "KeyF");
    expect(selection().lead).toBe(1);
  });

  it("⌘ shortcuts still reach the registry (⌘A select all)", () => {
    render(<Probe />);
    press("a", "KeyA", { metaKey: true });
    expect(selection().selected.size).toBe(10);
  });

  it("global search results are excluded — j must not move the hidden selection", () => {
    render(<Probe />);
    useApp.getState().openGlobalSearch("x", "mac");
    press("j", "KeyJ");
    expect(selection().lead).toBeNull();
    useApp.getState().closeGlobalSearch();
  });

  it("a focused text field owns the keys and clears pending state", () => {
    render(<Probe />);
    press("g", "KeyG");
    expect(useVim.getState().state.pending).toBe("g");
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "j", code: "KeyJ" }); // search context
    expect(selection().lead).toBeNull(); // no motion fired
    expect(useVim.getState().state.pending).toBeNull(); // prefix reset
    input.remove();
  });

  it("escape with nothing pending falls through to the registry cascade", () => {
    render(<Probe />);
    press("j", "KeyJ");
    expect(selection().selected.size).toBe(1);
    press("Escape", "Escape");
    expect(selection().selected.size).toBe(0); // escapeBrowse deselected
  });
});
