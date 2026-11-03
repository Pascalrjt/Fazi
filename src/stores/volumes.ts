/** Volumes + default folders, refreshed on the volumesChanged broadcast. */
import { create } from "zustand";
import type { DefaultFolders, Volume } from "../types/ipc";
import * as ipc from "../lib/ipc";

interface VolumesState {
  volumes: Volume[];
  folders: DefaultFolders | null;
  loaded: boolean;
  /** Non-null when the backend is unreachable (dev without Tauri). */
  error: string | null;
  /** Mount paths with an eject in flight (sidebar spinner, double-click guard). */
  ejecting: string[];

  setEjecting(path: string, on: boolean): void;

  refresh(): Promise<void>;
  loadFolders(): Promise<DefaultFolders | null>;
  /** Subscribe to mount/unmount broadcasts. Returns unsubscribe. */
  init(): Promise<() => void>;
}

/** How long after a successful eject its tabs' "no longer available"
 *  notices stay suppressed (the watcher's rootGone can trail the eject). */
const EJECTED_GRACE_MS = 5_000;
const recentlyEjected = new Map<string, ReturnType<typeof setTimeout>>();

/** Record a successful user-initiated eject of `path`. */
export function markEjected(path: string): void {
  clearTimeout(recentlyEjected.get(path));
  recentlyEjected.set(
    path,
    setTimeout(() => recentlyEjected.delete(path), EJECTED_GRACE_MS),
  );
}

/** Whether `path` is on a volume the user is ejecting or just ejected — its
 *  disappearance is expected, so it needs no notice of its own. */
export function ejectedByUser(path: string): boolean {
  const roots = [...useVolumes.getState().ejecting, ...recentlyEjected.keys()];
  return roots.some((r) => path === r || path.startsWith(`${r}/`));
}

export const useVolumes = create<VolumesState>()((set, get) => ({
  volumes: [],
  folders: null,
  loaded: false,
  error: null,
  ejecting: [],

  setEjecting: (path, on) =>
    set((s) => ({
      ejecting: on
        ? s.ejecting.includes(path)
          ? s.ejecting
          : [...s.ejecting, path]
        : s.ejecting.filter((p) => p !== path),
    })),

  refresh: async () => {
    try {
      const volumes = await ipc.listVolumes();
      set({ volumes, loaded: true, error: null });
    } catch (err) {
      set({ loaded: true, error: String(err) });
    }
  },

  loadFolders: async () => {
    try {
      const folders = await ipc.defaultFolders();
      set({ folders, error: null });
      return folders;
    } catch (err) {
      set({ error: String(err) });
      return null;
    }
  },

  init: async () => {
    await Promise.all([get().refresh(), get().loadFolders()]);
    try {
      const unlisten = await ipc.onVolumesChanged(() => {
        void get().refresh();
      });
      return unlisten;
    } catch {
      return () => {};
    }
  },
}));
