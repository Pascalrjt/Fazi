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

  refresh(): Promise<void>;
  loadFolders(): Promise<DefaultFolders | null>;
  /** Subscribe to mount/unmount broadcasts. Returns unsubscribe. */
  init(): Promise<() => void>;
}

export const useVolumes = create<VolumesState>()((set, get) => ({
  volumes: [],
  folders: null,
  loaded: false,
  error: null,

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
