/** Persisted user settings (localStorage). */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SortDir, SortKey } from "../lib/sort";

export type ViewMode = "list" | "grid";

interface SettingsState {
  showHidden: boolean;
  viewMode: ViewMode;
  sidebarCollapsed: boolean;
  defaultSortKey: SortKey;
  defaultSortDir: SortDir;
  fdaBannerDismissed: boolean;

  setShowHidden(v: boolean): void;
  setViewMode(v: ViewMode): void;
  toggleSidebar(): void;
  setDefaultSort(key: SortKey, dir: SortDir): void;
  dismissFdaBanner(): void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      showHidden: false,
      viewMode: "list",
      sidebarCollapsed: false,
      defaultSortKey: "name",
      defaultSortDir: "asc",
      fdaBannerDismissed: false,

      setShowHidden: (v) => set({ showHidden: v }),
      setViewMode: (v) => set({ viewMode: v }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setDefaultSort: (key, dir) => set({ defaultSortKey: key, defaultSortDir: dir }),
      dismissFdaBanner: () => set({ fdaBannerDismissed: true }),
    }),
    { name: "fazi-settings" },
  ),
);
