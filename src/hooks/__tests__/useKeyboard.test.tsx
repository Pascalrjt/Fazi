/**
 * The rename context is fully component-handled, so the window listener bows
 * out of it. That leaves one hazard: if nothing is rendering the input, every
 * key is swallowed with no way back. Escape has to remain a way out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

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
import { currentKeyContext } from "../../lib/keyContext";
import { rebuildRegistry } from "../../lib/commands";
import { useApp } from "../../stores/app";

function Probe() {
  useKeyboard();
  return null;
}

beforeEach(() => {
  rebuildRegistry();
  useApp.setState({
    renaming: null,
    settingsOpen: false,
    settingsActive: false,
    batchRenameOpen: false,
    paletteOpen: false,
    previewOpen: false,
    confirm: null,
    searchFieldFocused: false,
    pathBarEditing: false,
  });
});

afterEach(() => {
  cleanup();
  rebuildRegistry();
});

describe("rename context escape hatch", () => {
  it("frees the keyboard on Escape when nothing renders the input", () => {
    render(<Probe />);
    useApp.setState({ renaming: { paneId: "left", tabId: "t", entryId: 1 } });
    expect(currentKeyContext()).toBe("rename");

    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });

    expect(useApp.getState().renaming).toBeNull();
    expect(currentKeyContext()).toBe("browse");
  });

  it("still swallows every other key in rename context", () => {
    render(<Probe />);
    useApp.setState({ renaming: { paneId: "left", tabId: "t", entryId: 1 } });

    // cmd+n / space / plain letters must not reach the registry or type-ahead
    fireEvent.keyDown(window, { key: "n", code: "KeyN", metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    fireEvent.keyDown(window, { key: "a", code: "KeyA" });

    expect(useApp.getState().renaming).not.toBeNull();
    expect(useApp.getState().previewOpen).toBe(false); // space didn't open Quick Look
  });
});

describe("currentKeyContext precedence", () => {
  it("ranks modal above palette, rename, and preview", () => {
    useApp.setState({ batchRenameOpen: true, paletteOpen: true, renaming: { paneId: "left", tabId: "t", entryId: 1 } });
    expect(currentKeyContext()).toBe("modal");
  });

  it("gives the Settings tab its own context, even in its text fields", () => {
    useApp.setState({ settingsOpen: true, settingsActive: true });
    const input = document.createElement("input");
    document.body.appendChild(input);
    expect(currentKeyContext(input)).toBe("settings");
    expect(currentKeyContext()).toBe("settings");
    input.remove();
    // An open but inactive Settings tab leaves the panes in charge.
    useApp.setState({ settingsActive: false });
    expect(currentKeyContext()).toBe("browse");
  });

  it("ranks the palette above the Settings tab", () => {
    useApp.setState({ settingsOpen: true, settingsActive: true, paletteOpen: true });
    expect(currentKeyContext()).toBe("palette");
  });

  it("ranks rename above preview but below palette", () => {
    useApp.setState({ renaming: { paneId: "left", tabId: "t", entryId: 1 }, previewOpen: true });
    expect(currentKeyContext()).toBe("rename");
    useApp.setState({ paletteOpen: true });
    expect(currentKeyContext()).toBe("palette");
  });

  it("treats a focused text field as search context", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    expect(currentKeyContext(input)).toBe("search");
    expect(currentKeyContext()).toBe("browse");
    input.remove();
  });
});

describe("Settings tab shortcuts", () => {
  it("closes the tab with ⌘W and keeps file shortcuts away from the hidden panes", () => {
    render(<Probe />);
    useApp.setState({ settingsOpen: true, settingsActive: true });

    // Space would open Quick Look in browse.
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(useApp.getState().previewOpen).toBe(false);

    fireEvent.keyDown(window, { key: "w", code: "KeyW", metaKey: true });
    expect(useApp.getState().settingsOpen).toBe(false);
    expect(useApp.getState().settingsActive).toBe(false);
  });

  it("leaves the tab open but switches back to the panes on ⌃⇥", () => {
    render(<Probe />);
    useApp.setState({ settingsOpen: true, settingsActive: true });
    fireEvent.keyDown(window, { key: "Tab", code: "Tab", ctrlKey: true });
    expect(useApp.getState().settingsOpen).toBe(true);
    expect(useApp.getState().settingsActive).toBe(false);
  });

  it("focuses the settings search on ⌘F", () => {
    render(<Probe />);
    useApp.setState({ settingsOpen: true, settingsActive: true, settingsSearchFocusSeq: 0, searchFocusSeq: 0 });
    fireEvent.keyDown(window, { key: "f", code: "KeyF", metaKey: true });
    expect(useApp.getState().settingsSearchFocusSeq).toBe(1);
    expect(useApp.getState().searchFocusSeq).toBe(0);
  });
});
