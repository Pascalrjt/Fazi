/**
 * Every toast dismisses itself. Ones with a button get longer, and hovering
 * holds a toast until the pointer leaves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useApp } from "../app";

const messages = () => useApp.getState().toasts.map((t) => t.message);

describe("toasts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useApp.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dismisses a plain toast after 5 s", () => {
    useApp.getState().pushToast("Copied");
    expect(useApp.getState().toasts[0].countdown).toEqual({ from: 1, ms: 5_000, held: false });
    vi.advanceTimersByTime(4_999);
    expect(messages()).toEqual(["Copied"]);
    vi.advanceTimersByTime(1);
    expect(messages()).toEqual([]);
  });

  it("gives a toast with a button 10 s", () => {
    useApp.getState().pushToast("Moved 2 items to Trash", { action: { label: "Put Back", run: () => {} } });
    vi.advanceTimersByTime(9_999);
    expect(messages()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(messages()).toEqual([]);
  });

  it("holds while hovered and resumes the time left on leave", () => {
    useApp.getState().pushToast("Copied");
    const id = useApp.getState().toasts[0].id;
    vi.advanceTimersByTime(1_000);
    useApp.getState().holdToast(id);
    expect(useApp.getState().toasts[0].countdown).toEqual({ from: 0.8, ms: 4_000, held: true });
    vi.advanceTimersByTime(60_000);
    expect(messages()).toEqual(["Copied"]);
    useApp.getState().releaseToast(id);
    expect(useApp.getState().toasts[0].countdown).toEqual({ from: 0.8, ms: 4_000, held: false });
    vi.advanceTimersByTime(3_999);
    expect(messages()).toEqual(["Copied"]);
    vi.advanceTimersByTime(1);
    expect(messages()).toEqual([]);
  });

  it("leaves at least 2 s after the pointer leaves", () => {
    useApp.getState().pushToast("Copied");
    const id = useApp.getState().toasts[0].id;
    vi.advanceTimersByTime(4_900);
    useApp.getState().holdToast(id);
    useApp.getState().releaseToast(id);
    vi.advanceTimersByTime(1_999);
    expect(messages()).toEqual(["Copied"]);
    vi.advanceTimersByTime(1);
    expect(messages()).toEqual([]);
  });
});
