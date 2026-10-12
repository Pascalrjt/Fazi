/**
 * One pane, drawn as a card below the title strip: banners, the list or
 * grid, and a status footer. The path lives in the title strip's address
 * field (it follows the active pane), so in dual pane each card names its
 * folder in a slim caption instead. While a global search runs, its scope
 * controls sit at the top of the active card.
 */
import clsx from "clsx";
import { usePanes, activeTabOf } from "../../stores/panes";
import type { ListErrorCode } from "../../types/ipc";
import * as ipc from "../../lib/ipc";
import { useApp, type PaneId } from "../../stores/app";
import { useSettings } from "../../stores/settings";
import { useVolumes } from "../../stores/volumes";
import { confirmEmptyTrash } from "../../lib/actions";
import { basename, pluralize } from "../../lib/format";
import { SearchScopes } from "../chrome/SearchField";
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

/** Two-tone rectangle marking which half of the window a pane is. */
function PaneMark({ side }: { side: PaneId }) {
  return (
    <span
      className="relative inline-block h-2.5 w-3.5 shrink-0 overflow-hidden rounded-[2px] border-[1.25px] border-current align-middle"
      aria-hidden
    >
      <span
        className={clsx(
          "absolute inset-y-0 w-1/2 bg-current opacity-55",
          side === "left" ? "left-0" : "right-0",
        )}
      />
    </span>
  );
}

export function Pane({ paneId }: { paneId: PaneId }) {
  const pane = usePanes((s) => s.panes.find((p) => p.id === paneId));
  const split = usePanes((s) => s.split);
  const activePaneId = useApp((s) => s.activePaneId);
  const setActivePane = useApp((s) => s.setActivePane);
  const searchActive = useApp((s) => s.globalSearch.active);
  const viewMode = useSettings((s) => s.viewMode);
  // The ring only earns its place in Vim mode, where gs moves keyboard
  // ownership between surfaces; otherwise the caption, tab group, and
  // address-field chip already mark the active pane.
  const focusRing = useSettings((s) => s.paneAccentLine && s.vimMode);
  const trashPath = useVolumes((s) => s.folders?.trash ?? null);
  const cleanupFolders = useCleanup((s) => s.folders);

  if (!pane) return null;
  const isActive = activePaneId === pane.id;
  const showSearch = searchActive && isActive;
  const tab = activeTabOf(pane);
  const inTrash = !showSearch && trashPath != null && tab?.path === trashPath;
  const inCleanupFolder = !showSearch && tab != null && cleanupFolders.has(tab.path);

  return (
    <div
      data-vim-surface="pane"
      data-pane-id={pane.id}
      tabIndex={-1}
      className={clsx(
        "keyboard-surface relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] bg-pane shadow-[var(--shadow-card)] outline-none",
        focusRing && "pane-focus-ring",
      )}
      onMouseDownCapture={(e) => {
        // Controls inside the card keep keyboard ownership where it was.
        if ((e.target as HTMLElement).closest("button, input")) {
          if (!isActive) setActivePane(paneId);
          return;
        }
        e.currentTarget.focus({ preventScroll: true });
        if (!isActive) setActivePane(paneId);
      }}
    >
      {tab?.loading && <div className="loading-bar" />}
      {split && tab && (
        <div
          className={clsx(
            "flex h-[30px] shrink-0 items-center gap-2 border-b border-edge px-3 text-[12px] font-semibold",
            isActive ? "text-primary" : "text-secondary",
          )}
          title={tab.path}
        >
          <span className={clsx("flex", isActive ? "text-accent" : "text-tertiary")}>
            <PaneMark side={pane.id} />
          </span>
          <span className="min-w-0 truncate">{basename(tab.path) || "/"}</span>
        </div>
      )}
      {showSearch && (
        <div className="flex h-[38px] shrink-0 items-center border-b border-edge px-2.5">
          <SearchScopes />
        </div>
      )}
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
