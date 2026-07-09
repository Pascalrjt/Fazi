/**
 * Sidebar: Favorites (default folders + user pins), iCloud Drive, Volumes
 * with eject. Rows navigate on click, act as drop targets, and offer a
 * context menu. The Favorites section additionally accepts drag-to-pin on its
 * chrome (label/whitespace — never on a row) and drag-to-reorder of pins.
 */
import { Fragment, useRef, useState } from "react";
import clsx from "clsx";
import { useVolumes } from "../../stores/volumes";
import { useSettings } from "../../stores/settings";
import { useApp, toast } from "../../stores/app";
import { usePanes, activeTabOf, activePaneTab } from "../../stores/panes";
import {
  beginFavoriteDrag,
  dragHasFavorite,
  dragHasPaths,
  draggedFavoritePath,
  draggedPaths,
  dropPaths,
  endFavoriteDrag,
  endInternalDrag,
} from "../../lib/dnd";
import * as ipc from "../../lib/ipc";
import { ejectVolume } from "../../lib/actions";
import { showMenu } from "../../stores/menu";
import { formatBytes, basename, pluralize } from "../../lib/format";
import type { Entry, Volume } from "../../types/ipc";

interface RowSpec {
  key: string;
  label: string;
  path: string;
  glyph: string;
  volume?: Volume;
  /** User-pinned favorite: reorderable and removable. */
  favorite?: boolean;
}

function SidebarRow({ row }: { row: RowSpec }) {
  const activePaneId = useApp((s) => s.activePaneId);
  const pane = usePanes((s) => s.panes.find((p) => p.id === activePaneId) ?? s.panes[0]);
  const tab = pane ? activeTabOf(pane) : null;
  const navigate = usePanes((s) => s.navigate);
  const openTab = usePanes((s) => s.openTab);
  const removeFavorite = useSettings((s) => s.removeFavorite);
  const [dropping, setDropping] = useState(false);

  const isCurrent = tab?.path === row.path;

  return (
    <div
      className={clsx(
        "group mx-2 flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-[13px]",
        isCurrent ? "bg-accent-dim text-primary" : "text-secondary hover:bg-hov",
        dropping && "drop-ring",
      )}
      draggable={row.favorite === true}
      onDragStart={(e) => {
        if (row.favorite) beginFavoriteDrag(e, row.path);
      }}
      onDragEnd={() => {
        if (row.favorite) endFavoriteDrag();
      }}
      onClick={() => {
        if (pane && tab) navigate(pane.id, tab.id, row.path);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          {
            type: "item",
            label: "Open in New Tab",
            action: () => pane && openTab(pane.id, row.path),
          },
          ...(row.favorite
            ? [
                { type: "separator" as const },
                {
                  type: "item" as const,
                  label: "Remove from Sidebar",
                  action: () => removeFavorite(row.path),
                },
              ]
            : []),
          ...(row.volume && row.volume.isEjectable
            ? [
                { type: "separator" as const },
                {
                  type: "item" as const,
                  label: `Eject “${row.label}”`,
                  action: () => ejectVolume(row.path, row.label),
                },
              ]
            : []),
        ]);
      }}
      onDragOver={(e) => {
        // Favorite-reorder drags must bubble to FavoritesSection — bail
        // BEFORE any stopPropagation or the reorder never reaches it.
        if (dragHasFavorite(e)) return;
        if (!dragHasPaths(e)) return;
        e.preventDefault();
        // A path drag over a row is move-into-that-folder; stop it here so
        // the Favorites section container never treats it as a pin.
        e.stopPropagation();
        e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        if (dragHasFavorite(e)) return; // bubbles up to the section reorder
        e.preventDefault();
        e.stopPropagation();
        setDropping(false);
        dropPaths(e, row.path);
      }}
      title={
        row.volume
          ? `${row.label} — ${formatBytes(row.volume.availableBytes)} available`
          : row.path
      }
    >
      <span className="w-4 text-center text-[13px]">{row.glyph}</span>
      <span className="min-w-0 flex-1 truncate">{row.label}</span>
      {row.volume?.isEjectable && (
        <button
          className="hidden shrink-0 cursor-default rounded px-1 text-[11px] text-tertiary hover:text-primary group-hover:block"
          title={`Eject ${row.label}`}
          onClick={(e) => {
            e.stopPropagation();
            ejectVolume(row.path, row.label);
          }}
        >
          ⏏
        </button>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="mx-4 mb-1 mt-4 text-[11px] font-semibold uppercase tracking-wide text-tertiary">
      {children}
    </div>
  );
}

/** 2px accent insertion marker shown during favorite reorder. */
function InsertionLine() {
  return <div className="mx-2 h-0.5 rounded bg-accent" />;
}

/** Find an entry for `path` in any open listing (cheap pin resolution). */
function entryFromListings(path: string): Entry | null {
  for (const pane of usePanes.getState().panes) {
    for (const tab of pane.tabs) {
      const hit = tab.entries.find((en) => en.path === path);
      if (hit) return hit;
    }
  }
  return null;
}

