/** One pane: tab strip + content (list/grid, or global search results). */
import clsx from "clsx";
import { usePanes, type Pane as PaneModel } from "../../stores/panes";
import { useApp, type PaneId } from "../../stores/app";
import { useSettings } from "../../stores/settings";
import { TabStrip } from "./TabStrip";
import { FileList } from "./FileList";
import { GridView } from "./GridView";
import { SearchResults } from "./SearchResults";

export function Pane({ paneId }: { paneId: PaneId }) {
  const pane = usePanes((s) => s.panes.find((p) => p.id === paneId));
  const activePaneId = useApp((s) => s.activePaneId);
  const setActivePane = useApp((s) => s.setActivePane);
  const searchActive = useApp((s) => s.globalSearch.active);
  const viewMode = useSettings((s) => s.viewMode);

  if (!pane) return null;
  const isActive = activePaneId === pane.id;
  const showSearch = searchActive && isActive;

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
