/**
 * The core virtualized list view: 28px rows, sortable/resizable columns,
 * full multi-select (click/cmd/shift/marquee), inline rename, drag & drop,
 * context menus, ghost rows, badges, shimmer placeholders.
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import clsx from "clsx";
import { Lock } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Entry } from "../../types/ipc";
import { iconUrl } from "../../types/ipc";
import * as ipc from "../../lib/ipc";
import { usePanes, visibleEntries, type GhostEntry, type Tab } from "../../stores/panes";
import { useApp, toast, type PaneId } from "../../stores/app";
import { showMenu } from "../../stores/menu";
import { entryMenuItems, emptyAreaMenuItems } from "../menus/entryMenu";
import {
  clickSelect,
  cmdToggle,
  dragRect,
  marqueeSelect,
  shiftRange,
  type Rect,
} from "../../lib/selection";
import { entryKindLabel, type SortKey } from "../../lib/sort";
import { formatBytes, formatDate, splitExt } from "../../lib/format";
import { renameValidationError } from "../../lib/actions";
import {
  beginInternalDrag,
  dragHasPaths,
  dropPaths,
  draggedPaths,
  endInternalDrag,
  isInvalidDrop,
  registerDropZone,
} from "../../lib/dnd";
import { startNativeDrag } from "../../lib/ipc/dnd";
import { useSettings } from "../../stores/settings";
import { useDirSizes } from "../../stores/dirSizes";
import { useViewportHydration } from "../../hooks/useViewportHydration";
import { tagCss } from "../../lib/tags";
import { EmptyFolder, ListingError, NoFilterMatches } from "./EmptyStates";

const SPRING_LOAD_MS = 600;

/** Row height by density (Settings → Appearance). */
export function rowHeight(density: "normal" | "compact"): number {
  return density === "compact" ? 24 : 28;
}

interface ColWidths {
  kind: number;
  size: number;
  mtime: number;
  tags: number;
}

const DEFAULT_COLS: ColWidths = { kind: 110, size: 84, mtime: 148, tags: 64 };

function loadCols(): ColWidths {
  try {
    const raw = localStorage.getItem("fazi-cols");
    if (raw) return { ...DEFAULT_COLS, ...(JSON.parse(raw) as Partial<ColWidths>) };
  } catch {
    /* defaults */
  }
  return DEFAULT_COLS;
}

// ---------------------------------------------------------------------------
// Rename input
// ---------------------------------------------------------------------------

