import { create } from "zustand";
import * as ipc from "../lib/ipc";
import type { CleanupItem, CleanupSnapshot } from "../lib/downloadsCleanup";
interface State {
  snapshot: CleanupSnapshot | null;
  items: Record<string, CleanupItem>;
  now: number;
  error: string | null;
  accept(snapshot: CleanupSnapshot): void;
  refresh(): Promise<void>;
  itemAction(
    item: CleanupItem,
    action: "keep" | "resume" | "extend",
    days?: number,
  ): Promise<void>;
  restore(id: string): Promise<void>;
}
let generation = 0;
export const useDownloadsCleanup = create<State>((set, get) => ({
  snapshot: null,
  items: {},
  now: Date.now(),
  error: null,
  accept: (snapshot) => {
    generation++;
    set({
      snapshot,
      items: Object.fromEntries(snapshot.items.map((i) => [i.path, i])),
      now: Date.now(),
      error: snapshot.error,
    });
  },
  refresh: async () => {
    const ticket = ++generation;
    try {
      const snapshot = await ipc.downloadsCleanupStatus();
      if (ticket === generation) get().accept(snapshot);
    } catch (e) {
      if (ticket === generation) set({ error: String(e), now: Date.now() });
    }
  },
  itemAction: async (item, action, days = 7) => {
    generation++;
    get().accept(
      await ipc.downloadsCleanupItem(item.path, item.identity, action, days),
    );
  },
  restore: async (id) => {
    generation++;
    get().accept(await ipc.downloadsCleanupRestore(id));
  },
}));
export function startDownloadsCleanupUpdates(): () => void {
  void useDownloadsCleanup.getState().refresh();
  const timer = window.setInterval(
    () => void useDownloadsCleanup.getState().refresh(),
    60_000,
  );
  const focus = () => void useDownloadsCleanup.getState().refresh();
  window.addEventListener("focus", focus);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("focus", focus);
  };
}
