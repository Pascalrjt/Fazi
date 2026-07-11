/**
 * setQuery debounce: mid-word keystrokes must coalesce into ONE backend
 * query (each query cancels its predecessor, so unthrottled keystrokes cause
 * cancel/scan churn while the index builds).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queries: [] as { query: string; queryId: string }[],
  cancelled: [] as string[],
}));

vi.mock("../../lib/ipc", () => ({
  fuzzyWarm: () =>
    Promise.resolve({ indexed: 1, indexing: false, capped: false, builtAtMs: 1 }),
  fuzzyQuery: (args: { query: string; queryId: string }) => {
    mocks.queries.push({ query: args.query, queryId: args.queryId });
    return Promise.resolve();
  },
  fuzzyCancel: (queryId: string) => {
    mocks.cancelled.push(queryId);
    return Promise.resolve();
  },
  fuzzyDrop: () => Promise.resolve(),
}));

import { useFuzzy } from "../fuzzy";

describe("fuzzy store query debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.queries.length = 0;
    mocks.cancelled.length = 0;
    useFuzzy.setState({
      open: true,
      scope: "folder",
      root: "/Users/me",
      query: "",
      hits: [],
      status: "idle",
      queryId: null,
      error: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces rapid keystrokes into a single query", () => {
    useFuzzy.getState().setQuery("n");
    useFuzzy.getState().setQuery("no");
    useFuzzy.getState().setQuery("not");
    expect(mocks.queries).toHaveLength(0); // nothing until the debounce fires
    vi.advanceTimersByTime(200);
    expect(mocks.queries).toHaveLength(1);
    expect(mocks.queries[0].query).toBe("not");
    expect(useFuzzy.getState().query).toBe("not"); // input state is immediate
  });

  it("separate words trigger separate queries, cancelling the predecessor", () => {
    useFuzzy.getState().setQuery("alpha");
    vi.advanceTimersByTime(200);
    useFuzzy.getState().setQuery("beta");
    vi.advanceTimersByTime(200);
    expect(mocks.queries.map((q) => q.query)).toEqual(["alpha", "beta"]);
    expect(mocks.cancelled).toEqual([mocks.queries[0].queryId]);
  });

  it("close() drops a pending debounced query", () => {
    useFuzzy.getState().setQuery("nev");
    useFuzzy.getState().close();
    vi.advanceTimersByTime(200);
    expect(mocks.queries).toHaveLength(0);
  });
});
