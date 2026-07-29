/**
 * Sidebar: Favorites (default folders + user pins), Trash, Volumes with
 * eject. Rows navigate on click, act as drop targets, and offer a context
 * menu. Dragging folders over the Favorites section pins them Finder-style:
 * row edges and section chrome show an insertion line and pin at that slot,
 * while a row's center still means "move into that folder". The same
 * contract applies to native drags (Finder drag-in and self-drops).
 * Dropping on the Trash row trashes the dragged items (never a copy into
 * ~/.Trash).
 *
 * Pin reorder is POINTER-event based (pointerdown + tracked pointermove),
 * not HTML5 drag & drop: with Tauri's dragDropEnabled (required for Finder
 * drag-in), wry swallows WKWebView's NSDraggingDestination callbacks, so the
 * DOM never receives dragover/drop on macOS — an HTML5 reorder would never
 * complete in the running app (it only worked in jsdom tests).
 */
import { Fragment, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import {
  Database,
  Download,
  FileText,
  Folder,
  HardDrive,
  House,
  LayoutGrid,
  Monitor,
  Trash2,
  Usb,
} from "lucide-react";
import { useVolumes } from "../../stores/volumes";
import { useSettings } from "../../stores/settings";
import { useApp } from "../../stores/app";
import { usePanes, activeTabOf } from "../../stores/panes";
import { onDropHover, onPinHover, registerDropZone } from "../../lib/dnd";
import { confirmEmptyTrash, ejectVolume } from "../../lib/actions";
import { showMenu } from "../../stores/menu";
import { formatBytes } from "../../lib/format";
import type { Volume } from "../../types/ipc";
import { runCommand } from "../../lib/commands/registry";
import {
  cycleBrowseSurface,
  focusActivePane,
  openKeyboardContextMenu,
} from "../../lib/keyboardFocus";
import { useVim } from "../../stores/vim";

/** Fraction of a row's height at top/bottom where a path drag means "pin
 *  here" (insertion) rather than "move into this folder" (center). */
const EDGE_FRACTION = 0.25;

/** lucide has no eject icon — local SVG in lucide stroke conventions. */
function EjectIcon({ size = 12, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M5 14h14L12 5z" />
      <path d="M5 19h14" />
    </svg>
  );
}

interface RowSpec {
  key: string;
  label: string;
  path: string;
  icon: LucideIcon;
  volume?: Volume;
  /** User-pinned favorite: reorderable and removable. */
  favorite?: boolean;
  /** The Trash row: drops trash items instead of moving into the dir. */
  trash?: boolean;
}

/** How far the pointer must travel from pointerdown before a favorite-row
 *  press becomes a reorder drag (vs. a click). */
const REORDER_THRESHOLD_PX = 4;

/** Passed to rows inside the Favorites section: enables the edge-zone pin
 *  behavior (via the drop-zone registry) and pointer-based pin reorder. */
interface FavSectionHooks {
  /** Path of the pin currently being pointer-reordered (for styling). */
  reorderingPath: string | null;
  beginReorder(path: string): void;
  updateReorder(clientY: number): void;
  commitReorder(path: string, clientY: number): void;
  cancelReorder(): void;
}

function SidebarRow({
  row,
  favSection,
  tabStop,
  onFocused,
}: {
  row: RowSpec;
  favSection?: FavSectionHooks;
  tabStop: boolean;
  onFocused(key: string): void;
}) {
  const activePaneId = useApp((s) => s.activePaneId);
  const pane = usePanes((s) => s.panes.find((p) => p.id === activePaneId) ?? s.panes[0]);
  const tab = pane ? activeTabOf(pane) : null;
  const navigate = usePanes((s) => s.navigate);
  const openTab = usePanes((s) => s.openTab);
  const removeFavorite = useSettings((s) => s.removeFavorite);
  const [dropping, setDropping] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  // Finder drag-in onto the Trash row trashes the dragged files.
  useEffect(() => {
    if (!row.trash) return;
    return registerDropZone({
      priority: 20, // beats folder rows and pane backgrounds
      hitTest: (x, y) => {
        const rect = rowRef.current?.getBoundingClientRect();
        if (!rect) return null;
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
          ? { action: "trash", destDir: row.path, targetKey: "sidebar:trash" }
          : null;
      },
    });
  }, [row.trash, row.path]);

  // Native drags over a Favorites-section row: the center copies into the
  // folder; the edge bands return null so the section's pin zone wins.
  const inFavSection = favSection != null;
  useEffect(() => {
    if (!inFavSection) return;
    return registerDropZone({
      priority: 16, // beats the section pin zone (15) in the row's center
      hitTest: (x, y) => {
        const rect = rowRef.current?.getBoundingClientRect();
        if (!rect || rect.height <= 0) return null;
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
        const frac = (y - rect.top) / rect.height;
        if (frac < EDGE_FRACTION || frac > 1 - EDGE_FRACTION) return null;
        return { action: "copyTo", destDir: row.path, targetKey: `fav:${row.path}` };
      },
    });
  }, [inFavSection, row.path]);

  // Drop-ring during native/pointer drags, fed by the registry hover channel.
  useEffect(() => {
    if (!row.trash && !inFavSection) return;
    const key = row.trash ? "sidebar:trash" : `fav:${row.path}`;
    return onDropHover((h) =>
      setDropping(h != null && h.hit.action !== "pin" && h.hit.targetKey === key),
    );
  }, [row.trash, inFavSection, row.path]);

  const isCurrent = tab?.path === row.path;
  // Set when a pointer-reorder happened so the click that follows the
  // pointerup doesn't also navigate.
  const suppressClick = useRef(false);

  return (
    <div
      ref={rowRef}
      data-sidebar-row
      data-sidebar-key={row.key}
      tabIndex={tabStop ? 0 : -1}
      role="link"
      aria-current={isCurrent ? "page" : undefined}
      className={clsx(
        "group mx-2 flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-accent",
        isCurrent ? "bg-accent-dim text-primary" : "text-secondary hover:bg-hov",
        dropping && "drop-ring",
        favSection?.reorderingPath === row.path && "opacity-60",
      )}
      onFocus={() => onFocused(row.key)}
      onPointerDown={(e) => {
        // Pointer-based pin reorder (see the file header for why not HTML5).
        if (!row.favorite || !favSection || e.button !== 0) return;
        const startX = e.clientX;
        const startY = e.clientY;
        let dragging = false;
        const onMove = (ev: PointerEvent) => {
          if (
            !dragging &&
            Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > REORDER_THRESHOLD_PX
          ) {
            dragging = true;
            favSection.beginReorder(row.path);
          }
          if (dragging) favSection.updateReorder(ev.clientY);
        };
        const finish = (commitY: number | null) => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("keydown", onKey, true);
          if (!dragging) return;
          suppressClick.current = true;
          if (commitY != null) favSection.commitReorder(row.path, commitY);
          else favSection.cancelReorder();
        };
        const onUp = (ev: PointerEvent) => finish(ev.clientY);
        const onKey = (ev: KeyboardEvent) => {
          if (ev.key === "Escape") finish(null);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("keydown", onKey, true);
      }}
      onClick={() => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        if (pane && tab) navigate(pane.id, tab.id, row.path);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.currentTarget.focus({ preventScroll: true });
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
          ...(row.trash
            ? [
                { type: "separator" as const },
                {
                  type: "item" as const,
                  label: "Empty Trash…",
                  action: () => confirmEmptyTrash(),
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
      title={
        row.volume
          ? `${row.label} — ${formatBytes(row.volume.availableBytes)} available`
          : row.path
      }
    >
      <row.icon size={15} strokeWidth={1.75} className="w-4 shrink-0" aria-hidden />
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
          <EjectIcon size={12} />
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

/** 2px accent insertion marker shown during favorite reorder and pin drags. */
function InsertionLine() {
  return <div data-testid="insertion-line" className="mx-2 h-0.5 rounded bg-accent" />;
}

/** Insertion index over the favorite rows from the pointer's Y position.
 *  Pure-DOM (counts `[data-fav-index]` rows) so native-zone effects can use
 *  it without a stale `favorites` closure. */
function insertIndexFromPoint(container: HTMLElement | null, clientY: number): number {
  const rows = container?.querySelectorAll<HTMLElement>("[data-fav-index]");
  if (!rows) return 0;
  let index = rows.length;
  for (const el of rows) {
    const rect = el.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      index = Number(el.dataset.favIndex);
      break;
    }
  }
  return index;
}

function FavoritesSection({
  defaults,
  favorites,
  tabStopKey,
  onFocused,
}: {
  defaults: RowSpec[];
  favorites: RowSpec[];
  tabStopKey: string | null;
  onFocused(key: string): void;
}) {
  const moveFavorite = useSettings((s) => s.moveFavorite);
  const [insertIndex, setInsertIndex] = useState<number | null>(null);
  const [reorderingPath, setReorderingPath] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const favSection: FavSectionHooks = {
    reorderingPath,
    beginReorder: (path) => setReorderingPath(path),
    updateReorder: (clientY) =>
      setInsertIndex(insertIndexFromPoint(containerRef.current, clientY)),
    commitReorder: (path, clientY) => {
      // Compute from the pointer directly — never from possibly-stale state.
      const index = insertIndexFromPoint(containerRef.current, clientY);
      setReorderingPath(null);
      setInsertIndex(null);
      moveFavorite(path, index);
    },
    cancelReorder: () => {
      setReorderingPath(null);
      setInsertIndex(null);
    },
  };

  // Native pin zone: row edges and section chrome pin at the computed slot.
  // Priority 15 — row-center copyTo zones (16) and the Trash row (20) win.
  useEffect(() => {
    return registerDropZone({
      priority: 15,
      hitTest: (x, y) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect || x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
          return null;
        }
        return { action: "pin", index: insertIndexFromPoint(containerRef.current, y) };
      },
    });
  }, []);

  // Insertion-line feedback while a native drag hovers the pin zone.
  useEffect(() => onPinHover(setInsertIndex), []);

  return (
    <div ref={containerRef} className="rounded-md">
      <SectionLabel>Favorites</SectionLabel>
      {defaults.map((row) => (
        <SidebarRow
          key={row.key}
          row={row}
          favSection={favSection}
          tabStop={row.key === tabStopKey}
          onFocused={onFocused}
        />
      ))}
      {favorites.map((row, i) => (
        <Fragment key={row.key}>
          {insertIndex === i && <InsertionLine />}
          <div data-fav-index={i}>
            <SidebarRow
              row={row}
              favSection={favSection}
              tabStop={row.key === tabStopKey}
              onFocused={onFocused}
            />
          </div>
        </Fragment>
      ))}
      {insertIndex === favorites.length && <InsertionLine />}
    </div>
  );
}

export function Sidebar() {
  const sidebarRef = useRef<HTMLElement>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const position = useSettings((s) => s.sidebarPosition);
  const pinned = useSettings((s) => s.favorites);
  const showTrash = useSettings((s) => s.showTrashInSidebar);
  const paneAccentLine = useSettings((s) => s.paneAccentLine);
  const folders = useVolumes((s) => s.folders);
  const volumes = useVolumes((s) => s.volumes);

  if (collapsed) return null;

  const defaults: RowSpec[] = folders
    ? [
        { key: "home", label: "Home", path: folders.home, icon: House },
        { key: "desktop", label: "Desktop", path: folders.desktop, icon: Monitor },
        { key: "documents", label: "Documents", path: folders.documents, icon: FileText },
        { key: "downloads", label: "Downloads", path: folders.downloads, icon: Download },
        {
          key: "applications",
          label: "Applications",
          path: folders.applications,
          icon: LayoutGrid,
        },
      ]
    : [];

  const favoriteRows: RowSpec[] = pinned.map((f) => ({
    key: `fav:${f.path}`,
    label: f.name,
    path: f.path,
    icon: Folder,
    favorite: true,
  }));

  const trashRows: RowSpec[] =
    folders && showTrash
      ? [{ key: "trash", label: "Trash", path: folders.trash, icon: Trash2, trash: true }]
      : [];

  const volumeRows: RowSpec[] = volumes.map((v) => ({
    key: `vol:${v.path}`,
    label: v.name,
    path: v.path,
    icon: v.isRoot ? HardDrive : v.isRemovable ? Usb : Database,
    volume: v,
  }));

  const rows = [...defaults, ...favoriteRows, ...trashRows, ...volumeRows];
  const tabStopKey = rows.some((row) => row.key === focusedKey)
    ? focusedKey
    : (rows[0]?.key ?? null);

  const focusRow = (index: number) => {
    const elements = sidebarRef.current?.querySelectorAll<HTMLElement>("[data-sidebar-row]");
    if (!elements || elements.length === 0) return;
    const clamped = Math.max(0, Math.min(elements.length - 1, index));
    elements[clamped].focus({ preventScroll: true });
    elements[clamped].scrollIntoView?.({ block: "nearest" });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-sidebar-row]");
    if (!target) return;
    const elements = [...(sidebarRef.current?.querySelectorAll<HTMLElement>("[data-sidebar-row]") ?? [])];
    const index = elements.indexOf(target);
    if (index < 0) return;
    const vimOn = useSettings.getState().vimMode;
    const vimKey = vimOn && !e.metaKey && !e.ctrlKey && !e.altKey;
    const vim = useVim.getState();
    const state = vim.state;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const reset = () => vim.reset();

    if (state.pending === "g" && !vimKey) {
      reset();
      return;
    }
    if (vimKey && state.pending === "g") {
      handled();
      reset();
      switch (e.key) {
        case "g":
          focusRow(0);
          break;
        case "t":
          runCommand("nextTab");
          break;
        case "T":
          runCommand("prevTab");
          break;
        case "?":
          runCommand("vimHelp");
          break;
        case "s":
          cycleBrowseSurface();
          break;
      }
      return;
    }

    if (vimKey && (/^[1-9]$/.test(e.key) || (e.key === "0" && state.count !== ""))) {
      handled();
      vim.set({ ...state, count: state.count + e.key });
      return;
    }

    const count = vimKey && state.count !== "" ? parseInt(state.count, 10) : 1;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
      case "j":
      case "k": {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if ((e.key === "j" || e.key === "k") && !vimKey) return;
        handled();
        reset();
        const dir = e.key === "ArrowDown" || e.key === "j" ? 1 : -1;
        focusRow(index + dir * count);
        return;
      }
      case "Home":
        handled();
        reset();
        focusRow(0);
        return;
      case "End":
      case "G":
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === "G" && !vimKey) return;
        handled();
        reset();
        focusRow(elements.length - 1);
        return;
      case "g":
        if (!vimKey) return;
        handled();
        vim.set({ mode: "normal", count: state.count, pending: "g" });
        return;
      case "Enter":
      case "ArrowRight":
      case "l":
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === "l" && !vimKey) return;
        handled();
        reset();
        target.click();
        focusActivePane();
        return;
      case "Escape":
      case "ArrowLeft":
      case "h":
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === "h" && !vimKey) return;
        handled();
        reset();
        focusActivePane();
        return;
      case "m":
        if (!vimKey) return;
        handled();
        reset();
        openKeyboardContextMenu();
        return;
      case "v":
      case "y":
      case "d":
      case "p":
        if (!vimKey) return;
        handled();
        reset();
        return; // file-selection operations do not apply to locations
      default:
        if (vimKey && state.count !== "") reset();
    }
  };

  return (
    <nav
      ref={sidebarRef}
      data-vim-surface="sidebar"
      aria-label="Locations"
      onKeyDown={onKeyDown}
      onFocusCapture={(e) => {
        if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) {
          useVim.getState().reset();
        }
      }}
      className={clsx(
        "keyboard-surface flex w-[200px] shrink-0 flex-col overflow-hidden border-edge bg-window",
        paneAccentLine && "keyboard-surface-accent",
        position === "right" ? "border-l" : "border-r",
      )}
    >
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {(defaults.length > 0 || favoriteRows.length > 0) && (
          <FavoritesSection
            defaults={defaults}
            favorites={favoriteRows}
            tabStopKey={tabStopKey}
            onFocused={setFocusedKey}
          />
        )}
        {trashRows.map((row) => (
          <SidebarRow
            key={row.key}
            row={row}
            tabStop={row.key === tabStopKey}
            onFocused={setFocusedKey}
          />
        ))}
        {volumeRows.length > 0 && (
          <>
            <SectionLabel>Volumes</SectionLabel>
            {volumeRows.map((row) => (
              <SidebarRow
                key={row.key}
                row={row}
                tabStop={row.key === tabStopKey}
                onFocused={setFocusedKey}
              />
            ))}
          </>
        )}
        {defaults.length === 0 && volumeRows.length === 0 && (
          <div className="px-4 py-6 text-xs text-tertiary">
            Locations appear here when the backend is running.
          </div>
        )}
      </div>
    </nav>
  );
}
