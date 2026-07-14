/**
 * Cut-dim staleness: recheckCutMirror clears the frontend clipboard mirror
 * only when the backend reports the pasteboard has moved on — never on IPC
 * failure, never for copy mirrors.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pbCutValidImpl: (() => Promise.resolve(true)) as () => Promise<boolean>,
}));

vi.mock("../ipc", () => ({
  pbCutValid: () => mocks.pbCutValidImpl(),
  runOp: () => Promise.resolve(),
  trashPaths: () => Promise.resolve(),
  cancelOp: () => Promise.resolve(),
  undoLast: () => Promise.resolve(null),
  redoLast: () => Promise.resolve(null),
}));

import { recheckCutMirror } from "../actions";
import { useApp } from "../../stores/app";

describe("recheckCutMirror", () => {
  beforeEach(() => {
    useApp.getState().setClipboard(null);
  });

  it("clears a cut mirror when the pasteboard moved on", async () => {
    mocks.pbCutValidImpl = () => Promise.resolve(false);
    useApp.getState().setClipboard({ mode: "cut", paths: ["/a"] });
    await recheckCutMirror();
    expect(useApp.getState().clipboard).toBeNull();
  });

  it("keeps a still-valid cut mirror", async () => {
    mocks.pbCutValidImpl = () => Promise.resolve(true);
    useApp.getState().setClipboard({ mode: "cut", paths: ["/a"] });
    await recheckCutMirror();
    expect(useApp.getState().clipboard).toEqual({ mode: "cut", paths: ["/a"] });
  });

  it("keeps the mirror on IPC failure (stale beats flicker)", async () => {
    mocks.pbCutValidImpl = () => Promise.reject(new Error("no backend"));
    useApp.getState().setClipboard({ mode: "cut", paths: ["/a"] });
    await recheckCutMirror();
    expect(useApp.getState().clipboard).toEqual({ mode: "cut", paths: ["/a"] });
  });

  it("never touches a copy mirror or an empty one", async () => {
    let called = 0;
    mocks.pbCutValidImpl = () => {
      called += 1;
      return Promise.resolve(false);
    };
    useApp.getState().setClipboard({ mode: "copy", paths: ["/a"] });
    await recheckCutMirror();
    expect(useApp.getState().clipboard).toEqual({ mode: "copy", paths: ["/a"] });
    useApp.getState().setClipboard(null);
    await recheckCutMirror();
    expect(called).toBe(0); // the backend is never even asked
  });
});
