/** Icon grid view: thumbnails, same selection model, virtualized by row. */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Entry } from "../../types/ipc";
import { thumbUrl } from "../../types/ipc";
import { usePanes, visibleEntries } from "../../stores/panes";
import { useApp, type PaneId } from "../../stores/app";
import { showMenu } from "../../stores/menu";
import { entryMenuItems, emptyAreaMenuItems } from "../menus/entryMenu";
import { clickSelect, cmdToggle, shiftRange } from "../../lib/selection";
import { setGridColumns } from "../../lib/commands";
import {
  beginInternalDrag,
  dragHasPaths,
  draggedPaths,
  dropPaths,
  endInternalDrag,
  isInvalidDrop,
  registerDropZone,
} from "../../lib/dnd";
import { EmptyFolder, ListingError, NoFilterMatches } from "./EmptyStates";

const CELL_W = 112;
const CELL_H = 112;

const GridCell = memo(function GridCell({
  entry,
  paneId,
  tabId,
  onMouseDown,
  onDoubleClick,
  onContextMenu,
}: {
  entry: Entry;
  paneId: PaneId;
  tabId: string;
  onMouseDown: (e: React.MouseEvent, entry: Entry) => void;
  onDoubleClick: (entry: Entry) => void;
  onContextMenu: (e: React.MouseEvent, entry: Entry) => void;
}) {
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
  const [dropping, setDropping] = useState(false);
  const isNavigableDir = entry.kind === "dir" && !entry.isPackage;

  return (
    <div
      data-row
      className={clsx(
        "flex cursor-default flex-col items-center gap-1 rounded-lg p-2",
        entry.hidden && "opacity-60",
        dropping && "drop-ring",
      )}
      style={{ width: CELL_W, height: CELL_H }}
      draggable
      onMouseDown={(e) => onMouseDown(e, entry)}
      onDoubleClick={() => onDoubleClick(entry)}
      onContextMenu={(e) => onContextMenu(e, entry)}
      onDragStart={(e) => {
        const s = usePanes.getState();
        const tab = s.panes.find((p) => p.id === paneId)?.tabs.find((t) => t.id === tabId);
        if (!tab) return;
        const paths = tab.selection.selected.has(entry.id)
          ? tab.entries.filter((en) => tab.selection.selected.has(en.id)).map((en) => en.path)
          : [entry.path];
        beginInternalDrag(e, paths);
      }}
      onDragEnd={endInternalDrag}
      onDragOver={(e) => {
        if (!isNavigableDir || !dragHasPaths(e)) return;
        const paths = draggedPaths(e);
        if (paths.length > 0 && isInvalidDrop(paths, entry.path)) return;
        e.preventDefault();
        e.stopPropagation();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        if (!isNavigableDir) return;
        e.preventDefault();
        e.stopPropagation();
        setDropping(false);
        dropPaths(e, entry.path);
      }}
    >
      <div className={clsx("rounded-md p-1", selected && "bg-accent-dim")}>
        <img
          src={thumbUrl(entry.icon, 128)}
          alt=""
          className="h-14 w-14 object-contain"
          draggable={false}
          loading="lazy"
        />
      </div>
      <span
        className={clsx(
          "max-w-full truncate rounded px-1 text-center text-xs leading-tight",
          selected ? "bg-accent text-white" : "text-primary",
        )}
      >
        {entry.name}
      </span>
    </div>
  );
});

