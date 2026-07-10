/**
 * Shared file actions — invoked by keyboard commands, the palette, context
 * menus, and drag & drop. Every action tolerates a missing backend (dev
 * without Tauri): failures land in toasts, never unhandled rejections.
 */
import type { Entry } from "../types/ipc";
import * as ipc from "./ipc";
import { basename, dirname, pluralize, splitExt } from "./format";
import { isExtractableArchive } from "./fileTypes";
import { useApp, toast } from "../stores/app";
import { activePaneTab, selectedEntries, usePanes, visibleEntries } from "../stores/panes";
import { useOps } from "../stores/ops";
import { useVolumes } from "../stores/volumes";
import { showMenu, type MenuItem } from "../stores/menu";
import { iconUrl } from "../types/ipc";

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

export function openEntries(entries: Entry[]): void {
  const at = activePaneTab();
  if (!at || entries.length === 0) return;
  const { pane, tab } = at;
  if (entries.length === 1) {
    usePanes.getState().openEntry(pane.id, tab.id, entries[0]);
    return;
  }
  const dirs = entries.filter((e) => e.kind === "dir" && !e.isPackage);
  const files = entries.filter((e) => !(e.kind === "dir" && !e.isPackage));
  if (files.length > 0) {
    void ipc.openPaths(files.map((e) => e.path)).catch((err) => {
      toast(`Couldn't open: ${err}`, { danger: true });
    });
  }
  // multiple dirs → open in new tabs
  for (const d of dirs) usePanes.getState().openTab(pane.id, d.path);
}

export function openSelection(): void {
  openEntries(selectedEntries());
}

// ---------------------------------------------------------------------------
// clipboard
// ---------------------------------------------------------------------------

export function copySelection(): void {
  const entries = selectedEntries();
  if (entries.length === 0) return;
  const paths = entries.map((e) => e.path);
  ipc
    .pbWriteFiles(paths, false)
    .then(() => useApp.getState().setClipboard({ mode: "copy", paths }))
    .catch((err) => toast(`Copy failed: ${err}`, { danger: true }));
}

export function cutSelection(): void {
  const entries = selectedEntries();
  if (entries.length === 0) return;
  const paths = entries.map((e) => e.path);
  ipc
    .pbWriteFiles(paths, true)
    .then(() => useApp.getState().setClipboard({ mode: "cut", paths }))
    .catch((err) => toast(`Cut failed: ${err}`, { danger: true }));
}

export function pasteInto(destDir: string, forceMove = false): void {
  ipc
    .pbReadFiles()
    .then((contents) => {
      if (!contents || contents.paths.length === 0) return;
      const kind = forceMove || contents.isCut ? "move" : "copy";
      // pasting into the folder the items already live in → duplicate semantics for copy
      const allSameDir = contents.paths.every((p) => dirname(p) === destDir);
      if (kind === "copy" && allSameDir) {
        useOps.getState().duplicate(contents.paths);
        return;
      }
      if (kind === "move" && allSameDir) return; // no-op
      useOps.getState().startOp({ kind, sources: contents.paths, destDir, policy: "ask" });
      if (contents.isCut) {
        useApp.getState().setClipboard(null);
      }
    })
    .catch((err) => toast(`Paste failed: ${err}`, { danger: true }));
}

export function pasteIntoActive(forceMove = false): void {
  const at = activePaneTab();
  if (at) pasteInto(at.tab.path, forceMove);
}

export function copyPathnames(): void {
  const entries = selectedEntries();
  const at = activePaneTab();
  const paths = entries.length > 0 ? entries.map((e) => e.path) : at ? [at.tab.path] : [];
  if (paths.length === 0) return;
  ipc
    .pbWriteText(paths.join("\n"))
    .then(() => toast(paths.length === 1 ? "Pathname copied" : `${paths.length} pathnames copied`))
    .catch((err) => toast(`Couldn't copy pathname: ${err}`, { danger: true }));
}

// ---------------------------------------------------------------------------
// trash / delete / duplicate
// ---------------------------------------------------------------------------

/** Trash by path with the undo toast — shared by selection ops and drops
 *  onto the sidebar Trash row (internal drags and the Finder drag-in bridge). */
export function trashPathsWithUndo(paths: string[]): void {
  if (paths.length === 0) return;
  // optimistic instant removal; watcher confirms
  usePanes.getState().removeEntriesByPath(paths);
  ipc
    .trashPaths(paths)
    .then(() => {
      toast(`${pluralize(paths.length, "item")} moved to Trash`, {
        action: { label: "Undo", run: () => void useOps.getState().undo() },
      });
    })
    .catch((err) => {
      // roll back by refreshing every pane that lost rows
      const s = usePanes.getState();
      for (const pane of s.panes) s.refresh(pane.id, pane.activeTabId);
      toast(`Couldn't move to Trash: ${err}`, { danger: true });
    });
}

export function trashEntries(entries: Entry[]): void {
  trashPathsWithUndo(entries.map((e) => e.path));
}

