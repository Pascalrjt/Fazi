/**
 * All Fazi commands, registered at boot (and re-registered when keybinding
 * overrides change). Single source of truth for keyboard shortcuts AND the
 * command palette.
 */
import {
  clearRegistry,
  findShortcutConflicts,
  registerCommands,
  type CommandSpec,
  type RegisteredCommand,
} from "./registry";
import { parseShortcut } from "../keyboard";
import type { KeybindingOverrides } from "../../stores/settings";
import {
  arrowMove,
  shiftArrowExtend,
} from "../selection";
import * as actions from "../actions";
import { isExtractableArchive } from "../fileTypes";
import { useApp } from "../../stores/app";
import { activePaneTab, selectedEntries, usePanes, visibleEntries } from "../../stores/panes";
import { useFuzzy } from "../../stores/fuzzy";
import { useOps } from "../../stores/ops";
import { useSettings } from "../../stores/settings";
import { useVolumes } from "../../stores/volumes";

let registered = false;

/** GridView reports its column count so arrow keys can move by row. */
export let gridColumns = 1;
export function setGridColumns(n: number): void {
  gridColumns = Math.max(1, n);
}

function moveLead(delta: 1 | -1, extend: boolean, stride = 1): void {
  const at = activePaneTab();
  if (!at) return;
  const { pane, tab } = at;
  const order = visibleEntries(tab).map((e) => e.id);
  let next = tab.selection;
  for (let i = 0; i < stride; i++) {
    next = extend ? shiftArrowExtend(next, order, delta) : arrowMove(next, order, delta);
  }
  usePanes.getState().setSelection(pane.id, tab.id, next);
}

function isGrid(): boolean {
  return useSettings.getState().viewMode === "grid";
}

function hasSelection(): boolean {
  return selectedEntries().length > 0;
}

/**
 * Drop invalid overrides before they reach registration: unknown commandIds,
 * non-array/non-null values, and unparseable shortcut strings all fall away —
 * corrupt localStorage must never prevent startup.
 */
export function sanitizeOverrides(raw: unknown): KeybindingOverrides {
  const out: KeybindingOverrides = {};
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return out;
  const known = new Set(buildCommandSpecs().map((c) => c.id));
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(id)) continue;
    if (value === null) {
      out[id] = null; // explicit unbind
      continue;
    }
    if (Array.isArray(value)) {
      const valid = value.filter(
        (v): v is string => typeof v === "string" && parseShortcut(v) !== null,
      );
      if (valid.length > 0) out[id] = valid;
    }
  }
  return out;
}

/** Apply overrides to specs BEFORE registration parses them — palette
 *  labels, menus, and dispatch all read the same spec. */
function applyOverrides(
  specs: CommandSpec[],
  overrides: KeybindingOverrides,
): CommandSpec[] {
  return specs.map((spec) => {
    if (!(spec.id in overrides)) return spec;
    const o = overrides[spec.id];
    if (o === null) return { ...spec, shortcut: undefined, extraShortcuts: undefined };
    return { ...spec, shortcut: o[0], extraShortcuts: o.slice(1) };
  });
}

/** Prospective conflict check for the keybindings editor — never touches the
 *  live registry. */
export function conflictsForOverrides(overrides: KeybindingOverrides): string[] {
  const specs = applyOverrides(buildCommandSpecs(), sanitizeOverrides(overrides));
  const prospective = specs.map((spec) => {
    const shortcuts = [
      ...(spec.shortcut ? [spec.shortcut] : []),
      ...(spec.extraShortcuts ?? []),
    ];
    return {
      ...spec,
      contexts: spec.context ?? ["browse"],
      bindings: shortcuts
        .map(parseShortcut)
        .filter((b): b is NonNullable<typeof b> => b !== null),
    } as RegisteredCommand;
  });
  return findShortcutConflicts(prospective);
}

export function registerAllCommands(overrides?: KeybindingOverrides): void {
  if (registered) return;
  registered = true;
  const sanitized = sanitizeOverrides(overrides ?? {});
  registerCommands(applyOverrides(buildCommandSpecs(), sanitized));
}

/**
 * Tear down and re-register with new overrides. `clearRegistry()` alone only
 * empties the array — the module-level `registered` guard MUST also reset or
 * override changes silently no-op. Safe to run at any time: command `run`
 * closures resolve state via getState().
 */
export function rebuildRegistry(overrides?: KeybindingOverrides): void {
  registered = false;
  clearRegistry();
  try {
    registerAllCommands(overrides);
  } catch {
    // Corrupt overrides must never prevent startup — fall back to defaults.
    registered = false;
    clearRegistry();
    registerAllCommands();
  }
}