function RenameInput({
  entry,
  paneId,
  tabId,
  onDone,
}: {
  entry: Entry;
  paneId: PaneId;
  tabId: string;
  onDone: (committed: boolean, advance: boolean) => void;
}) {
  const [value, setValue] = useState(entry.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);
  const siblings = usePanes(
    useCallback(
      (s) =>
        s.panes.find((p) => p.id === paneId)?.tabs.find((t) => t.id === tabId)?.entries ?? [],
      [paneId, tabId],
    ),
  );
  const error = renameValidationError(value.trim(), siblings, entry.name);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // preselect name sans extension (dirs: whole name)
    const [stem] = entry.kind === "dir" && !entry.isPackage ? [entry.name] : splitExt(entry.name);
    input.setSelectionRange(0, stem.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = (advance: boolean) => {
    if (committedRef.current) return;
    const newName = value.trim();
    if (newName === entry.name || newName === "") {
      committedRef.current = true;
      onDone(false, advance);
      return;
    }
    if (error) return; // invalid — stay in rename mode
    committedRef.current = true;
    const entryId = entry.id;
    ipc
      .renamePath(entry.path, newName)
      .then((newPath) => {
        usePanes.getState().renameLocal(paneId, tabId, entryId, newName, newPath);
      })
      .catch((err) => {
        toast(`Couldn't rename “${entry.name}”: ${err}`, { danger: true });
      });
    onDone(true, advance);
  };

  return (
    <span className="relative flex min-w-0 flex-1 items-center" title={error ?? undefined}>
      <input
        ref={inputRef}
        className={clsx("rename-input w-full", error && value !== entry.name && "invalid")}
        value={value}
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            commit(false);
          } else if (e.key === "Tab") {
            e.preventDefault();
            commit(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            committedRef.current = true;
            onDone(false, false);
          }
        }}
        onBlur={() => commit(false)}
      />
      {error && value !== entry.name && (
        <span className="absolute left-0 top-full z-40 mt-1 whitespace-nowrap rounded border border-edge bg-raised px-2 py-0.5 text-[11px] text-danger shadow-lg">
          {error}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Folder-size cell (lazy, cached, opt-in — explicitly approximate)
// ---------------------------------------------------------------------------

function DirSizeCell({ path }: { path: string }) {
  const enabled = useSettings((s) => s.showFolderSizes);
  const entry = useDirSizes(useCallback((s) => s.sizes[path], [path]));

  // Viewport-triggered: rows are virtualized, so mounting = visible.
  useEffect(() => {
    if (enabled) useDirSizes.getState().request(path);
  }, [enabled, path]);

  if (!enabled) return <>—</>;
  if (!entry) return <>…</>;
  if (entry.computing && entry.bytes == null) return <>…</>;
  return <span title="Approximate — computed lazily">{formatBytes(entry.bytes)}</span>;
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface RowProps {
  entry: Entry;
  paneId: PaneId;
  tabId: string;
  cols: ColWidths;
  onMouseDown: (e: React.MouseEvent, entry: Entry) => void;
  onDoubleClick: (entry: Entry) => void;
  onContextMenu: (e: React.MouseEvent, entry: Entry) => void;
  onRenameDone: (entry: Entry, committed: boolean, advance: boolean) => void;
}

const FileRow = memo(function FileRow({
  entry,
  paneId,
  tabId,
  cols,
  onMouseDown,
  onDoubleClick,
  onContextMenu,
  onRenameDone,
}: RowProps) {
  // perf rule: rows subscribe to their own selection state only
  const selected = usePanes(
    useCallback(
      (s) =>
        s.panes
          .find((p) => p.id === paneId)
          ?.tabs.find((t) => t.id === tabId)
          ?.selection.selected.has(entry.id) ?? false,
      [paneId, tabId, entry.id],
    ),
  );
  const isRenaming = useApp(
    (s) =>
      s.renaming != null &&
      s.renaming.paneId === paneId &&
      s.renaming.tabId === tabId &&
      s.renaming.entryId === entry.id,
  );
  const isCut = useApp(
    (s) => s.clipboard?.mode === "cut" && s.clipboard.paths.includes(entry.path),
  );
  const [dropping, setDropping] = useState(false);
  const springTimer = useRef<ReturnType<typeof setTimeout>>(null);

  const isNavigableDir = entry.kind === "dir" && !entry.isPackage;

  const clearSpring = () => {
    if (springTimer.current) {
      clearTimeout(springTimer.current);
      springTimer.current = null;
    }
  };

  return (
    <div
      className={clsx(
        "flex h-full items-center gap-2 rounded-[5px] px-2 text-[13px]",
        selected ? "bg-accent-dim" : "hover:bg-hov",
        (entry.hidden || isCut) && "opacity-60",
        dropping && "drop-ring",
      )}
      draggable={!isRenaming}
      onMouseDown={(e) => onMouseDown(e, entry)}
      onDoubleClick={() => !isRenaming && onDoubleClick(entry)}
      onContextMenu={(e) => onContextMenu(e, entry)}
      onDragStart={(e) => {
        const s = usePanes.getState();
        const tab = s.panes.find((p) => p.id === paneId)?.tabs.find((t) => t.id === tabId);
        if (!tab) return;
        const paths = tab.selection.selected.has(entry.id)
          ? tab.entries.filter((en) => tab.selection.selected.has(en.id)).map((en) => en.path)
          : [entry.path];
        if (useSettings.getState().dragOutEnabled) {
          // Native drag: reaches Finder/Mail/…; self-drops come back through
          // the bridge as internal moves. Kill-switch reverts to HTML5-only.
          e.preventDefault();
          startNativeDrag(paths, e.altKey);
          return;
        }
        beginInternalDrag(e, paths);
      }}
      onDragEnd={endInternalDrag}
      onDragOver={(e) => {
        if (!isNavigableDir || !dragHasPaths(e)) return;
        const paths = draggedPaths(e);
        if (paths.length > 0 && isInvalidDrop(paths, entry.path)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
        setDropping(true);
        if (!springTimer.current) {
          springTimer.current = setTimeout(() => {
            usePanes.getState().navigate(paneId, tabId, entry.path);
          }, SPRING_LOAD_MS);
        }
      }}
      onDragLeave={() => {
        setDropping(false);
        clearSpring();
      }}
      onDrop={(e) => {
        if (!isNavigableDir) return;
        e.preventDefault();
        e.stopPropagation();
        setDropping(false);
        clearSpring();
        dropPaths(e, entry.path);
      }}
    >
      <img
        src={iconUrl(entry.icon, 32)}
        alt=""
        className="h-4 w-4 shrink-0"
        draggable={false}
        loading="lazy"
      />
      {isRenaming ? (
        <RenameInput
          entry={entry}
          paneId={paneId}
          tabId={tabId}
          onDone={(committed, advance) => onRenameDone(entry, committed, advance)}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-primary">{entry.name}</span>
      )}
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-tertiary">
        {entry.kind === "symlink" && <span title={entry.linkTarget ?? "Symbolic link"}>⤳</span>}
        {entry.isAlias && <span title="Alias">↪</span>}
        {entry.noAccess && (
          <span title="No access">
            <Lock size={11} aria-hidden />
          </span>
        )}
      </span>
      <span className="shrink-0 truncate text-xs text-secondary" style={{ width: cols.kind }}>
        {entry.hydrated || entry.ext !== "" || entry.kind !== "unknown"
          ? entryKindLabel(entry)
          : ""}
      </span>
      <span className="tnum shrink-0 text-right text-xs text-secondary" style={{ width: cols.size }}>
        {entry.kind === "dir" && !entry.isPackage ? (
          <DirSizeCell path={entry.path} />
        ) : entry.hydrated ? (
          formatBytes(entry.size)
        ) : (
          <span className="shimmer" />
        )}
      </span>
      <span className="tnum shrink-0 truncate text-xs text-secondary" style={{ width: cols.mtime }}>
        {entry.hydrated ? formatDate(entry.mtime) : <span className="shimmer" />}
      </span>
      <span className="flex shrink-0 items-center gap-1" style={{ width: cols.tags }}>
        {entry.tags.slice(0, 5).map((t) => (
          <span
            key={t.color + t.name}
            title={t.name}
            className="h-2 w-2 rounded-full"
            style={{ background: tagCss(t.color) }}
          />
        ))}
      </span>
    </div>
  );
});

function GhostRow({ ghost, cols }: { ghost: GhostEntry; cols: ColWidths }) {
  return (
    <div className="ghost-row flex h-full items-center gap-2 px-2 text-[13px]">
      <span className="w-4 shrink-0 text-center text-xs text-tertiary">{ghost.isDir ? "▸" : "·"}</span>
      <span className="min-w-0 flex-1 truncate text-primary">{ghost.name}</span>
      <span className="shrink-0" style={{ width: cols.kind }} />
      <span className="shrink-0" style={{ width: cols.size }} />
      <span className="shrink-0 text-xs text-tertiary" style={{ width: cols.mtime }}>
        pending…
      </span>
      <span className="shrink-0" style={{ width: cols.tags }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function HeaderCell({
  label,
  sortKey,
  tab,
  paneId,
  width,
  align,
  onResize,
}: {
  label: string;
  sortKey: SortKey | null;
  tab: Tab;
  paneId: PaneId;
  width?: number;
  align?: "right";
  onResize?: (dx: number) => void;
}) {
  const setSort = usePanes((s) => s.setSort);
  const active = sortKey != null && tab.sort.key === sortKey;
  return (
    <div
      className={clsx("relative flex shrink-0 items-center", width == null && "min-w-0 flex-1")}
      style={width != null ? { width } : undefined}
    >
      <button
        className={clsx(
          "flex w-full cursor-default items-center gap-1 truncate px-1 py-0.5 text-[11px] font-medium",
          align === "right" && "justify-end",
          active ? "text-primary" : "text-tertiary hover:text-secondary",
        )}
        onClick={() => sortKey && setSort(paneId, tab.id, sortKey)}
      >
        <span className="truncate">{label}</span>
        {active && <span className="text-[9px]">{tab.sort.dir === "asc" ? "▲" : "▼"}</span>}
      </button>
      {onResize && (
        <div
          className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize"
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            let last = 0;
            const move = (me: MouseEvent) => {
              const dx = me.clientX - startX;
              onResize(dx - last);
              last = dx;
            };
            const up = () => {
              window.removeEventListener("mousemove", move);
              window.removeEventListener("mouseup", up);
            };
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", up);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FileList
// ---------------------------------------------------------------------------

export function FileList({ paneId, tabId }: { paneId: PaneId; tabId: string }) {
  const tab = usePanes(
    useCallback(
      (s) => s.panes.find((p) => p.id === paneId)?.tabs.find((t) => t.id === tabId),
      [paneId, tabId],
    ),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState<ColWidths>(loadCols);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const restoredListing = useRef<string>("");
  const density = useSettings((s) => s.density);
  const ROW_H = rowHeight(density);

  const visible = useMemo(
    () =>
      tab
        ? visibleEntries({ entries: tab.entries, filter: tab.filter, showHidden: tab.showHidden })
        : [],
    [tab?.entries, tab?.filter, tab?.showHidden], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const ghosts = tab?.ghosts ?? [];
  const rowCount = visible.length + ghosts.length;

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  // Re-measure rows when density flips.
  useEffect(() => {
    virtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ROW_H]);

  // Viewport-priority hydration for big listings (pass 2 skipped).
  const vItems = virtualizer.getVirtualItems();
  useViewportHydration(
    tab?.listingId,
    visible,
    vItems[0]?.index ?? 0,
    vItems[vItems.length - 1]?.index ?? -1,
  );

  // scroll restore once per listing settle
  useEffect(() => {
    if (!tab || !tab.listed) return;
    if (restoredListing.current === tab.listingId) return;
    restoredListing.current = tab.listingId;
    if (scrollRef.current) scrollRef.current.scrollTop = tab.scrollTop;
  }, [tab, tab?.listed, tab?.listingId, tab?.scrollTop]);

  // keep the keyboard lead row in view
  const leadId = tab?.selection.lead ?? null;
  useEffect(() => {
    if (leadId == null) return;
    const idx = visible.findIndex((e) => e.id === leadId);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  // persist column widths
  useEffect(() => {
    try {
      localStorage.setItem("fazi-cols", JSON.stringify(cols));
    } catch {
      /* ignore */
    }
  }, [cols]);

  // report scroll position (throttled) for history snapshots
  const scrollReport = useRef<ReturnType<typeof setTimeout>>(null);
  const onScroll = () => {
    if (scrollReport.current) return;
    scrollReport.current = setTimeout(() => {
      scrollReport.current = null;
      const el = scrollRef.current;
      if (el && tab) usePanes.getState().setScrollTop(paneId, tabId, el.scrollTop);
    }, 150);
  };

  // Finder drag-in drop zone: row-level dir targeting, else this tab's dir
  useEffect(() => {
    if (!tab) return;
    const unregister = registerDropZone({
      priority: 10,
      hitTest: (x, y) => {
        const el = scrollRef.current;
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
        const state = usePanes.getState();
        const t = state.panes.find((p) => p.id === paneId)?.tabs.find((tt) => tt.id === tabId);
        if (!t) return null;
        const vis = visibleEntries(t);
        const idx = Math.floor((y - rect.top + el.scrollTop) / ROW_H);
        const entry = vis[idx];
        if (entry && entry.kind === "dir" && !entry.isPackage) {
          return { action: "copyTo", destDir: entry.path };
        }
        return { action: "copyTo", destDir: t.path };
      },
    });
    return unregister;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, tabId, tab != null, ROW_H]);

  const setSelection = usePanes((s) => s.setSelection);
  const openEntry = usePanes((s) => s.openEntry);

  const handleRowMouseDown = useCallback(
    (e: React.MouseEvent, entry: Entry) => {
      if (e.button === 2) return; // context menu handles its own selection
      useApp.getState().setActivePane(paneId);
      const state = usePanes.getState();
      const t = state.panes.find((p) => p.id === paneId)?.tabs.find((tt) => tt.id === tabId);
      if (!t) return;
      const order = visibleEntries(t).map((en) => en.id);
      const sel = t.selection;
      if (e.shiftKey) {
        setSelection(paneId, tabId, shiftRange(sel, order, entry.id));
      } else if (e.metaKey) {
        setSelection(paneId, tabId, cmdToggle(sel, entry.id));
      } else if (!sel.selected.has(entry.id)) {
        setSelection(paneId, tabId, clickSelect(entry.id));
      }
      // clicking an already-selected row keeps the multi-selection (drag support)
    },
    [paneId, tabId, setSelection],
  );

  const handleDoubleClick = useCallback(
    (entry: Entry) => openEntry(paneId, tabId, entry),
    [openEntry, paneId, tabId],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, entry: Entry) => {
      e.preventDefault();
      e.stopPropagation();
      useApp.getState().setActivePane(paneId);
      const state = usePanes.getState();
      const t = state.panes.find((p) => p.id === paneId)?.tabs.find((tt) => tt.id === tabId);
      if (!t) return;
      if (!t.selection.selected.has(entry.id)) {
        setSelection(paneId, tabId, clickSelect(entry.id));
      }
      showMenu(e.clientX, e.clientY, entryMenuItems(paneId, tabId, entry));
    },
    [paneId, tabId, setSelection],
  );

  const handleRenameDone = useCallback(
    (entry: Entry, _committed: boolean, advance: boolean) => {
      const app = useApp.getState();
      app.stopRename();
      if (!advance) return;
      const state = usePanes.getState();
      const t = state.panes.find((p) => p.id === paneId)?.tabs.find((tt) => tt.id === tabId);
      if (!t) return;
      const vis = visibleEntries(t);
      const idx = vis.findIndex((en) => en.id === entry.id);
      const next = vis[idx + 1];
      if (next) {
        setSelection(paneId, tabId, clickSelect(next.id));
        app.startRename({ paneId, tabId, entryId: next.id });
      }
    },
    [paneId, tabId, setSelection],
  );

  // marquee selection on empty-area drag
  const beginMarquee = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const el = scrollRef.current;
    if (!el || !tab) return;
    // only when the press lands on list background (not a row)
    const target = e.target as HTMLElement;
    if (target.closest("[data-row]")) return;
    useApp.getState().setActivePane(paneId);
    const rect = el.getBoundingClientRect();
    const start = { x: e.clientX - rect.left + el.scrollLeft, y: e.clientY - rect.top + el.scrollTop };
    const additive = e.metaKey || e.shiftKey;
    const state = usePanes.getState();
    const t0 = state.panes.find((p) => p.id === paneId)?.tabs.find((tt) => tt.id === tabId);
    const base = additive && t0 ? new Set(t0.selection.selected) : null;
    const itemRects = visible.map((en, i) => ({
      id: en.id,
      rect: { x: 0, y: i * ROW_H, width: Math.max(el.scrollWidth, el.clientWidth), height: ROW_H },
    }));
    let moved = false;

    const onMove = (me: MouseEvent) => {
      const r = el.getBoundingClientRect();
      const cur = { x: me.clientX - r.left + el.scrollLeft, y: me.clientY - r.top + el.scrollTop };
      const rectSel = dragRect(start, cur);
      if (!moved && (rectSel.width > 3 || rectSel.height > 3)) moved = true;
      if (!moved) return;
      setMarquee(rectSel);
      usePanes.getState().setSelection(paneId, tabId, marqueeSelect(rectSel, itemRects, base));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setMarquee(null);
      if (!moved && !additive) {
        usePanes
          .getState()
          .setSelection(paneId, tabId, { selected: new Set(), anchor: null, lead: null });
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (!tab) return null;

  if (tab.error) {
    return <ListingError code={tab.error.code} message={tab.error.message} />;
  }

  const showEmpty = !tab.loading && tab.listed && tab.entries.length === 0 && ghosts.length === 0;
  const showNoMatch =
    !tab.loading && tab.entries.length > 0 && visible.length === 0 && tab.filter !== "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header */}
      <div className="flex h-6 shrink-0 items-center gap-2 border-b border-edge px-2">
        <span className="w-4 shrink-0" />
        <HeaderCell label="Name" sortKey="name" tab={tab} paneId={paneId} />
        <span className="w-0 shrink-0" />
        <HeaderCell
          label="Kind"
          sortKey="kind"
          tab={tab}
          paneId={paneId}
          width={cols.kind}
          onResize={(dx) => setCols((c) => ({ ...c, kind: Math.max(60, c.kind + dx) }))}
        />
        <HeaderCell
          label="Size"
          sortKey="size"
          tab={tab}
          paneId={paneId}
          width={cols.size}
          align="right"
          onResize={(dx) => setCols((c) => ({ ...c, size: Math.max(56, c.size + dx) }))}
        />
        <HeaderCell
          label="Date Modified"
          sortKey="mtime"
          tab={tab}
          paneId={paneId}
          width={cols.mtime}
          onResize={(dx) => setCols((c) => ({ ...c, mtime: Math.max(80, c.mtime + dx) }))}
        />
        <HeaderCell label="Tags" sortKey={null} tab={tab} paneId={paneId} width={cols.tags} />
      </div>

      {/* body */}
      {showEmpty ? (
        <div
          className="min-h-0 flex-1"
          onContextMenu={(e) => {
            e.preventDefault();
            showMenu(e.clientX, e.clientY, emptyAreaMenuItems(paneId, tabId));
          }}
        >
          <EmptyFolder />
        </div>
      ) : showNoMatch ? (
        <NoFilterMatches filter={tab.filter} />
      ) : (
        <div
          ref={scrollRef}
          className="relative min-h-0 flex-1 overflow-auto"
          onScroll={onScroll}
          onMouseDown={beginMarquee}
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest("[data-row]")) return;
            e.preventDefault();
            showMenu(e.clientX, e.clientY, emptyAreaMenuItems(paneId, tabId));
          }}
          onDragOver={(e) => {
            if (!dragHasPaths(e)) return;
            const paths = draggedPaths(e);
            if (paths.length > 0 && isInvalidDrop(paths, tab.path)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
          }}
          onDrop={(e) => {
            e.preventDefault();
            dropPaths(e, tab.path);
          }}
        >
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const isGhost = vi.index >= visible.length;
              const style: React.CSSProperties = {
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: vi.size,
                transform: `translateY(${vi.start}px)`,
              };
              if (isGhost) {
                const ghost = ghosts[vi.index - visible.length];
                return (
                  <div key={`g${ghost.id}`} style={style} data-row>
                    <GhostRow ghost={ghost} cols={cols} />
                  </div>
                );
              }
              const entry = visible[vi.index];
              return (
                <div key={entry.id} style={style} data-row>
                  <FileRow
                    entry={entry}
                    paneId={paneId}
                    tabId={tabId}
                    cols={cols}
                    onMouseDown={handleRowMouseDown}
                    onDoubleClick={handleDoubleClick}
                    onContextMenu={handleContextMenu}
                    onRenameDone={handleRenameDone}
                  />
                </div>
              );
            })}
            {marquee && (
              <div
                className="marquee-rect"
                style={{
                  left: marquee.x,
                  top: marquee.y,
                  width: marquee.width,
                  height: marquee.height,
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