export function trashSelection(): void {
  trashEntries(selectedEntries());
}

/** Confirm-and-run Empty Trash: totals across every user trash dir (the
 *  browsed listing shows only ~/.Trash — the dialog copy is authoritative). */
export function confirmEmptyTrash(): void {
  ipc
    .trashStats()
    .then((stats) => {
      if (stats.count === 0) {
        toast("The Trash is empty");
        return;
      }
      const external =
        stats.externalCount > 0 ? ` (${stats.externalCount} on external volumes)` : "";
      useApp.getState().showConfirm({
        title: "Empty Trash?",
        message: `${pluralize(stats.count, "item")}${external} will be permanently deleted. You can't undo this action.`,
        confirmLabel: "Empty Trash",
        danger: true,
        onConfirm: () => {
          void ipc
            .emptyTrash((e) => {
              if (e.event !== "done") return;
              if (e.errors.length === 0) {
                toast("Trash emptied");
              } else {
                toast(
                  `${pluralize(e.errors.length, "item")} couldn't be deleted from the Trash`,
                  { danger: true },
                );
              }
              const s = usePanes.getState();
              for (const pane of s.panes) s.refresh(pane.id, pane.activeTabId);
            })
            .catch((err) => toast(`Empty Trash failed: ${err}`, { danger: true }));
        },
      });
    })
    .catch((err) => toast(`Couldn't read the Trash: ${err}`, { danger: true }));
}

export function deleteSelectionPermanently(): void {
  const entries = selectedEntries();
  if (entries.length === 0) return;
  const label =
    entries.length === 1 ? `“${entries[0].name}”` : pluralize(entries.length, "item");
  useApp.getState().showConfirm({
    title: `Delete ${label} permanently?`,
    message: "This item will be deleted immediately. You can't undo this action.",
    confirmLabel: "Delete",
    danger: true,
    onConfirm: () => {
      const paths = entries.map((e) => e.path);
      usePanes.getState().removeEntriesByPath(paths);
      ipc
        .deletePermanent(paths)
        .then(() => toast(`Deleted ${pluralize(paths.length, "item")}`))
        .catch((err) => {
          const s = usePanes.getState();
          for (const pane of s.panes) s.refresh(pane.id, pane.activeTabId);
          toast(`Delete failed: ${err}`, { danger: true });
        });
    },
  });
}

export function duplicateSelection(): void {
  const entries = selectedEntries();
  if (entries.length === 0) return;
  useOps.getState().duplicate(entries.map((e) => e.path));
}

// ---------------------------------------------------------------------------
// archives
// ---------------------------------------------------------------------------

/** Compress the selection to a zip in the active tab's folder. */
export function compressSelection(): void {
  const entries = selectedEntries();
  const at = activePaneTab();
  if (entries.length === 0 || !at) return;
  useOps.getState().compress(entries.map((e) => e.path), at.tab.path);
}

/** Extract every selected archive into the active tab's folder. */
export function extractSelection(): void {
  const entries = selectedEntries();
  const at = activePaneTab();
  if (!at) return;
  const archives = entries.filter(
    (e) => e.kind === "file" && isExtractableArchive(e.name, e.ext),
  );
  if (archives.length === 0) return;
  useOps.getState().extract(archives.map((e) => e.path), at.tab.path);
}

// ---------------------------------------------------------------------------
// new folder & rename
// ---------------------------------------------------------------------------

