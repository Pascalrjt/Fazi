/** Persisted user settings (localStorage). */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SortDir, SortKey } from "../lib/sort";

export type ViewMode = "list" | "grid";
export type Theme = "system" | "light" | "dark";
export type Density = "normal" | "compact";
export type SidebarPosition = "left" | "right";

/** A user-pinned sidebar folder (defaults live in useVolumes, not here). */
export interface FavoriteFolder {
  path: string;
  name: string;
}

/**
 * Per-command shortcut overrides: `string[]` replaces the command's bindings
 * (first entry is the primary), `null` unbinds it, absent = default.
 */
export type KeybindingOverrides = Record<string, string[] | null>;

interface SettingsState {
  // General
  showHidden: boolean;
  viewMode: ViewMode;
  sidebarCollapsed: boolean;
  defaultSortKey: SortKey;
  defaultSortDir: SortDir;
  fdaBannerDismissed: boolean;
  confirmPermanentDelete: boolean;
  confirmEmptyTrash: boolean;
  // Appearance
  theme: Theme;
  /** Custom accent CSS color; "" = the built-in accent. */
  accent: string;
  density: Density;
  /** Finder-style alternating row colors in list view and search results. */
  zebraStripes: boolean;
  /** Accent-colored line above the active pane's tab strip. */
  paneAccentLine: boolean;
  // Keyboard
  keybindingOverrides: KeybindingOverrides;
  // Search
  /** Global search starts in Contents mode (kMDItemTextContent) when true. */
  searchContentsDefault: boolean;
  /** Global-search result cap (1..=10,000; same ceiling as the fuzzy top-K). */
  searchMaxResults: number;
  /** Fuzzy-index excludes: bare name = component at any depth; with "/" =
   *  root-relative path prefix. */
  fuzzyExcludes: string[];
  /**
   * ⌘P index entry cap; 0 = no cap (the default — the index must cover the
   * whole tree, and real home dirs exceed any fixed guess). Replaces the old
   * `fuzzyIndexMaxEntries` key, whose 2M default silently truncated: old
   * persisted blobs simply lack this key and pick up the uncapped default.
   */
  fuzzyIndexEntryCap: number;
  // Operations
  /** Opt-in BLAKE3 checksum verification for copies. The mandatory
   *  cross-volume move verification is separate and always on. */
  verifyCopies: boolean;
  opCardAutoHideMs: number;
  // Sidebar
  favorites: FavoriteFolder[];
  showTrashInSidebar: boolean;
  /** Which edge of the window the sidebar docks to. */
  sidebarPosition: SidebarPosition;
  // Advanced
  /** Lazy folder sizes in list view (M7) — explicitly approximate. */
  showFolderSizes: boolean;
  /** Native drag-out (drag to Finder/Mail/…). Kill-switch: off = HTML5-only
   *  internal drag & drop, exactly the pre-drag-out behavior. */
  dragOutEnabled: boolean;
  /** Share opens the native NSSharingServicePicker instead of the built-in
   *  submenu (also the escape hatch if Apple breaks the submenu's
   *  deprecated enumeration API). */
  nativeSharePicker: boolean;

  setShowHidden(v: boolean): void;
  setViewMode(v: ViewMode): void;
  toggleSidebar(): void;
  setDefaultSort(key: SortKey, dir: SortDir): void;
  dismissFdaBanner(): void;
  setSearchContentsDefault(v: boolean): void;
  setDragOutEnabled(v: boolean): void;
  /** Generic patch used by the settings panes. */
  patch(partial: Partial<SettingsValues>): void;
  setKeybindingOverride(commandId: string, shortcuts: string[] | null): void;
  clearKeybindingOverride(commandId: string): void;
  /** Reset everything except favorites (fazi-cols lives outside this store). */
  resetToDefaults(): void;
  /**
   * Pin folders, skipping paths already pinned or matching a default sidebar
   * row (`defaultPaths`) — duplicates are skipped, never moved. `atIndex`
   * inserts the fresh items there (clamped; omitted = append). Returns how
   * many were actually added.
   */
  addFavorites(items: FavoriteFolder[], defaultPaths: string[], atIndex?: number): number;
  removeFavorite(path: string): void;
  moveFavorite(path: string, toIndex: number): void;
}

/** The persisted value shape (no functions). */
export type SettingsValues = Omit<
  SettingsState,
  | "setShowHidden"
  | "setViewMode"
  | "toggleSidebar"
  | "setDefaultSort"
  | "dismissFdaBanner"
  | "setSearchContentsDefault"
  | "setDragOutEnabled"
  | "patch"
  | "setKeybindingOverride"
  | "clearKeybindingOverride"
  | "resetToDefaults"
  | "addFavorites"
  | "removeFavorite"
  | "moveFavorite"
>;

export const SETTINGS_DEFAULTS: SettingsValues = {
  showHidden: false,
  viewMode: "list",
  sidebarCollapsed: false,
  defaultSortKey: "name",
  defaultSortDir: "asc",
  fdaBannerDismissed: false,
  confirmPermanentDelete: true,
  confirmEmptyTrash: true,
  theme: "system",
  accent: "",
  density: "normal",
  zebraStripes: true,
  paneAccentLine: true,
  keybindingOverrides: {},
  searchContentsDefault: false,
  searchMaxResults: 10_000,
  fuzzyExcludes: [".git", "node_modules", "Library/Caches", ".Trash"],
  fuzzyIndexEntryCap: 0,
  verifyCopies: false,
  opCardAutoHideMs: 4000,
  favorites: [],
  showTrashInSidebar: true,
  sidebarPosition: "left",
  showFolderSizes: false,
  dragOutEnabled: true,
  nativeSharePicker: false,
};

export const useSettings = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...SETTINGS_DEFAULTS,

      setShowHidden: (v) => set({ showHidden: v }),
      setViewMode: (v) => set({ viewMode: v }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setDefaultSort: (key, dir) => set({ defaultSortKey: key, defaultSortDir: dir }),
      dismissFdaBanner: () => set({ fdaBannerDismissed: true }),
      setSearchContentsDefault: (v) => set({ searchContentsDefault: v }),
      setDragOutEnabled: (v) => set({ dragOutEnabled: v }),
      patch: (partial) => set(partial),

      setKeybindingOverride: (commandId, shortcuts) => {
        set((s) => ({
          keybindingOverrides: { ...s.keybindingOverrides, [commandId]: shortcuts },
        }));
      },

      clearKeybindingOverride: (commandId) => {
        set((s) => {
          const next = { ...s.keybindingOverrides };
          delete next[commandId];
          return { keybindingOverrides: next };
        });
      },

      resetToDefaults: () => {
        // Favorites survive a reset (and fazi-cols lives outside this store —
        // noted in the Advanced pane copy).
        const { favorites } = get();
        set({ ...SETTINGS_DEFAULTS, favorites });
      },

      addFavorites: (items, defaultPaths, atIndex) => {
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
          set((s) => {
            // The index was captured at drop time but resolution is async
            // (statPath) — the list may have changed by now, so clamp.
            const at =
              atIndex == null
                ? s.favorites.length
                : Math.max(0, Math.min(atIndex, s.favorites.length));
            const next = [...s.favorites];
            next.splice(at, 0, ...fresh);
            return { favorites: next };
          });
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
    // bump without `migrate` would discard existing users' settings. New keys
    // are ADDITIVE with defaults only — the shallow merge on rehydrate fills
    // them for old blobs. (A vitest guard asserts no version key sneaks in.)
    { name: "fazi-settings" },
  ),
);