function buildCommandSpecs(): CommandSpec[] {
  return [
    // -----------------------------------------------------------------------
    // Open / navigate
    // -----------------------------------------------------------------------
    {
      id: "open",
      title: "Open",
      keywords: "launch enter",
      shortcut: "cmd+down",
      extraShortcuts: ["cmd+o"],
      enabled: hasSelection,
      run: () => actions.openSelection(),
    },
    {
      id: "openWith",
      title: "Open With…",
      keywords: "application app choose",
      enabled: hasSelection,
      run: () => actions.showOpenWithMenuAtCenter(),
    },
    {
      id: "share",
      title: "Share…",
      keywords: "airdrop send mail messages",
      shortcut: "cmd+shift+s",
      enabled: hasSelection,
      run: () => actions.showShareMenuAtCenter(),
    },
    {
      id: "up",
      title: "Enclosing Folder",
      keywords: "parent up folder",
      shortcut: "cmd+up",
      run: () => {
        const at = activePaneTab();
        if (at) usePanes.getState().up(at.pane.id, at.tab.id);
      },
    },
    {
      id: "back",
      title: "Back",
      shortcut: "cmd+[",
      extraShortcuts: ["cmd+left"],
      run: () => {
        const at = activePaneTab();
        if (at) usePanes.getState().back(at.pane.id, at.tab.id);
      },
    },
    {
      id: "forward",
      title: "Forward",
      shortcut: "cmd+]",
      extraShortcuts: ["cmd+right"],
      run: () => {
        const at = activePaneTab();
        if (at) usePanes.getState().forward(at.pane.id, at.tab.id);
      },
    },
    {
      id: "goHome",
      title: "Go to Home",
      keywords: "go home folder ~",
      shortcut: "cmd+shift+h",
      run: () => actions.goToFolder("home"),
    },
    {
      id: "goDesktop",
      title: "Go to Desktop",
      keywords: "go desktop",
      run: () => actions.goToFolder("desktop"),
    },
    {
      id: "goDownloads",
      title: "Go to Downloads",
      keywords: "go downloads",
      shortcut: "cmd+opt+l",
      run: () => actions.goToFolder("downloads"),
    },
    {
      id: "goApplications",
      title: "Go to Applications",
      keywords: "go applications apps",
      shortcut: "cmd+shift+a",
      run: () => actions.goToFolder("applications"),
    },
    {
      id: "goDocuments",
      title: "Go to Documents",
      keywords: "go documents",
      run: () => actions.goToFolder("documents"),
    },
    {
      id: "openLocation",
      title: "Go to Folder…",
      keywords: "path location edit go",
      shortcut: "cmd+shift+g",
      context: ["browse", "search"],
      run: () => useApp.getState().setPathBarEditing(true),
    },
    {
      id: "revealInFinder",
      title: "Reveal in Finder",
      keywords: "show finder",
      run: () => {
        const entries = selectedEntries();
        const at = activePaneTab();
        actions.revealPaths(
          entries.length > 0 ? entries.map((e) => e.path) : at ? [at.tab.path] : [],
        );
      },
    },

    // -----------------------------------------------------------------------
    // File ops
    // -----------------------------------------------------------------------
    {
      id: "newFolder",
      title: "New Folder",
      keywords: "create directory mkdir",
      shortcut: "cmd+shift+n",
      run: () => actions.newFolderInActive(),
    },
    {
      id: "rename",
      title: "Rename",
      shortcut: "enter",
      enabled: hasSelection,
      run: () => actions.startRenameSelected(),
    },
    {
      id: "batchRename",
      title: "Rename Multiple Items…",
      keywords: "batch rename regex numbering",
      shortcut: "cmd+shift+r",
      enabled: () => selectedEntries().length > 1,
      run: () => useApp.getState().setBatchRenameOpen(true),
    },
    {
      id: "trash",
      title: "Move to Trash",
      keywords: "delete remove",
      shortcut: "cmd+delete",
      enabled: hasSelection,
      run: () => actions.trashSelection(),
    },
    {
      id: "deletePermanent",
      title: "Delete Immediately…",
      keywords: "delete permanent remove force",
      shortcut: "cmd+opt+delete",
      enabled: hasSelection,
      run: () => actions.deleteSelectionPermanently(),
    },
    {
      id: "emptyTrash",
      title: "Empty Trash…",
      keywords: "trash empty delete purge",
      shortcut: "cmd+shift+delete",
      run: () => actions.confirmEmptyTrash(),
    },
    {
      id: "goTrash",
      title: "Go to Trash",
      keywords: "go trash bin",
      run: () => actions.goTo(useVolumes.getState().folders?.trash),
    },
    {
      id: "copy",
      title: "Copy",
      shortcut: "cmd+c",
      enabled: hasSelection,
      run: () => actions.copySelection(),
    },
    {
      id: "cut",
      title: "Cut",
      shortcut: "cmd+x",
      enabled: hasSelection,
      run: () => actions.cutSelection(),
    },
    {
      id: "paste",
      title: "Paste",
      shortcut: "cmd+v",
      run: () => actions.pasteIntoActive(false),
    },
    {
      id: "movePaste",
      title: "Move Items Here",
      keywords: "paste move",
      shortcut: "cmd+opt+v",
      run: () => actions.pasteIntoActive(true),
    },
    {
      id: "copyPathname",
      title: "Copy as Pathname",
      keywords: "path clipboard",
      shortcut: "cmd+opt+c",
      run: () => actions.copyPathnames(),
    },
    {
      id: "duplicate",
      title: "Duplicate",
      shortcut: "cmd+d",
      enabled: hasSelection,
      run: () => actions.duplicateSelection(),
    },
    {
      id: "compress",
      title: "Compress",
      keywords: "zip archive",
      enabled: hasSelection,
      run: () => actions.compressSelection(),
    },
    {
      id: "extract",
      title: "Extract",
      keywords: "unzip untar expand",
      enabled: () =>
        selectedEntries().some(
          (e) => e.kind === "file" && isExtractableArchive(e.name, e.ext),
        ),
      run: () => actions.extractSelection(),
    },
    {
      id: "undo",
      title: "Undo",
      shortcut: "cmd+z",
      run: () => void useOps.getState().undo(),
    },
    {
      id: "redo",
      title: "Redo",
      shortcut: "cmd+shift+z",
      run: () => void useOps.getState().redo(),
    },

    // -----------------------------------------------------------------------
    // Selection
    // -----------------------------------------------------------------------
    {
      id: "selectAll",
      title: "Select All",
      shortcut: "cmd+a",
      run: () => actions.selectAllVisible(),
    },
    {
      id: "arrowDown",
      title: "Next Item",
      hidden: true,
      shortcut: "down",
      run: () => moveLead(1, false, isGrid() ? gridColumns : 1),
    },
    {
      id: "arrowUp",
      title: "Previous Item",
      hidden: true,
      shortcut: "up",
      run: () => moveLead(-1, false, isGrid() ? gridColumns : 1),
    },
    {
      id: "arrowDownExtend",
      title: "Extend Selection Down",
      hidden: true,
      shortcut: "shift+down",
      run: () => moveLead(1, true, isGrid() ? gridColumns : 1),
    },
    {
      id: "arrowUpExtend",
      title: "Extend Selection Up",
      hidden: true,
      shortcut: "shift+up",
      run: () => moveLead(-1, true, isGrid() ? gridColumns : 1),
    },
    {
      id: "arrowRight",
      title: "Next Item (grid)",
      hidden: true,
      shortcut: "right",
      enabled: isGrid,
      run: () => moveLead(1, false, 1),
    },
    {
      id: "arrowLeft",
      title: "Previous Item (grid)",
      hidden: true,
      shortcut: "left",
      enabled: isGrid,
      run: () => moveLead(-1, false, 1),
    },
    {
      id: "escapeBrowse",
      title: "Deselect All",
      hidden: true,
      shortcut: "escape",
      run: () => {
        const at = activePaneTab();
        if (!at) return;
        const app = useApp.getState();
        if (app.globalSearch.active) {
          app.closeGlobalSearch();
          return;
        }
        const panes = usePanes.getState();
        if (at.tab.filter !== "") {
          panes.setFilter(at.pane.id, at.tab.id, "");
          return;
        }
        panes.setSelection(at.pane.id, at.tab.id, {
          selected: new Set(),
          anchor: null,
          lead: null,
        });
      },
    },

    // -----------------------------------------------------------------------
    // View & window
    // -----------------------------------------------------------------------
    {
      id: "preview",
      title: "Quick Look",
      keywords: "preview space peek",
      shortcut: "space",
      enabled: hasSelection,
      run: () => useApp.getState().setPreviewOpen(true),
    },
    {
      id: "quicklookPanel",
      title: "Quick Look (System Panel)",
      keywords: "qlmanage native preview",
      shortcut: "cmd+y",
      context: ["browse", "preview"],
      enabled: hasSelection,
      run: () => actions.quickLookSelection(),
    },
    {
      id: "toggleHidden",
      title: "Toggle Hidden Files",
      keywords: "show hide dotfiles invisible",
      shortcut: "cmd+shift+.",
      context: ["browse", "search"],
      run: () => {
        const at = activePaneTab();
        if (!at) return;
        const next = !at.tab.showHidden;
        usePanes.getState().setTabShowHidden(at.pane.id, at.tab.id, next);
        useSettings.getState().setShowHidden(next);
      },
    },
    {
      id: "palette",
      title: "Command Palette",
      hidden: true,
      shortcut: "cmd+k",
      context: ["browse", "search", "preview", "palette"],
      run: () => {
        const app = useApp.getState();
        app.setPaletteOpen(!app.paletteOpen);
      },
    },
    {
      id: "dualPane",
      title: "Toggle Dual Pane",
      keywords: "split second pane",
      shortcut: "cmd+shift+d",
      run: () => {
        const s = usePanes.getState();
        s.setSplit(!s.split);
      },
    },
    {
      id: "swapPane",
      title: "Focus Other Pane",
      keywords: "switch pane",
      shortcut: "tab",
      enabled: () => usePanes.getState().split,
      run: () => {
        const app = useApp.getState();
        app.setActivePane(app.activePaneId === "left" ? "right" : "left");
      },
    },
    {
      id: "newTab",
      title: "New Tab",
      shortcut: "cmd+t",
      run: () => {
        const at = activePaneTab();
        if (at) usePanes.getState().openTab(at.pane.id, at.tab.path);
      },
    },
    {
      id: "closeTab",
      title: "Close Tab",
      shortcut: "cmd+w",
      run: () => {
        const at = activePaneTab();
        if (at) usePanes.getState().closeTab(at.pane.id, at.tab.id);
      },
    },
    {
      id: "nextTab",
      title: "Next Tab",
      shortcut: "ctrl+tab",
      run: () => {
        const at = activePaneTab();
        if (at) usePanes.getState().cycleTab(at.pane.id, 1);
      },
    },
    {
      id: "prevTab",
      title: "Previous Tab",
      shortcut: "ctrl+shift+tab",
      run: () => {
        const at = activePaneTab();
        if (at) usePanes.getState().cycleTab(at.pane.id, -1);
      },
    },
    {
      id: "focusSearch",
      title: "Search This Folder",
      keywords: "filter find",
      shortcut: "cmd+f",
      context: ["browse", "search"],
      run: () => useApp.getState().requestSearchFocus(),
    },
    {
      id: "fuzzyFinder",
      title: "Go to File…",
      keywords: "fuzzy jump quick open anything",
      shortcut: "cmd+p",
      context: ["browse", "search"],
      run: () => useFuzzy.getState().openFinder(),
    },
    {
      id: "globalSearch",
      title: "Search Everywhere",
      keywords: "find global spotlight mdfind",
      shortcut: "cmd+shift+f",
      context: ["browse", "search"],
      run: () => {
        const app = useApp.getState();
        app.openGlobalSearch(app.globalSearch.query, "mac");
        app.requestSearchFocus();
      },
    },
    {
      id: "settings",
      title: "Settings…",
      keywords: "preferences options configure",
      shortcut: "cmd+,",
      context: ["browse", "search", "preview", "palette"],
      run: () => useApp.getState().setSettingsOpen(true),
    },
    {
      id: "getInfo",
      title: "Get Info",
      keywords: "properties details inspector",
      shortcut: "cmd+i",
      run: () => {
        const app = useApp.getState();
        app.setGetInfoOpen(!app.getInfoOpen);
      },
    },
    {
      id: "toggleSidebar",
      title: "Toggle Sidebar",
      shortcut: "cmd+opt+s",
      run: () => useSettings.getState().toggleSidebar(),
    },
    {
      id: "viewList",
      title: "View as List",
      shortcut: "cmd+1",
      run: () => useSettings.getState().setViewMode("list"),
    },
    {
      id: "viewGrid",
      title: "View as Icons",
      keywords: "grid icons",
      shortcut: "cmd+2",
      run: () => useSettings.getState().setViewMode("grid"),
    },
    {
      id: "eject",
      title: "Eject Volume",
      keywords: "unmount disk",
      run: () => actions.ejectActiveVolume(),
    },
    {
      id: "refresh",
      title: "Refresh",
      keywords: "reload",
      shortcut: "cmd+r",
      run: () => {
        const at = activePaneTab();
        if (at) usePanes.getState().refresh(at.pane.id, at.tab.id);
      },
    },
  ];
}