export function GridView({ paneId, tabId }: { paneId: PaneId; tabId: string }) {
  const tab = usePanes(
    useCallback(
      (s) => s.panes.find((p) => p.id === paneId)?.tabs.find((t) => t.id === tabId),
      [paneId, tabId],
    ),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(4);

  const visible = useMemo(
    () =>
      tab
        ? visibleEntries({ entries: tab.entries, filter: tab.filter, showHidden: tab.showHidden })
        : [],
    [tab?.entries, tab?.filter, tab?.showHidden], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // measure columns for keyboard navigation
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const n = Math.max(1, Math.floor(el.clientWidth / CELL_W));
      setColumns(n);
      setGridColumns(n);
    };
    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(el);
    return () => obs.disconnect();
  }, [tab != null]);

  useEffect(() => () => setGridColumns(1), []);

  const rowCount = Math.ceil(visible.length / columns);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CELL_H,
    overscan: 6,
  });

  // keep lead in view
  const leadId = tab?.selection.lead ?? null;
  useEffect(() => {
    if (leadId == null) return;
    const idx = visible.findIndex((e) => e.id === leadId);
    if (idx >= 0) virtualizer.scrollToIndex(Math.floor(idx / columns), { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  // Finder drag-in: whole grid drops into the tab dir
  useEffect(() => {
    if (!tab) return;
    return registerDropZone({
      priority: 5,
      hitTest: (x, y) => {
        const el = scrollRef.current;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
        return (
          usePanes.getState().panes.find((p) => p.id === paneId)?.tabs.find((t) => t.id === tabId)
            ?.path ?? null
        );
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, tabId, tab != null]);

  const setSelection = usePanes((s) => s.setSelection);
  const openEntry = usePanes((s) => s.openEntry);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, entry: Entry) => {
      if (e.button === 2) return;
      useApp.getState().setActivePane(paneId);
      const t = usePanes
        .getState()
        .panes.find((p) => p.id === paneId)
        ?.tabs.find((tt) => tt.id === tabId);
      if (!t) return;
      const order = visibleEntries(t).map((en) => en.id);
      const sel = t.selection;
      if (e.shiftKey) setSelection(paneId, tabId, shiftRange(sel, order, entry.id));
      else if (e.metaKey) setSelection(paneId, tabId, cmdToggle(sel, entry.id));
      else if (!sel.selected.has(entry.id)) setSelection(paneId, tabId, clickSelect(entry.id));
    },
    [paneId, tabId, setSelection],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, entry: Entry) => {
      e.preventDefault();
      e.stopPropagation();
      useApp.getState().setActivePane(paneId);
      const t = usePanes
        .getState()
        .panes.find((p) => p.id === paneId)
        ?.tabs.find((tt) => tt.id === tabId);
      if (!t) return;
      if (!t.selection.selected.has(entry.id)) setSelection(paneId, tabId, clickSelect(entry.id));
      showMenu(e.clientX, e.clientY, entryMenuItems(paneId, tabId, entry));
    },
    [paneId, tabId, setSelection],
  );

  if (!tab) return null;
  if (tab.error) return <ListingError code={tab.error.code} message={tab.error.message} />;

  const showEmpty = !tab.loading && tab.listed && tab.entries.length === 0;
  if (showEmpty) {
    return (
      <div
        className="h-full"
        onContextMenu={(e) => {
          e.preventDefault();
          showMenu(e.clientX, e.clientY, emptyAreaMenuItems(paneId, tabId));
        }}
      >
        <EmptyFolder />
      </div>
    );
  }
  if (!tab.loading && tab.entries.length > 0 && visible.length === 0 && tab.filter !== "") {
    return <NoFilterMatches filter={tab.filter} />;
  }

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-auto p-2"
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest("[data-row]")) {
          useApp.getState().setActivePane(paneId);
          if (!e.metaKey && !e.shiftKey) {
            setSelection(paneId, tabId, { selected: new Set(), anchor: null, lead: null });
          }
        }
      }}
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
      }}
      onDrop={(e) => {
        e.preventDefault();
        dropPaths(e, tab.path);
      }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const rowEntries = visible.slice(vi.index * columns, (vi.index + 1) * columns);
          return (
            <div
              key={vi.index}
              className="flex"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                height: vi.size,
                transform: `translateY(${vi.start}px)`,
              }}
            >
              {rowEntries.map((entry) => (
                <GridCell
                  key={entry.id}
                  entry={entry}
                  paneId={paneId}
                  tabId={tabId}
                  onMouseDown={handleMouseDown}
                  onDoubleClick={(en) => openEntry(paneId, tabId, en)}
                  onContextMenu={handleContextMenu}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
