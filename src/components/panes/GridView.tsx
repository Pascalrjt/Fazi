/** Icon grid view: thumbnails, same selection model, virtualized by row. */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Entry } from "../../types/ipc";
import { thumbUrl } from "../../types/ipc";
import { findTab, usePanes, visibleEntries } from "../../stores/panes";
import { useApp, type PaneId } from "../../stores/app";
import { RenameInput } from "./RenameInput";
import { showMenu } from "../../stores/menu";
import { emptyAreaMenuItems } from "../menus/entryMenu";
import { setGridColumns } from "../../lib/commands";
import { activeDragPaths, isInvalidDrop, onDropHover, registerDropZone } from "../../lib/dnd";
import { beginEntryDrag, usePaneInteractions } from "../../hooks/usePaneInteractions";
import { useViewportHydration } from "../../hooks/useViewportHydration";
import { EmptyFolder, ListingError, NoFilterMatches } from "./EmptyStates";

const CELL_W = 112;
const CELL_H = 112;
/** Content inset of the grid's `p-2` scroll container — must track that class. */
const GRID_PAD = 8;

const GridCell = memo(function GridCell({
  entry,
  paneId,
  tabId,
  onMouseDown,
  onDoubleClick,
  onContextMenu,
  onRenameDone,
}: {
  entry: Entry;
  paneId: PaneId;
  tabId: string;
  onMouseDown: (e: React.MouseEvent, entry: Entry) => void;
  onDoubleClick: (entry: Entry) => void;
  onContextMenu: (e: React.MouseEvent, entry: Entry) => void;
  onRenameDone: (entry: Entry, advance: boolean) => void;
}) {
  const selected = usePanes(
    useCallback(
      (s) => findTab(s, paneId, tabId)?.selection.selected.has(entry.id) ?? false,
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
  const [dropping, setDropping] = useState(false);
  const isNavigableDir = entry.kind === "dir" && !entry.isPackage;

  // Drop-ring during native/pointer drags, keyed by the registry zone's hit.
  useEffect(() => {
    if (!isNavigableDir) return;
    return onDropHover((h) =>
      setDropping(
        h != null &&
          h.hit.action === "copyTo" &&
          h.hit.targetKey === `cell:${paneId}:${tabId}:${entry.id}`,
      ),
    );
  }, [paneId, tabId, entry.id, isNavigableDir]);

  return (
    <div
      data-row
      data-entry-id={entry.id}
      data-pane-id={paneId}
      className={clsx(
        "flex cursor-default flex-col items-center gap-1 rounded-lg p-2",
        entry.hidden && "opacity-60",
        dropping && "drop-ring",
      )}
      style={{ width: CELL_W, height: CELL_H }}
      draggable={!isRenaming}
      onMouseDown={(e) => !isRenaming && onMouseDown(e, entry)}
      onDoubleClick={() => !isRenaming && onDoubleClick(entry)}
      onContextMenu={(e) => onContextMenu(e, entry)}
      onDragStart={(e) => {
        // dragstart is only the gesture trigger — beginEntryDrag runs the
        // real drag loop (HTML5 drops are dead under wry).
        e.preventDefault();
        beginEntryDrag(paneId, tabId, entry, e.altKey);
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
      {isRenaming ? (
        // Replaces the label rather than nesting inside it: that span is
        // `truncate` (overflow:hidden), which would clip the caret.
        <RenameInput
          entry={entry}
          paneId={paneId}
          tabId={tabId}
          wrapperClassName="relative flex w-full min-w-0 justify-center"
          onDone={(_committed, advance) => onRenameDone(entry, advance)}
        />
      ) : (
        <span
          className={clsx(
            "max-w-full truncate rounded px-1 text-center text-xs leading-tight",
            selected ? "bg-accent text-white" : "text-primary",
          )}
        >
          {entry.name}
        </span>
      )}
    </div>
  );
});

export function GridView({ paneId, tabId }: { paneId: PaneId; tabId: string }) {
  const tab = usePanes(
    useCallback((s) => findTab(s, paneId, tabId), [paneId, tabId]),
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
  // Ref mirror so long-lived closures (drop-zone hitTest) can read the
  // memoized visible cells without re-filtering the raw entries per hover move.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

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

  // Viewport-priority hydration for big listings (pass 2 skipped). Grid rows
  // hold `columns` entries each.
  const vRows = virtualizer.getVirtualItems();
  useViewportHydration(
    tab?.listingId,
    visible,
    (vRows[0]?.index ?? 0) * columns,
    ((vRows[vRows.length - 1]?.index ?? -1) + 1) * columns - 1,
  );

  // keep lead in view
  const leadId = tab?.selection.lead ?? null;
  useEffect(() => {
    if (leadId == null) return;
    const idx = visible.findIndex((e) => e.id === leadId);
    if (idx >= 0) virtualizer.scrollToIndex(Math.floor(idx / columns), { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  // Native drop zone: dir cells are individual targets (ring + spring), any
  // other point drops into the tab dir. Cell resolution mirrors the layout
  // arithmetic: rows of `columns` cells inside the p-2 padded container.
  useEffect(() => {
    if (!tab) return;
    return registerDropZone({
      priority: 5,
      hitTest: (x, y) => {
        const el = scrollRef.current;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
        const t = findTab(usePanes.getState(), paneId, tabId);
        if (!t) return null;
        const cols = Math.max(1, Math.floor(el.clientWidth / CELL_W));
        const col = Math.floor((x - r.left - GRID_PAD) / CELL_W);
        const row = Math.floor((y - r.top + el.scrollTop - GRID_PAD) / CELL_H);
        const entry =
          col >= 0 && col < cols && row >= 0 ? visibleRef.current[row * cols + col] : undefined;
        if (entry && entry.kind === "dir" && !entry.isPackage) {
          const paths = activeDragPaths();
          if (paths == null || !isInvalidDrop(paths, entry.path)) {
            const key = `cell:${paneId}:${tabId}:${entry.id}`;
            return {
              action: "copyTo",
              destDir: entry.path,
              targetKey: key,
              spring: {
                key,
                open: () => usePanes.getState().navigate(paneId, tabId, entry.path),
              },
            };
          }
        }
        return { action: "copyTo", destDir: t.path };
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, tabId, tab != null]);

  const setSelection = usePanes((s) => s.setSelection);
  const { handleMouseDown, handleDoubleClick, handleContextMenu, handleRenameDone } =
    usePaneInteractions(paneId, tabId);

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
                  onDoubleClick={handleDoubleClick}
                  onContextMenu={handleContextMenu}
                  onRenameDone={handleRenameDone}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
