/** Context-menu builders for file rows and pane empty areas. */
import type { Entry } from "../../types/ipc";
import type { MenuItem } from "../../stores/menu";
import * as actions from "../../lib/actions";
import { useApp, toast } from "../../stores/app";
import { usePanes, selectedEntries } from "../../stores/panes";
import type { PaneId } from "../../stores/app";
import { useSettings } from "../../stores/settings";
import { useVolumes } from "../../stores/volumes";
import { isExtractableArchive } from "../../lib/fileTypes";
import { FINDER_TAG_COLORS } from "../../lib/tags";
import { pluralize } from "../../lib/format";

function countLabel(verb: string, n: number): string {
  return n > 1 ? `${verb} ${pluralize(n, "item")}` : verb;
}

function tagsSubmenu(entries: Entry[]): MenuItem[] {
  const lead = entries[0];
  const current = new Set(lead?.tags.map((t) => t.color) ?? []);
  return Object.entries(FINDER_TAG_COLORS).map(([colorStr, spec]) => {
    const color = Number(colorStr);
    const checked = current.has(color);
    return {
      type: "item",
      label: spec.name,
      dotColor: spec.css,
      checked,
      action: () => {
        for (const entry of entries) {
          const own = new Set(entry.tags.map((t) => t.color));
          if (checked) own.delete(color);
          else own.add(color);
          actions.setEntryTags(entry, [...own]);
        }
      },
    };
  });
}

/** Menu for a right-clicked row (selection already normalized by the caller). */
export function entryMenuItems(paneId: PaneId, tabId: string, entry: Entry): MenuItem[] {
  const entries = selectedEntries();
  const targets = entries.length > 0 ? entries : [entry];
  const n = targets.length;
  const items: MenuItem[] = [];

  items.push({
    type: "item",
    label: countLabel("Open", n),
    action: () => actions.openEntries(targets),
  });
  items.push({
    type: "item",
    label: "Open With",
    submenu: actions.openWithMenuItems(entry),
  });
  if (entry.isPackage && n === 1) {
    items.push({
      type: "item",
      label: "Show Package Contents",
      action: () => usePanes.getState().navigate(paneId, tabId, entry.path),
    });
  }
  items.push({ type: "separator" });
  items.push({
    type: "item",
    label: "Get Info",
    shortcut: "cmd+i",
    action: () => useApp.getState().setGetInfoOpen(true),
  });
  if (n === 1) {
    items.push({
      type: "item",
      label: "Rename",
      shortcut: "enter",
      action: () => useApp.getState().startRename({ paneId, tabId, entryId: entry.id }),
    });
  }
  items.push({
    type: "item",
    label: countLabel("Duplicate", n),
    shortcut: "cmd+d",
    action: () => actions.duplicateSelection(),
  });
  items.push({
    type: "item",
    label: n > 1 ? `Compress ${pluralize(n, "item")}` : `Compress “${entry.name}”`,
    action: () => actions.compressSelection(),
  });
  if (targets.every((t) => t.kind === "file" && isExtractableArchive(t.name, t.ext))) {
    items.push({
      type: "item",
      label: "Extract Here",
      action: () => actions.extractSelection(),
    });
  }
  items.push({
    type: "item",
    label: "Quick Look",
    shortcut: "space",
    action: () => useApp.getState().setPreviewOpen(true),
  });
  items.push({ type: "separator" });
  items.push({
    type: "item",
    label: countLabel("Copy", n),
    shortcut: "cmd+c",
    action: () => actions.copySelection(),
  });
  items.push({
    type: "item",
    label: countLabel("Cut", n),
    shortcut: "cmd+x",
    action: () => actions.cutSelection(),
  });
  items.push({
    type: "item",
    label: n > 1 ? `Move ${pluralize(n, "item")} to Trash` : "Move to Trash",
    shortcut: "cmd+delete",
    danger: true,
    action: () => actions.trashSelection(),
  });
  items.push({ type: "separator" });
  items.push({ type: "item", label: "Tags", submenu: tagsSubmenu(targets) });
  items.push({
    type: "item",
    label: "Copy as Pathname",
    shortcut: "cmd+opt+c",
    action: () => actions.copyPathnames(),
  });
  items.push({
    type: "item",
    label: "Reveal in Finder",
    action: () => actions.revealPaths(targets.map((t) => t.path)),
  });
  if (targets.every((t) => t.kind === "dir" && !t.isPackage)) {
    items.push({
      type: "item",
      label: "Add to Sidebar",
      action: () => {
        const folders = useVolumes.getState().folders;
        const defaultPaths = folders
          ? [
              folders.home,
              folders.desktop,
              folders.documents,
              folders.downloads,
              folders.applications,
            ]
          : [];
        const added = useSettings.getState().addFavorites(
          targets.map((t) => ({ path: t.path, name: t.name })),
          defaultPaths,
        );
        if (added === 0) toast("Already in the sidebar");
        else toast(`Added ${pluralize(added, "folder")} to the sidebar`);
      },
    });
  }
  return items;
}

/** Menu for the pane's empty area. */
export function emptyAreaMenuItems(paneId: PaneId, tabId: string): MenuItem[] {
  const tab = usePanes
    .getState()
    .panes.find((p) => p.id === paneId)
    ?.tabs.find((t) => t.id === tabId);
  return [
    {
      type: "item",
      label: "New Folder",
      shortcut: "cmd+shift+n",
      action: () => actions.newFolderInActive(),
    },
    {
      type: "item",
      label: "Paste",
      shortcut: "cmd+v",
      action: () => {
        if (tab) actions.pasteInto(tab.path, false);
      },
    },
    { type: "separator" },
    {
      type: "item",
      label: "Get Info",
      shortcut: "cmd+i",
      action: () => useApp.getState().setGetInfoOpen(true),
    },
    {
      type: "item",
      label: tab?.showHidden ? "Hide Hidden Files" : "Show Hidden Files",
      shortcut: "cmd+shift+.",
      action: () => {
        if (tab) usePanes.getState().setTabShowHidden(paneId, tabId, !tab.showHidden);
      },
    },
  ];
}
