/**
 * Fuzzy store streaming: results replace (never append) per queryId, events
 * for a superseded queryId are dropped, close cancels the live query, and
 * op completions under the root mark the index stale (rebuild on next open).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FuzzyEvent } from "../../types/ipc";

const mocks = vi.hoisted(() => ({
  warmCalls: [] as Array<{ root: string; force?: boolean }>,
  queryCalls: [] as Array<{
    args: { root: string; query: string; queryId: string; live: boolean };
    onEvent: (e: FuzzyEvent) => void;
  }>,
  cancelCalls: [] as string[],
}));

vi.mock("../../lib/ipc", () => ({
  fuzzyWarm: (root: string, _ex: string[], _max?: number, force?: boolean) => {
    mocks.warmCalls.push({ root, force });
    return Promise.resolve({ indexed: 10, indexing: true, capped: false, builtAtMs: 1 });
  },
  fuzzyQuery: (
    args: { root: string; query: string; queryId: string; live: boolean },
    onEvent: (e: FuzzyEvent) => void,
  ) => {
    mocks.queryCalls.push({ args, onEvent });
    return Promise.resolve();
  },
  fuzzyCancel: (queryId: string) => {
    mocks.cancelCalls.push(queryId);
    return Promise.resolve();
  },
  fuzzyDrop: () => Promise.resolve(),
  openPaths: () => Promise.resolve(),
}));

import { useFuzzy } from "../fuzzy";
import { usePanes } from "../panes";

function item(path: string) {
  return { path, name: path.split("/").pop() ?? path, isDir: false, icon: "t", score: 1 };
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/** Outwait the keystroke→query debounce (70 ms; see fuzzy-debounce.test.ts). */
async function debounce(): Promise<void> {
  await new Promise((r) => setTimeout(r, 100));
}

describe("fuzzy store", () => {
  beforeEach(() => {
    mocks.warmCalls.length = 0;
    mocks.queryCalls.length = 0;
    mocks.cancelCalls.length = 0;
    usePanes.getState().boot("/Users/me/Projects");
    useFuzzy.setState({
      open: false,
      scope: "folder",
      root: null,
      query: "",
      hits: [],
      status: "idle",
      queryId: null,
      stale: false,
      error: null,
    });
  });

  it("streams results that REPLACE per queryId and drops stale events", async () => {
    useFuzzy.getState().openFinder();
    await tick(); // warm resolves → initial query fires
    expect(mocks.warmCalls).toEqual([{ root: "/Users/me/Projects", force: false }]);
    expect(mocks.queryCalls).toHaveLength(1);
    const first = mocks.queryCalls[0];
    expect(first.args.live).toBe(true);

    first.onEvent({
      event: "results",
      queryId: first.args.queryId,
      items: [item("/a"), item("/b")],
      indexed: 100,
      indexing: true,
    });
    expect(useFuzzy.getState().hits.map((h) => h.path)).toEqual(["/a", "/b"]);

    // A refinement batch replaces, never appends.
    first.onEvent({
      event: "results",
      queryId: first.args.queryId,
      items: [item("/c")],
      indexed: 200,
      indexing: true,
    });
    expect(useFuzzy.getState().hits.map((h) => h.path)).toEqual(["/c"]);
    expect(useFuzzy.getState().indexed).toBe(200);

    // Supersede: a keystroke (after the debounce) cancels the old query…
    useFuzzy.getState().setQuery("main");
    await debounce();
    expect(mocks.cancelCalls).toEqual([first.args.queryId]);
    expect(mocks.queryCalls).toHaveLength(2);
    const second = mocks.queryCalls[1];

    // …and stale events from the OLD queryId are dropped.
    first.onEvent({
      event: "results",
      queryId: first.args.queryId,
      items: [item("/stale")],
      indexed: 300,
      indexing: true,
    });
    expect(useFuzzy.getState().hits.map((h) => h.path)).toEqual(["/c"]);

    second.onEvent({
      event: "results",
      queryId: second.args.queryId,
      items: [item("/main.rs")],
      indexed: 300,
      indexing: false,
    });
    second.onEvent({ event: "done", queryId: second.args.queryId, capped: true });
    expect(useFuzzy.getState().hits.map((h) => h.path)).toEqual(["/main.rs"]);
    expect(useFuzzy.getState().status).toBe("done");
    expect(useFuzzy.getState().capped).toBe(true);
  });

  it("close cancels the in-flight query", async () => {
    useFuzzy.getState().openFinder();
    await tick();
    const qid = mocks.queryCalls[0].args.queryId;
    useFuzzy.getState().close();
    expect(mocks.cancelCalls).toContain(qid);
    expect(useFuzzy.getState().open).toBe(false);
    expect(useFuzzy.getState().hits).toEqual([]);
  });

  it("op completions under the root mark stale; next open rebuilds (force)", async () => {
    useFuzzy.getState().openFinder();
    await tick();
    useFuzzy.getState().close();

    useFuzzy.getState().markStaleIfUnder(["/Users/me/Projects/newfile.txt"]);
    expect(useFuzzy.getState().stale).toBe(true);
    // Paths outside the root never mark stale.
    useFuzzy.setState({ stale: false });
    useFuzzy.getState().markStaleIfUnder(["/elsewhere/x"]);
    expect(useFuzzy.getState().stale).toBe(false);

    useFuzzy.setState({ stale: true });
    useFuzzy.getState().openFinder();
    await tick();
    expect(mocks.warmCalls[mocks.warmCalls.length - 1].force).toBe(true);
    expect(useFuzzy.getState().stale).toBe(false);
  });
});