function uniqueChildName(siblings: readonly Entry[], base: string): string {
  const names = new Set(siblings.map((e) => e.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
}

export function newFolderInActive(): void {
  const at = activePaneTab();
  if (!at) return;
  const { pane, tab } = at;
  const name = uniqueChildName(tab.entries, "untitled folder");
  ipc
    .newFolder(tab.path, name)
    .then(async (path) => {
      // pull the fresh entry into the listing right away, select it, start rename
      let entry: Entry | null = null;
      try {
        entry = await ipc.statPath(path, tab.listingId);
      } catch {
        entry = null;
      }
      const panes = usePanes.getState();
      if (entry) {
        panes.upsertEntryNow(pane.id, tab.id, entry);
        const fresh = usePanes
          .getState()
          .panes.find((p) => p.id === pane.id)
          ?.tabs.find((t) => t.id === tab.id)
          ?.entries.find((e) => e.name === entry.name);
        if (fresh) {
          panes.setSelection(pane.id, tab.id, {
            selected: new Set([fresh.id]),
            anchor: fresh.id,
            lead: fresh.id,
          });
          useApp.getState().startRename({ paneId: pane.id, tabId: tab.id, entryId: fresh.id });
        }
      } else {
        panes.addGhosts(tab.path, [path], true);
      }
    })
    .catch((err) => toast(`Couldn't create folder: ${err}`, { danger: true }));
}

export function startRenameSelected(): void {
  const at = activePaneTab();
  if (!at) return;
  const { pane, tab } = at;
  const leadId = tab.selection.lead ?? [...tab.selection.selected][0];
  if (leadId == null) return;
  useApp.getState().startRename({ paneId: pane.id, tabId: tab.id, entryId: leadId });
}

/** Illegal in a filename: "/" always; ":" (Finder displays it as "/"). */
export function renameValidationError(
  name: string,
  siblings: readonly Entry[],
  selfName: string,
): string | null {
  if (name.length === 0) return "Name can't be empty";
  if (name.includes("/")) return "Name can't contain “/”";
  if (name.includes(":")) return "Name can't contain “:”";
  const lower = name.toLowerCase();
  if (lower !== selfName.toLowerCase()) {
    if (siblings.some((e) => e.name.toLowerCase() === lower && e.name !== selfName)) {
      return "An item with this name already exists";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Open With menu
// ---------------------------------------------------------------------------

export function openWithMenuItems(entry: Entry): () => Promise<MenuItem[]> {
  return async () => {
    try {
      const apps = await ipc.openWithApps(entry.path);
      if (apps.length === 0) {
        return [{ type: "item", label: "No applications found", disabled: true }];
      }
      const paths = selectedEntries().map((e) => e.path);
      const targets = paths.length > 0 ? paths : [entry.path];
      const items: MenuItem[] = apps.map((app) => ({
        type: "item",
        label: app.isDefault ? `${app.name} (default)` : app.name,
        icon: iconUrl(app.icon, 32),
        action: () => {
          void ipc.openWith(targets, app.path).catch((err) => {
            toast(`Couldn't open: ${err}`, { danger: true });
          });
        },
      }));
      return items;
    } catch (err) {
      return [{ type: "item", label: `Unavailable: ${err}`, disabled: true }];
    }
  };
}

export function showOpenWithMenuAtCenter(): void {
  const entries = selectedEntries();
  if (entries.length === 0) return;
  void openWithMenuItems(entries[0])().then((items) => {
    showMenu(window.innerWidth / 2 - 120, window.innerHeight / 3, items);
  });
}

// ---------------------------------------------------------------------------
// navigation helpers
// ---------------------------------------------------------------------------

export function goTo(path: string | null | undefined): void {
  if (!path) return;
  const at = activePaneTab();
  if (!at) return;
  usePanes.getState().navigate(at.pane.id, at.tab.id, path);
}

export function goToFolder(key: "home" | "desktop" | "documents" | "downloads" | "applications"): void {
  const folders = useVolumes.getState().folders;
  if (!folders) {
    void useVolumes
      .getState()
      .loadFolders()
      .then((f) => goTo(f?.[key]));
    return;
  }
  goTo(folders[key]);
}

export function revealPaths(paths: string[]): void {
  void ipc.revealInFinder(paths).catch((err) => {
    toast(`Couldn't reveal in Finder: ${err}`, { danger: true });
  });
}

/** Reveal a search hit inside Fazi: navigate to its parent and select it. */
export function revealInFazi(path: string): void {
  const at = activePaneTab();
  if (!at) return;
  const parent = dirname(path) ?? "/";
  useApp.getState().closeGlobalSearch();
  usePanes.getState().navigate(at.pane.id, at.tab.id, parent, { selectName: basename(path) });
}

export function ejectActiveVolume(): void {
  const at = activePaneTab();
  if (!at) return;
  const volumes = useVolumes.getState().volumes;
  const candidates = volumes
    .filter((v) => !v.isRoot && v.isEjectable && at.tab.path.startsWith(v.path))
    .sort((a, b) => b.path.length - a.path.length);
  const vol = candidates[0];
  if (!vol) {
    toast("This location can't be ejected");
    return;
  }
  ejectVolume(vol.path, vol.name);
}

export function ejectVolume(path: string, name: string): void {
  void ipc
    .eject(path)
    .then(() => toast(`Ejected “${name}”`))
    .catch((err) => toast(`Couldn't eject “${name}”: ${err}`, { danger: true }));
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

export function quickLookSelection(): void {
  const paths = selectedEntries().map((e) => e.path);
  if (paths.length === 0) return;
  void ipc.quicklookPanel(paths).catch((err) => {
    toast(`Quick Look failed: ${err}`, { danger: true });
  });
}

export function setEntryTags(entry: Entry, colors: number[]): void {
  const names: Record<number, string> = {
    1: "Gray", 2: "Green", 3: "Purple", 4: "Blue", 5: "Yellow", 6: "Red", 7: "Orange",
  };
  const tags = colors.map((c) => ({ name: names[c] ?? "Tag", color: c }));
  void ipc.setTags(entry.path, tags).catch((err) => {
    toast(`Couldn't set tags: ${err}`, { danger: true });
  });
}

export function selectAllVisible(): void {
  const at = activePaneTab();
  if (!at) return;
  const { pane, tab } = at;
  const order = visibleEntries(tab).map((e) => e.id);
  usePanes.getState().setSelection(pane.id, tab.id, {
    selected: new Set(order),
    anchor: order[0] ?? null,
    lead: order[order.length - 1] ?? null,
  });
}

export { splitExt };
