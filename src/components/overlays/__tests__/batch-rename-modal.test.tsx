/**
 * BatchRenameModal: live preview reflects the spec, collision rows flag and
 * disable Apply, and a clean spec dispatches the whole batch to batch_rename.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Entry } from "../../../types/ipc";

const mocks = vi.hoisted(() => ({
  batchRenameCalls: [] as Array<Array<{ from: string; toName: string }>>,
}));

vi.mock("../../../lib/ipc", () => ({
  batchRename: (renames: Array<{ from: string; toName: string }>) => {
    mocks.batchRenameCalls.push(renames);
    return Promise.resolve(renames.map((r) => `/dir/${r.toName}`));
  },
  listDir: () => Promise.resolve(),
  cancelListing: () => Promise.resolve(),
  watchDir: () => Promise.resolve(),
  unwatch: () => Promise.resolve(),
}));

import { BatchRenameModal } from "../BatchRenameModal";
import { useApp } from "../../../stores/app";
import { usePanes } from "../../../stores/panes";

function entry(id: number, name: string): Entry {
  return {
    id,
    name,
    path: `/dir/${name}`,
    kind: "file",
    hidden: false,
    icon: "t",
    ext: name.split(".").pop() ?? "",
    hydrated: true,
    size: 1,
    mtime: null,
    btime: null,
    isPackage: false,
    isAlias: false,
    linkTarget: null,
    tags: [],
    noAccess: false,
  };
}

function seedSelection(names: string[], siblings: string[] = []): void {
  usePanes.getState().boot("/dir");
  const s = usePanes.getState();
  const all = [...names, ...siblings].map((n, i) => entry(i + 1, n));
  usePanes.setState({
    panes: s.panes.map((pane, i) =>
      i === 0
        ? {
            ...pane,
            tabs: pane.tabs.map((tab, j) =>
              j === 0
                ? {
                    ...tab,
                    entries: all,
                    selection: {
                      selected: new Set(names.map((_, k) => k + 1)),
                      anchor: 1,
                      lead: 1,
                    },
                  }
                : tab,
            ),
          }
        : pane,
    ),
  });
}

describe("BatchRenameModal", () => {
  beforeEach(() => {
    mocks.batchRenameCalls.length = 0;
    useApp.setState({ batchRenameOpen: false });
  });

  afterEach(() => {
    cleanup();
    useApp.setState({ batchRenameOpen: false });
  });

  it("live preview follows the find/replace spec and applies the batch", async () => {
    seedSelection(["IMG_1.jpg", "IMG_2.jpg"]);
    useApp.setState({ batchRenameOpen: true });
    render(<BatchRenameModal />);

    fireEvent.change(screen.getByPlaceholderText(/regex/), { target: { value: "IMG_" } });
    fireEvent.change(screen.getByPlaceholderText(/\$1 supported/), {
      target: { value: "Photo " },
    });
    expect(screen.getByTestId("preview-0").textContent).toBe("Photo 1.jpg");
    expect(screen.getByTestId("preview-1").textContent).toBe("Photo 2.jpg");

    const apply = screen.getByText("Rename", { selector: "button" });
    expect((apply as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(apply);
    await waitFor(() => {
      expect(mocks.batchRenameCalls).toEqual([
        [
          { from: "/dir/IMG_1.jpg", toName: "Photo 1.jpg" },
          { from: "/dir/IMG_2.jpg", toName: "Photo 2.jpg" },
        ],
      ]);
    });
    expect(useApp.getState().batchRenameOpen).toBe(false);
  });

  it("collision rows are flagged and Apply is disabled until clean", () => {
    // Renaming both to the same target collides intra-batch.
    seedSelection(["a.txt", "b.txt"], ["taken.txt"]);
    useApp.setState({ batchRenameOpen: true });
    render(<BatchRenameModal />);

    fireEvent.change(screen.getByPlaceholderText(/regex/), { target: { value: "^.*$" } });
    fireEvent.change(screen.getByPlaceholderText(/\$1 supported/), {
      target: { value: "same" },
    });
    expect(screen.getByTestId("preview-0").textContent).toContain("(collision)");
    const apply = screen.getByText("Rename", { selector: "button" });
    expect((apply as HTMLButtonElement).disabled).toBe(true);

    // Colliding with a non-batch sibling also blocks.
    fireEvent.change(screen.getByPlaceholderText(/\$1 supported/), {
      target: { value: "taken" },
    });
    expect(screen.getByTestId("preview-0").textContent).toContain("(collision)");
    expect((apply as HTMLButtonElement).disabled).toBe(true);
  });

  it("a spec producing an illegal name keeps Apply blocked", () => {
    seedSelection(["a.txt", "b.txt"]);
    useApp.setState({ batchRenameOpen: true });
    render(<BatchRenameModal />);

    // ":" passes the old inline check's siblings logic but violates the
    // shared name rules (Finder displays it as "/").
    fireEvent.change(screen.getByPlaceholderText(/regex/), { target: { value: "^a" } });
    fireEvent.change(screen.getByPlaceholderText(/\$1 supported/), {
      target: { value: "a:" },
    });
    expect(screen.getByTestId("preview-0").textContent).toContain("a:.txt");
    const apply = screen.getByText("Rename", { selector: "button" });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
  });

  it("Apply stays disabled when nothing changes", () => {
    seedSelection(["a.txt", "b.txt"]);
    useApp.setState({ batchRenameOpen: true });
    render(<BatchRenameModal />);
    const apply = screen.getByText("Rename", { selector: "button" });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
  });
});
