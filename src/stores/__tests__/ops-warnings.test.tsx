/**
 * Guards the silent-removal regression for success-with-warnings ops: a fast
 * op that finishes before the 250ms visibility delay is normally removed
 * silently — but if it carries warnings (e.g. "couldn't trash the old
 * original"), the card must be forced visible and never auto-dismissed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { OpEvent } from "../../types/ipc";

const mocks = vi.hoisted(() => ({
  captured: { cb: null as ((e: OpEvent) => void) | null },
}));

// ops.ts imports "../lib/ipc" → from this test dir that module is "../../lib/ipc".
vi.mock("../../lib/ipc", () => ({
  runOp: (_args: unknown, onEvent: (e: OpEvent) => void) => {
    mocks.captured.cb = onEvent;
    return Promise.resolve();
  },
  duplicatePaths: () => Promise.resolve(),
  cancelOp: () => Promise.resolve(),
  respondConflict: () => Promise.resolve(),
  undoLast: () => Promise.resolve(null),
  redoLast: () => Promise.resolve(null),
  downloadIcloud: () => Promise.resolve(),
}));

import { useOps } from "../ops";
import { OpCards } from "../../components/ops/OpCards";

describe("success with warnings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.captured.cb = null;
    useOps.setState({ cards: [], conflicts: [] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("keeps the card visible and shows the warning, with no auto-dismiss", () => {
    const opId = useOps.getState().startOp({
      kind: "move",
      sources: ["/from/doc.txt"],
      destDir: "/to",
    });
    expect(mocks.captured.cb).toBeTruthy();
    const emit = mocks.captured.cb!;

    emit({ event: "started", opId });
    // Done arrives BEFORE the 250ms visibility delay — the exact scenario
    // where a clean success would be silently removed.
    emit({
      event: "done",
      status: "success",
      errors: [],
      warnings: [
        {
          path: "/from/doc.txt",
          message: "Replaced, but the previous version couldn't be moved to the Trash.",
          severity: "warning",
        },
      ],
      skippedIcloud: [],
      produced: [],
      undoable: false,
    });

    let card = useOps.getState().cards.find((c) => c.opId === opId);
    expect(card).toBeTruthy();
    expect(card!.visible).toBe(true);
    expect(card!.warnings).toHaveLength(1);

    // Advance well past the visibility delay AND the success auto-dismiss:
    // a warned card must persist.
    vi.advanceTimersByTime(10_000);
    card = useOps.getState().cards.find((c) => c.opId === opId);
    expect(card).toBeTruthy();
    expect(card!.visible).toBe(true);

    render(<OpCards />);
    expect(
      screen.getByText(/previous version couldn't be moved to the Trash/),
    ).toBeTruthy();
    // The bare "Done" line must not sit above the warning claiming a clean finish.
    expect(screen.queryByText("Done")).toBeNull();
  });
});
