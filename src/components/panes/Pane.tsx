/** One pane: tab strip + content (list/grid, or global search results). */
import clsx from "clsx";
import { usePanes, activeTabOf, type Pane as PaneModel } from "../../stores/panes";
import { useApp, type PaneId } from "../../stores/app";
import { useSettings } from "../../stores/settings";
import { useVolumes } from "../../stores/volumes";
import { confirmEmptyTrash } from "../../lib/actions";
import { pluralize } from "../../lib/format";
import { TabStrip } from "./TabStrip";
import { FileList } from "./FileList";
import { GridView } from "./GridView";
import { SearchResults } from "./SearchResults";

/** Shown while browsing ~/.Trash. The count is this listing only; the Empty
 *  Trash confirm dialog totals every volume's trash. */
function TrashBanner({ itemCount }: { itemCount: number }) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-edge bg-window px-3 text-xs">
      <span className="text-secondary">
        {itemCount === 0 ? "The Trash is empty" : pluralize(itemCount, "item")}
      </span>
      <div className="flex-1" />
      <button
        className="cursor-default rounded border border-edge px-2 py-0.5 text-[11px] text-secondary hover:bg-hov"
        onClick={() => confirmEmptyTrash()}
      >
        Empty Trash…
      </button>
    </div>
  );
}

export function Pane({ paneId }: { paneId: PaneId }) {
  const pane = usePanes((s) => s.panes.find((p) => p.id === paneId));
  const activePaneId = useApp((s) => s.activePaneId);
  const setActivePane = useApp((s) => s.setActivePane);
  const searchActive = useApp((s) => s.globalSearch.active);
  const viewMode = useSettings((s) => s.viewMode);
  const trashPath = useVolumes((s) => s.folders?.trash ?? null);

  if (!pane) return null;
  const isActive = activePaneId === pane.id;
  const showSearch = searchActive && isActive;
  const tab = activeTabOf(pane);
  const inTrash = !showSearch && trashPath != null && tab?.path === trashPath;

  return (
    <div
      className={clsx(
        "flex min-w-0 flex-1 flex-col bg-pane",
        !isActive && "opacity-80",
      )}
      onMouseDownCapture={() => {
        if (!isActive) setActivePane(paneId);
      }}
    >
      <TabStrip pane={pane as PaneModel} />
      {inTrash && <TrashBanner itemCount={tab?.entries.length ?? 0} />}
      <div className="min-h-0 flex-1">
        {showSearch ? (
          <SearchResults />
        ) : viewMode === "grid" ? (
          <GridView paneId={paneId} tabId={pane.activeTabId} />
        ) : (
          <FileList paneId={paneId} tabId={pane.activeTabId} />
        )}
      </div>
    </div>
  );
}
