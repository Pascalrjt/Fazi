/**
 * Icon view must render the inline rename field. Without it, `app.renaming`
 * pins the key context to "rename" while nothing can clear it, and every
 * keystroke is swallowed — the keyboard goes dead until you reach for the
 * mouse.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Entry } from "../../../types/ipc";

const mocks = vi.hoisted(() => ({
  renamePath: vi.fn((_path: string, name: string) => Promise.resolve(`/g/${name}`)),
}));

vi.mock("../../../lib/ipc", () => ({
  renamePath: mocks.renamePath,
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

import { GridView } from "../GridView";
import { usePanes } from "../../../stores/panes";
import { useApp } from "../../../stores/app";

function entry(id: number, name: string, kind: "dir" | "file" = "file"): Entry {
  return {
    id,
    name,
    path: `/g/${name}`,
    kind,
    hidden: false,
    icon: "",
    ext: name.includes(".") ? name.slice(name.lastIndexOf(".")) : "",
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

const ENTRIES = [entry(1, "notes.txt"), entry(2, "photo.png"), entry(3, "Folder", "dir")];

function seed(): { paneId: "left"; tabId: string } {
  const s = usePanes.getState();
  const pane = s.panes[0];
  const tab = pane.tabs[0];
  usePanes.setState({
    panes: [
      {
        ...pane,
        activeTabId: tab.id,
        tabs: [{ ...tab, path: "/g", entries: ENTRIES, loading: false, listed: true }],
      },
      ...s.panes.slice(1),
    ],
  });
  return { paneId: "left", tabId: tab.id };
}

/**
 * jsdom reports every element as 0×0, so the virtualizer would render no rows
 * at all. Give the prototype a viewport: 480px wide (4 columns at CELL_W 112)
 * and tall enough for the single row these fixtures need.
 */
const SIZED = ["offsetWidth", "clientWidth"] as const;
const SIZED_V = ["offsetHeight", "clientHeight"] as const;

function installLayout(): () => void {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const set = (prop: string, value: number) => {
    saved.set(prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop));
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, value });
  };
  for (const p of SIZED) set(p, 480);
  for (const p of SIZED_V) set(p, 600);
  saved.set(
    "getBoundingClientRect",
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect"),
  );
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: 0, right: 480, width: 480, top: 0, bottom: 600, height: 600,
      x: 0, y: 0, toJSON: () => ({}),
    }),
  });
  return () => {
    for (const [prop, desc] of saved) {
      if (desc) Object.defineProperty(HTMLElement.prototype, prop, desc);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    }
  };
}

describe("grid inline rename", () => {
  let ids: { paneId: "left"; tabId: string };
  let restoreLayout: () => void;

  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    restoreLayout = installLayout();
    ids = seed();
    vi.clearAllMocks();
  });

  afterEach(() => {
    useApp.getState().stopRename();
    cleanup();
    restoreLayout();
    vi.unstubAllGlobals();
  });

  function renderRenaming(entryId: number) {
    useApp.setState({ renaming: { ...ids, entryId } });
    const view = render(<GridView paneId={ids.paneId} tabId={ids.tabId} />);
    const input = view.container.querySelector("input.rename-input") as HTMLInputElement;
    return { ...view, input };
  }

  it("renders a focused field with the stem preselected", () => {
    const { input } = renderRenaming(1);
    expect(input).not.toBeNull();
    expect(input.value).toBe("notes.txt");
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("notes".length); // extension excluded
  });

  it("selects the whole name for a folder", () => {
    const { input } = renderRenaming(3);
    expect(input.selectionEnd).toBe("Folder".length);
  });

  it("commits on Enter and clears the rename state", async () => {
    const { input } = renderRenaming(1);
    fireEvent.change(input, { target: { value: "renamed.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mocks.renamePath).toHaveBeenCalledWith("/g/notes.txt", "renamed.txt");
    expect(useApp.getState().renaming).toBeNull();
  });

  it("cancels on Escape without renaming", () => {
    const { input } = renderRenaming(1);
    fireEvent.change(input, { target: { value: "whatever" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(mocks.renamePath).not.toHaveBeenCalled();
    expect(useApp.getState().renaming).toBeNull();
  });

  it("advances to the next entry on Tab", () => {
    const { input } = renderRenaming(1);
    fireEvent.keyDown(input, { key: "Tab" });
    expect(useApp.getState().renaming?.entryId).toBe(2);
  });

  it("suppresses dragging on the cell being renamed", () => {
    const { container } = renderRenaming(1);
    const cells = container.querySelectorAll("[data-row]");
    expect(cells[0].getAttribute("draggable")).toBe("false");
    expect(cells[1].getAttribute("draggable")).toBe("true");
  });

  it("rejects a name that collides with a sibling", () => {
    const { input } = renderRenaming(1);
    fireEvent.change(input, { target: { value: "photo.png" } });
    expect(input.className).toContain("invalid");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mocks.renamePath).not.toHaveBeenCalled();
    expect(useApp.getState().renaming).not.toBeNull(); // stays in rename mode
  });
});
