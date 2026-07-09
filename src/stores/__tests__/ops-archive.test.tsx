/**
 * Archive op cards: the explicit progress contract (compress byte-only before
 * totals, render-time ≤100% clamp, extract "N of M archives" with absolute
 * counts), verb labels derived from opVerb, and the archive-aware retry rules
 * (compress retries the FULL selection; extract retries failed archives).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { OpEvent } from "../../types/ipc";

type Captured = { opId: string; sources: string[]; destDir: string; cb: (e: OpEvent) => void };

const mocks = vi.hoisted(() => ({
  compressCalls: [] as Captured[],
  extractCalls: [] as Captured[],
}));

// ops.ts imports "../lib/ipc" → from this test dir that module is "../../lib/ipc".
vi.mock("../../lib/ipc", () => ({
  runOp: () => Promise.resolve(),
  duplicatePaths: () => Promise.resolve(),
  compressPaths: (opId: string, sources: string[], destDir: string, cb: (e: OpEvent) => void) => {
    mocks.compressCalls.push({ opId, sources, destDir, cb });
    return Promise.resolve();
  },
  extractPaths: (opId: string, sources: string[], destDir: string, cb: (e: OpEvent) => void) => {
    mocks.extractCalls.push({ opId, sources, destDir, cb });
    return Promise.resolve();
  },
  cancelOp: () => Promise.resolve(),
  respondConflict: () => Promise.resolve(),
  undoLast: () => Promise.resolve(null),
  redoLast: () => Promise.resolve(null),
  downloadIcloud: () => Promise.resolve(),
}));

import { useOps } from "../ops";
import { OpCards } from "../../components/ops/OpCards";

describe("archive op cards", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.compressCalls.length = 0;
    mocks.extractCalls.length = 0;
    useOps.setState({ cards: [], conflicts: [] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function card(opId: string) {
    return useOps.getState().cards.find((c) => c.opId === opId);
  }

  it("labels compress cards and flips the verb on success", () => {
    const opId = useOps.getState().compress(["/src/Report.pdf"], "/dest");
    expect(card(opId)!.label).toBe("Compressing “Report.pdf”");

    const multi = useOps.getState().compress(["/a", "/b", "/c"], "/dest");
    expect(card(multi)!.label).toBe("Compressing 3 items");

    const { cb } = mocks.compressCalls[0];
    vi.advanceTimersByTime(300); // visible before Done
    cb({ event: "started", opId });
    cb({
      event: "done",
      status: "success",
      errors: [],
      warnings: [],
      skippedIcloud: [],
      produced: ["/dest/Report.pdf.zip"],
      undoable: true,
    });
    expect(card(opId)!.produced).toEqual(["/dest/Report.pdf.zip"]);
    render(<OpCards />);
    expect(screen.getByText("Compressed “Report.pdf”")).toBeTruthy();
  });

  it("compress renders byte-only before totals, then a clamped bar", () => {
    const opId = useOps.getState().compress(["/src/Big"], "/dest");
    const { cb } = mocks.compressCalls[0];
    cb({ event: "started", opId });
    vi.advanceTimersByTime(300);

    // Byte-only phase: no denominator yet.
    cb({ event: "progress", bytesDone: 500, entriesDone: 0, currentPath: "/x", cloned: false });
    const { unmount } = render(<OpCards />);
    expect(screen.getByText("500 bytes compressed…")).toBeTruthy();
    unmount();

    // Totals arrive AFTER the ratchet already overshot them (incompressible
    // data) — the render-time clamp must cap both the line and the bar.
    cb({ event: "progress", bytesDone: 1500, entriesDone: 0, currentPath: "/x", cloned: false });
    cb({ event: "enumerated", totalBytes: 1000, totalEntries: 10 });
    const view = render(<OpCards />);
    expect(screen.getByText("1.0 KB of 1.0 KB")).toBeTruthy();
    const bar = view.container.querySelector<HTMLElement>(".op-progress > div");
    expect(bar!.style.width).toBe("100%");
    // Rate/ETA suppressed for compress cards.
    expect(view.container.textContent).not.toContain("/s");
    expect(view.container.textContent).not.toContain("left");
  });

  it("extract renders N of M archives with the absolute processed count", () => {
    const opId = useOps.getState().extract(["/a/1.zip", "/a/2.zip", "/a/3.zip"], "/dest");
    expect(card(opId)!.label).toBe("Extracting 3 archives");
    const { cb } = mocks.extractCalls[0];
    cb({ event: "started", opId });
    vi.advanceTimersByTime(300);
    cb({ event: "enumerated", totalBytes: 0, totalEntries: 3 });

    // Archive 2 failed — the count still advances (frontend overwrites).
    cb({ event: "itemError", path: "/a/2.zip", message: "ditto failed" });
    cb({ event: "progress", bytesDone: 0, entriesDone: 2, currentPath: "/a/2.zip", cloned: false });

    render(<OpCards />);
    expect(screen.getByText("2 of 3 archives")).toBeTruthy();
    expect(card(opId)!.entriesDone).toBe(2);
  });

  it("compress retry re-invokes with the FULL sources even when errors carry child paths", () => {
    const opId = useOps.getState().compress(["/src/Folder", "/src/other.txt"], "/dest");
    const { cb } = mocks.compressCalls[0];
    cb({ event: "started", opId });
    // All-or-nothing failure whose ItemError names a child INSIDE the folder.
    cb({ event: "itemError", path: "/src/Folder/locked/secret.txt", message: "permission denied" });
    cb({
      event: "done",
      status: "failed",
      errors: [{ path: "/src/Folder/locked/secret.txt", message: "permission denied" }],
      warnings: [],
      skippedIcloud: [],
      produced: [],
      undoable: false,
    });

    useOps.getState().retry(opId);
    expect(mocks.compressCalls).toHaveLength(2);
    // Retrying the child path alone would compress the child by itself.
    expect(mocks.compressCalls[1].sources).toEqual(["/src/Folder", "/src/other.txt"]);
    expect(mocks.compressCalls[1].destDir).toBe("/dest");
  });

  it("extract retry re-invokes with only the failed archive paths", () => {
    const opId = useOps.getState().extract(["/a/one.zip", "/a/two.zip", "/a/three.zip"], "/dest");
    const { cb } = mocks.extractCalls[0];
    cb({ event: "started", opId });
    cb({ event: "itemError", path: "/a/two.zip", message: "ditto failed" });
    cb({
      event: "done",
      status: "partial",
      errors: [{ path: "/a/two.zip", message: "ditto failed" }],
      warnings: [],
      skippedIcloud: [],
      produced: ["/dest/one", "/dest/three"],
      undoable: true,
    });

    useOps.getState().retry(opId);
    expect(mocks.extractCalls).toHaveLength(2);
    // Safe because the backend guarantees ItemError.path is the archive path.
    expect(mocks.extractCalls[1].sources).toEqual(["/a/two.zip"]);
    expect(mocks.extractCalls[1].destDir).toBe("/dest");
  });

  it("shows the archive-specific failure verb", () => {
    const opId = useOps.getState().extract(["/a/bad.zip"], "/dest");
    const { cb } = mocks.extractCalls[0];
    cb({ event: "started", opId });
    cb({
      event: "done",
      status: "failed",
      errors: [{ path: "/a/bad.zip", message: "ditto failed" }],
      warnings: [],
      skippedIcloud: [],
      produced: [],
      undoable: false,
    });
    render(<OpCards />);
    expect(screen.getByText("1 item couldn't be extracted")).toBeTruthy();
  });
});
