/**
 * dirSizes: streamed dir_size results land in the cache, concurrency is
 * capped at 2, and ancestor-directed invalidation drops exactly the cached
 * dirs containing a changed path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirSizeEvent } from "../../types/ipc";

const mocks = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; onEvent: (e: DirSizeEvent) => void }>,
}));

vi.mock("../../lib/ipc", () => ({
  dirSize: (path: string, onEvent: (e: DirSizeEvent) => void) => {
    mocks.calls.push({ path, onEvent });
    return new Promise(() => {}); // stays pending; events drive completion
  },
}));

import { useDirSizes } from "../dirSizes";

describe("dirSizes store", () => {
  beforeEach(() => {
    mocks.calls.length = 0;
    useDirSizes.getState().clear();
  });

  it("computes via the dir_size channel and caches the final value", () => {
    useDirSizes.getState().request("/a");
    expect(mocks.calls.map((c) => c.path)).toEqual(["/a"]);
    mocks.calls[0].onEvent({ bytes: 100, entries: 5, done: false });
    expect(useDirSizes.getState().sizes["/a"].bytes).toBe(100);
    expect(useDirSizes.getState().sizes["/a"].computing).toBe(true);
    mocks.calls[0].onEvent({ bytes: 250, entries: 12, done: true });
    const entry = useDirSizes.getState().sizes["/a"];
    expect(entry.bytes).toBe(250);
    expect(entry.computing).toBe(false);
    // Fresh within TTL → a re-request is a no-op.
    useDirSizes.getState().request("/a");
    expect(mocks.calls).toHaveLength(1);
  });

  it("caps concurrency at 2 and drains the queue as computes finish", () => {
    const s = useDirSizes.getState();
    s.request("/a");
    s.request("/b");
    s.request("/c");
    s.request("/d");
    expect(mocks.calls.map((c) => c.path)).toEqual(["/a", "/b"]);
    mocks.calls[0].onEvent({ bytes: 1, entries: 1, done: true });
    expect(mocks.calls.map((c) => c.path)).toEqual(["/a", "/b", "/c"]);
    mocks.calls[1].onEvent({ bytes: 2, entries: 1, done: true });
    mocks.calls[2].onEvent({ bytes: 3, entries: 1, done: true });
    expect(mocks.calls.map((c) => c.path)).toEqual(["/a", "/b", "/c", "/d"]);
  });

  it("invalidation drops ancestors of the changed path (and the path itself)", () => {
    const s = useDirSizes.getState();
    for (const p of ["/root", "/root/sub", "/other"]) {
      s.request(p);
      const call = mocks.calls[mocks.calls.length - 1];
      // /other queues past the cap; flush in order.
      if (call && call.path === p) call.onEvent({ bytes: 9, entries: 1, done: true });
    }
    // Ensure all three completed (drain any queued call).
    for (const c of mocks.calls) {
      if (useDirSizes.getState().sizes[c.path]?.computing) {
        c.onEvent({ bytes: 9, entries: 1, done: true });
      }
    }
    expect(Object.keys(useDirSizes.getState().sizes).sort()).toEqual([
      "/other",
      "/root",
      "/root/sub",
    ]);

    // A file changed deep under /root/sub: /root AND /root/sub contain it.
    useDirSizes.getState().invalidate(["/root/sub/deep/file.txt"]);
    expect(Object.keys(useDirSizes.getState().sizes).sort()).toEqual(["/other"]);
  });
});
