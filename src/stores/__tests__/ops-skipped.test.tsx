import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { OpEvent } from "../../types/ipc";

const mocks = vi.hoisted(() => ({
  callback: null as ((event: OpEvent) => void) | null,
}));

vi.mock("../../lib/ipc", () => ({
  runOp: (_args: unknown, callback: (event: OpEvent) => void) => {
    mocks.callback = callback;
    return Promise.resolve();
  },
  duplicatePaths: () => Promise.resolve(),
  compressPaths: () => Promise.resolve(),
  extractPaths: () => Promise.resolve(),
  cancelOp: () => Promise.resolve(),
  respondConflict: () => Promise.resolve(),
  undoLast: () => Promise.resolve(null),
  redoLast: () => Promise.resolve(null),
}));

import { OpCards } from "../../components/ops/OpCards";
import { useOps } from "../ops";

describe("skipped operation summaries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.callback = null;
    useOps.setState({ cards: [], conflicts: [] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("reports an all-skipped copy without claiming anything was copied", () => {
    const opId = useOps.getState().startOp({
      kind: "copy",
      sources: ["/source/report.txt"],
      destDir: "/destination",
    });
    vi.advanceTimersByTime(300);
    mocks.callback!({ event: "started", opId });
    mocks.callback!({
      event: "done",
      status: "success",
      errors: [],
      warnings: [],
      produced: [],
      skipped: 1,
      undoable: false,
    });

    render(<OpCards />);
    expect(screen.getByText("Skipped 1 item")).toBeTruthy();
    expect(screen.getByText("No files changed")).toBeTruthy();
    expect(screen.queryByText(/Copied 1 item/)).toBeNull();
  });

  it("reports completed and skipped counts for a mixed result", () => {
    useOps.getState().startOp({
      kind: "copy",
      sources: ["/source/a", "/source/b", "/source/c"],
      destDir: "/destination",
    });
    vi.advanceTimersByTime(300);
    mocks.callback!({
      event: "done",
      status: "success",
      errors: [],
      warnings: [],
      produced: ["/destination/a", "/destination/b"],
      skipped: 1,
      undoable: true,
    });

    render(<OpCards />);
    expect(screen.getByText("Copied 2 items, skipped 1")).toBeTruthy();
  });
});
