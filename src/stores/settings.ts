/** Persisted user settings (localStorage). */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SortDir, SortKey } from "../lib/sort";

export type ViewMode = "list" | "grid";

/** A user-pinned sidebar folder (defaults live in useVolumes, not here). */
export interface FavoriteFolder {
  path: string;
  name: string;
}

interface SettingsState {
  showHidden: boolean;
  viewMode: ViewMode;
  sidebarCollapsed: boolean;
  defaultSortKey: SortKey;
  defaultSortDir: SortDir;
  fdaBannerDismissed: boolean;
  favorites: FavoriteFolder[];
  /** Global search starts in Contents mode (kMDItemTextContent) when true. */
  searchContentsDefault: boolean;
  /** Native drag-out (drag to Finder/Mail/…). Kill-switch: off = HTML5-only
   *  internal drag & drop, exactly the pre-drag-out behavior. */
  dragOutEnabled: boolean;

  setShowHidden(v: boolean): void;
  setSearchContentsDefault(v: boolean): void;
  setDragOutEnabled(v: boolean): void;
  setViewMode(v: ViewMode): void;
  toggleSidebar(): void;
  setDefaultSort(key: SortKey, dir: SortDir): void;
  dismissFdaBanner(): void;
  /**
   * Pin folders, skipping paths already pinned or matching a default sidebar
   * row (`defaultPaths`). Returns how many were actually added.
   */
  addFavorites(items: FavoriteFolder[], defaultPaths: string[]): number;
  removeFavorite(path: string): void;
  moveFavorite(path: string, toIndex: number): void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set, get) => ({
      showHidden: false,
      viewMode: "list",
      sidebarCollapsed: false,
      defaultSortKey: "name",
      defaultSortDir: "asc",
      fdaBannerDismissed: false,
      favorites: [],
      searchContentsDefault: false,
      dragOutEnabled: true,

      setShowHidden: (v) => set({ showHidden: v }),
      setSearchContentsDefault: (v) => set({ searchContentsDefault: v }),
      setDragOutEnabled: (v) => set({ dragOutEnabled: v }),
      setViewMode: (v) => set({ viewMode: v }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setDefaultSort: (key, dir) => set({ defaultSortKey: key, defaultSortDir: dir }),
      dismissFdaBanner: () => set({ fdaBannerDismissed: true }),

      addFavorites: (items, defaultPaths) => {
        const taken = new Set([
          ...get().favorites.map((f) => f.path),
          ...defaultPaths,
        ]);
        const fresh: FavoriteFolder[] = [];
        for (const item of items) {
          if (taken.has(item.path)) continue;
          taken.add(item.path);
          fresh.push(item);
        }
        if (fresh.length > 0) {
          set((s) => ({ favorites: [...s.favorites, ...fresh] }));
        }
        return fresh.length;
      },

      removeFavorite: (path) => {
        set((s) => ({ favorites: s.favorites.filter((f) => f.path !== path) }));
      },

      moveFavorite: (path, toIndex) => {
        set((s) => {
          const from = s.favorites.findIndex((f) => f.path === path);
          if (from === -1) return s;
          const next = [...s.favorites];
          const [item] = next.splice(from, 1);
          // toIndex is an insertion index into the pre-removal array.
          const target = from < toIndex ? toIndex - 1 : toIndex;
          const clamped = Math.max(0, Math.min(target, next.length));
          next.splice(clamped, 0, item);
          return { favorites: next };
        });
      },
    }),
    // NO version bump: the store persists at implicit version 0 today, and a
    // bump without `migrate` would discard existing users' settings. The
    // shallow merge on rehydrate fills `favorites: []` for old blobs.
    { name: "fazi-settings" },
  ),
);