function FavoritesSection({
  defaults,
  favorites,
}: {
  defaults: RowSpec[];
  favorites: RowSpec[];
}) {
  const addFavorites = useSettings((s) => s.addFavorites);
  const moveFavorite = useSettings((s) => s.moveFavorite);
  const [pinDrop, setPinDrop] = useState(false);
  const [insertIndex, setInsertIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const clearDragState = () => {
    setPinDrop(false);
    setInsertIndex(null);
  };

  /** Insertion index over the favorite rows from the pointer's Y position. */
  const reorderIndexFromPoint = (clientY: number): number => {
    const rows = containerRef.current?.querySelectorAll<HTMLElement>("[data-fav-index]");
    if (!rows) return favorites.length;
    let index = favorites.length;
    for (const el of rows) {
      const rect = el.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        index = Number(el.dataset.favIndex);
        break;
      }
    }
    return index;
  };

  const pinPaths = async (paths: string[]) => {
    const at = activePaneTab();
    const resolved: Entry[] = [];
    for (const path of paths) {
      let entry = entryFromListings(path);
      if (!entry && at?.tab.listingId) {
        try {
          entry = await ipc.statPath(path, at.tab.listingId);
        } catch {
          entry = null;
        }
      }
      if (entry) resolved.push(entry);
    }
    const dirs = resolved.filter((en) => en.kind === "dir" && !en.isPackage);
    if (dirs.length === 0) {
      toast("Only folders can be added to the sidebar");
      return;
    }
    const added = addFavorites(
      dirs.map((en) => ({ path: en.path, name: en.name || basename(en.path) })),
      defaults.map((d) => d.path),
    );
    if (added === 0) {
      toast("Already in the sidebar");
    } else {
      toast(`Added ${pluralize(added, "folder")} to the sidebar`);
    }
  };

  return (
    <div
      ref={containerRef}
      className={clsx("rounded-md", pinDrop && "drop-ring")}
      onDragOver={(e) => {
        if (dragHasFavorite(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setInsertIndex(reorderIndexFromPoint(e.clientY));
          return;
        }
        // Path drags over rows were stopped at the row — reaching here means
        // section chrome (label/whitespace), which is a pin.
        if (!dragHasPaths(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setPinDrop(true);
      }}
      onDragLeave={(e) => {
        if (!containerRef.current?.contains(e.relatedTarget as Node)) {
          clearDragState();
        }
      }}
      onDrop={(e) => {
        if (dragHasFavorite(e)) {
          e.preventDefault();
          const path = draggedFavoritePath(e);
          const index = insertIndex;
          endFavoriteDrag();
          clearDragState();
          if (path != null && index != null) moveFavorite(path, index);
          return;
        }
        if (!dragHasPaths(e)) return;
        e.preventDefault();
        clearDragState();
        const paths = draggedPaths(e);
        endInternalDrag();
        if (paths.length > 0) void pinPaths(paths);
      }}
    >
      <SectionLabel>Favorites</SectionLabel>
      {defaults.map((row) => (
        <SidebarRow key={row.key} row={row} />
      ))}
      {favorites.map((row, i) => (
        <Fragment key={row.key}>
          {insertIndex === i && <InsertionLine />}
          <div data-fav-index={i}>
            <SidebarRow row={row} />
          </div>
        </Fragment>
      ))}
      {insertIndex === favorites.length && favorites.length > 0 && <InsertionLine />}
    </div>
  );
}

export function Sidebar() {
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const pinned = useSettings((s) => s.favorites);
  const folders = useVolumes((s) => s.folders);
  const volumes = useVolumes((s) => s.volumes);

  if (collapsed) return null;

  const defaults: RowSpec[] = folders
    ? [
        { key: "home", label: "Home", path: folders.home, glyph: "⌂" },
        { key: "desktop", label: "Desktop", path: folders.desktop, glyph: "🖥" },
        { key: "documents", label: "Documents", path: folders.documents, glyph: "📄" },
        { key: "downloads", label: "Downloads", path: folders.downloads, glyph: "⤓" },
        { key: "applications", label: "Applications", path: folders.applications, glyph: "▣" },
      ]
    : [];

  const favoriteRows: RowSpec[] = pinned.map((f) => ({
    key: `fav:${f.path}`,
    label: f.name,
    path: f.path,
    glyph: "📁",
    favorite: true,
  }));

  const icloud: RowSpec[] =
    folders?.icloudDrive != null
      ? [{ key: "icloud", label: "iCloud Drive", path: folders.icloudDrive, glyph: "☁" }]
      : [];

  const volumeRows: RowSpec[] = volumes.map((v) => ({
    key: `vol:${v.path}`,
    label: v.name,
    path: v.path,
    glyph: v.isRoot ? "⏺" : v.isRemovable ? "◨" : "◧",
    volume: v,
  }));

  return (
    <div className="flex w-[200px] shrink-0 flex-col overflow-y-auto border-r border-edge bg-window pb-2">
      {(defaults.length > 0 || favoriteRows.length > 0) && (
        <FavoritesSection defaults={defaults} favorites={favoriteRows} />
      )}
      {icloud.length > 0 && (
        <>
          <SectionLabel>iCloud</SectionLabel>
          {icloud.map((row) => (
            <SidebarRow key={row.key} row={row} />
          ))}
        </>
      )}
      {volumeRows.length > 0 && (
        <>
          <SectionLabel>Volumes</SectionLabel>
          {volumeRows.map((row) => (
            <SidebarRow key={row.key} row={row} />
          ))}
        </>
      )}
      {defaults.length === 0 && volumeRows.length === 0 && (
        <div className="px-4 py-6 text-xs text-tertiary">
          Locations appear here when the backend is running.
        </div>
      )}
    </div>
  );
}
