/**
 * The native Edit menu bypasses the webview keydown path entirely, so this is
 * the only guard standing between an AppKit menu event and a destructive file
 * operation. Covers the context filter, the editable-target predicate, and the
 * text-editing branch that replaces what the swallowed keystroke would have
 * done.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pbReadText: vi.fn(() => Promise.resolve("clip")),
  pbWriteText: vi.fn(() => Promise.resolve()),
  pbReadFiles: vi.fn(() => Promise.resolve(null)),
  undoLast: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../../ipc", () => ({
  pbReadText: mocks.pbReadText,
  pbWriteText: mocks.pbWriteText,
  pbReadFiles: mocks.pbReadFiles,
  undoLast: mocks.undoLast,
  redoLast: () => Promise.resolve(null),
  runOp: () => Promise.resolve(),
  duplicatePaths: () => Promise.resolve(),
  statPath: () => Promise.resolve(null),
  cancelOp: () => Promise.resolve(),
  respondConflict: () => Promise.resolve(),
}));

import { menuCommandAction, runMenuCommand, textEditTarget } from "../menuCommand";
import { rebuildRegistry } from "../index";
import type { KeyContext } from "../../keyboard";
import { useApp } from "../../../stores/app";

const EDIT_COMMANDS = ["undo", "redo", "cut", "copy", "paste", "selectAll"];
const CONTEXTS: KeyContext[] = ["browse", "rename", "modal", "palette", "preview", "search"];

function resetApp(): void {
  useApp.setState({
    renaming: null,
    settingsOpen: false,
    batchRenameOpen: false,
    paletteOpen: false,
    previewOpen: false,
    confirm: null,
    searchFieldFocused: false,
    pathBarEditing: false,
  });
}

beforeEach(() => {
  rebuildRegistry();
  resetApp();
  vi.clearAllMocks();
});

afterEach(() => {
  document.body.innerHTML = "";
  rebuildRegistry(); // restore defaults for other test files
});

describe("menuCommandAction", () => {
  it("runs Edit commands as file operations only in browse", () => {
    for (const id of EDIT_COMMANDS) {
      for (const ctx of CONTEXTS) {
        const action = menuCommandAction(id, ctx, false);
        expect(action.kind, `${id} in ${ctx}`).toBe(ctx === "browse" ? "file" : "ignore");
      }
    }
  });

  it("routes to the text branch whenever a field owns focus", () => {
    for (const id of EDIT_COMMANDS) {
      for (const ctx of CONTEXTS) {
        expect(menuCommandAction(id, ctx, true)).toEqual({ kind: "text", commandId: id });
      }
    }
  });

  it("ignores unknown command ids", () => {
    expect(menuCommandAction("nope", "browse", false).kind).toBe("ignore");
  });

  it("keys off declared contexts, not bindings", () => {
    // An unbound command still belongs to browse — the menu item remains
    // clickable even with no accelerator.
    rebuildRegistry({ paste: null });
    expect(menuCommandAction("paste", "browse", false).kind).toBe("file");
    expect(menuCommandAction("paste", "rename", false).kind).toBe("ignore");
  });
});

describe("textEditTarget", () => {
  it("accepts text inputs and textareas", () => {
    const input = document.createElement("input");
    expect(textEditTarget(input)).toBe(input); // no type attribute → "text"
    input.type = "search";
    expect(textEditTarget(input)).toBe(input);
    const area = document.createElement("textarea");
    expect(textEditTarget(area)).toBe(area);
  });

  it("rejects non-text controls and non-elements", () => {
    for (const type of ["checkbox", "number", "radio", "button"]) {
      const el = document.createElement("input");
      el.type = type;
      expect(textEditTarget(el), type).toBeNull();
    }
    expect(textEditTarget(document.createElement("div"))).toBeNull();
    expect(textEditTarget(null)).toBeNull();
  });
});

describe("runMenuCommand", () => {
  function focusedInput(value = "hello", start = 0, end = 0): HTMLInputElement {
    const input = document.createElement("input");
    input.value = value;
    document.body.appendChild(input);
    input.focus();
    input.setSelectionRange(start, end);
    return input;
  }

  it("pastes into the focused field, never into the filesystem", async () => {
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    focusedInput("hello", 5, 5);

    runMenuCommand("paste");
    await vi.waitFor(() => expect(exec).toHaveBeenCalled());

    expect(mocks.pbReadText).toHaveBeenCalled();
    expect(mocks.pbReadFiles).not.toHaveBeenCalled(); // the file-paste path
    expect(exec).toHaveBeenCalledWith("insertText", false, "clip");
  });

  it("copies the field's selection, not the selected files", async () => {
    focusedInput("hello", 1, 4);
    runMenuCommand("copy");
    await vi.waitFor(() => expect(mocks.pbWriteText).toHaveBeenCalledWith("ell"));
  });

  it("cuts by writing the selection out before deleting it", async () => {
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    focusedInput("hello", 1, 4);

    runMenuCommand("cut");
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith("delete"));
    expect(mocks.pbWriteText).toHaveBeenCalledWith("ell");
  });

  it("leaves the pasteboard alone when the selection is empty", async () => {
    focusedInput("hello", 2, 2);
    runMenuCommand("copy");
    await Promise.resolve();
    expect(mocks.pbWriteText).not.toHaveBeenCalled();
  });

  it("selects the field's text for selectAll", () => {
    const input = focusedInput("hello", 0, 0);
    runMenuCommand("selectAll");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(5);
  });

  it("routes undo to the field, not the filesystem", async () => {
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    focusedInput();
    runMenuCommand("undo");
    await Promise.resolve();
    expect(exec).toHaveBeenCalledWith("undo");
    expect(mocks.undoLast).not.toHaveBeenCalled();
  });

  it("does nothing at all while renaming with no field focused", async () => {
    useApp.setState({ renaming: { paneId: "left", tabId: "t", entryId: 1 } });
    runMenuCommand("paste");
    runMenuCommand("undo");
    await Promise.resolve();
    expect(mocks.pbReadText).not.toHaveBeenCalled();
    expect(mocks.pbReadFiles).not.toHaveBeenCalled();
    expect(mocks.undoLast).not.toHaveBeenCalled();
  });

  it("does nothing behind a modal with no field focused", async () => {
    useApp.setState({ settingsOpen: true });
    runMenuCommand("undo");
    await Promise.resolve();
    expect(mocks.undoLast).not.toHaveBeenCalled();
  });

  it("still performs file operations in browse", async () => {
    runMenuCommand("paste");
    await vi.waitFor(() => expect(mocks.pbReadFiles).toHaveBeenCalled());
  });
});
