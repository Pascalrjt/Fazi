/**
 * One pane, drawn as a card on the window frame: a header with the path
 * (or the search scopes while a global search runs), banners, the list or
 * grid, and a status footer. The rightmost card's header also carries the
 * view controls; when the sidebar is hidden or docked right, the leftmost
 * card makes room for the traffic lights and takes the window controls.
 */
import clsx from "clsx";
import { usePanes, activeTabOf } from "../../stores/panes";
import type { ListErrorCode } from "../../types/ipc";
import * as ipc from "../../lib/ipc";
import { useApp, type PaneId } from "../../stores/app";
import { useSettings } from "../../stores/settings";
import { useVolumes } from "../../stores/volumes";
import { confirmEmptyTrash } from "../../lib/actions";
import { pluralize } from "../../lib/format";
import { PathBar } from "../chrome/PathBar";
import { SearchField, SearchScopes } from "../chrome/SearchField";
import { NavButtons, SidebarToggle, ViewControls } from "../chrome/WindowControls";
import { PaneFooter } from "./PaneFooter";
import { FileList } from "./FileList";
import { GridView } from "./GridView";
import { SearchResults } from "./SearchResults";
import { CleanupBanner } from "./CleanupBanner";
import { useCleanup } from "../../stores/cleanup";

/** Shown while browsing ~/.Trash. The count is this listing only; the Empty
 *  Trash confirm dialog totals every volume's trash. */
export function TrashBanner({
  itemCount,
  loading,
  error,
}: {
  itemCount: number;
  loading: boolean;
  error: { code: ListErrorCode | "unknown"; message: string } | null;
}) {
  if (error) {
    return (
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-edge px-3 text-xs">
        <span className="text-secondary">Trash contents unavailable</span>
        <div className="flex-1" />
        {error.code === "permissionDenied" && (
          <button
            className="cursor-default rounded border border-edge px-2 py-0.5 text-[11px] text-secondary hover:bg-hov"
            onClick={() => void ipc.openFullDiskAccessSettings().catch(() => {})}
          >
            Grant access…
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-edge px-3 text-xs">
      <span className="text-secondary">
        {loading ? "Reading Trash…" : itemCount === 0 ? "The Trash is empty" : pluralize(itemCount, "item")}
      </span>
      <div className="flex-1" />
      <button
        className="cursor-default rounded border border-edge px-2 py-0.5 text-[11px] text-secondary hover:bg-hov"
        onClick={() => confirmEmptyTrash()}
        disabled={loading}
      >
        Empty Trash…
      </button>
    </div>
  );
}

export function Pane({
  paneId,
  isFirst,
  isLast,
}: {
  paneId: PaneId;
  /** Leftmost card: hosts the window controls when the sidebar can't. */
  isFirst: boolean;
  /** Rightmost card: hosts the view controls. */
  isLast: boolean;
}) {
  const pane = usePanes((s) => s.panes.find((p) => p.id === paneId));
  const split = usePanes((s) => s.split);
  const activePaneId = useApp((s) => s.activePaneId);
  const setActivePane = useApp((s) => s.setActivePane);
  const searchActive = useApp((s) => s.globalSearch.active);
  const viewMode = useSettings((s) => s.viewMode);
  const paneAccentLine = useSettings((s) => s.paneAccentLine);
  const sidebarCollapsed = useSettings((s) => s.sidebarCollapsed);
  const sidebarPosition = useSettings((s) => s.sidebarPosition);
  const trashPath = useVolumes((s) => s.folders?.trash ?? null);
  const cleanupFolders = useCleanup((s) => s.folders);

  if (!pane) return null;
  const isActive = activePaneId === pane.id;
  const showSearch = searchActive && isActive;
  const tab = activeTabOf(pane);
  const inTrash = !showSearch && trashPath != null && tab?.path === trashPath;
  const inCleanupFolder = !showSearch && tab != null && cleanupFolders.has(tab.path);
  // The traffic lights sit over the window's top-left corner.
  const needsTrafficPad = isFirst && (sidebarCollapsed || sidebarPosition === "right");

  return (
    <div
      data-vim-surface="pane"
      data-pane-id={pane.id}
      tabIndex={-1}
      className={clsx(
        "keyboard-surface relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] bg-pane shadow-[var(--shadow-card)] outline-none",
        paneAccentLine && "pane-focus-ring",
      )}
      onMouseDownCapture={(e) => {
        // Header controls keep keyboard ownership where it was.
        if ((e.target as HTMLElement).closest("button, input")) return;
        e.currentTarget.focus({ preventScroll: true });
        if (!isActive) setActivePane(paneId);
      }}
    >
      {tab?.loading && <div className="loading-bar" />}
      <div
        className={clsx(
          "flex h-11 shrink-0 items-center gap-1.5 border-b border-edge pr-2",
          needsTrafficPad ? "traffic-pad" : "pl-2.5",
        )}
        onMouseDown={() => {
          if (!isActive) setActivePane(paneId);
        }}
        data-tauri-drag-region
      >
        {isFirst && sidebarCollapsed && (
          <>
            <NavButtons />
            <SidebarToggle />
          </>
        )}
        {showSearch ? (
          <div className="flex min-w-0 flex-1 items-center" data-tauri-drag-region>
            <SearchScopes />
          </div>
        ) : (
          <PathBar paneId={paneId} maxSegments={split ? 3 : 4} />
        )}
        {isLast && (
          <>
            {sidebarCollapsed && <SearchField className="mr-1 w-[200px] shrink-0" />}
            <ViewControls />
          </>
        )}
      </div>
      {inTrash && (
        <TrashBanner
          itemCount={tab?.entries.length ?? 0}
          loading={tab?.loading ?? true}
          error={tab?.error ?? null}
        />
      )}
      {inCleanupFolder && tab && (
        <CleanupBanner paneId={pane.id} tabId={tab.id} folder={tab.path} />
      )}
      <div className="min-h-0 flex-1">
        {showSearch ? (
          <SearchResults />
        ) : viewMode === "grid" ? (
          <GridView paneId={paneId} tabId={pane.activeTabId} />
        ) : (
          <FileList paneId={paneId} tabId={pane.activeTabId} />
        )}
      </div>
      <PaneFooter paneId={paneId} />
    </div>
  );
}
