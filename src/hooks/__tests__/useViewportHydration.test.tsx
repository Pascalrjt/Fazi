/**
 * useViewportHydration: only unhydrated rows in range are requested (after
 * the 100 ms debounce), and a range change cancels the pending debounce.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { Entry } from "../../types/ipc";

const mocks = vi.hoisted(() => ({
  requests: [] as Array<{ listingId: string; ids: number[] }>,
}));

vi.mock("../../lib/hydration", () => ({
  requestViewportHydration: (listingId: string, ids: number[]) => {
    mocks.requests.push({ listingId, ids });
  },
}));

import { useViewportHydration } from "../useViewportHydration";

function entry(id: number, hydrated: boolean): Entry {
  return {
    id,
    name: `f${id}`,
    path: `/d/f${id}`,
    kind: "file",
    hidden: false,
    icon: "t",
    ext: "",
    hydrated,
    size: null,
    mtime: null,
    btime: null,
    isPackage: false,
    isAlias: false,
    linkTarget: null,
    tags: [],
    noAccess: false,
  };
}

function Probe({
  listingId,
  visible,
  first,
  last,
}: {
  listingId: string;
  visible: Entry[];
  first: number;
  last: number;
}) {
  useViewportHydration(listingId, visible, first, last);
  return null;
}

describe("useViewportHydration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.requests.length = 0;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("requests only the unhydrated rows inside the visible range", () => {
    const rows = [entry(0, true), entry(1, false), entry(2, false), entry(3, false)];
    render(<Probe listingId="L1" visible={rows} first={0} last={2} />);
    expect(mocks.requests).toHaveLength(0); // debounced
    vi.advanceTimersByTime(120);
    expect(mocks.requests).toEqual([{ listingId: "L1", ids: [1, 2] }]); // 3 is out of range, 0 hydrated
  });

  it("a range change cancels the pending debounce", () => {
    const rows = Array.from({ length: 50 }, (_, i) => entry(i, false));
    const { rerender } = render(<Probe listingId="L1" visible={rows} first={0} last={5} />);
    vi.advanceTimersByTime(50); // not yet fired
    rerender(<Probe listingId="L1" visible={rows} first={30} last={35} />);
    vi.advanceTimersByTime(120);
    // Only the NEW range fired — the flicked-past range never requested.
    expect(mocks.requests).toHaveLength(1);
    expect(mocks.requests[0].ids).toEqual([30, 31, 32, 33, 34, 35]);
  });
});
