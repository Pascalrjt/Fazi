/** Per-pane tab strip: Finder-style tabs (active tab connected to the
 *  content below), optional active accent top-border, +, ✕, middle-click
 *  close. */
import clsx from "clsx";
import { Plus, X } from "lucide-react";
import { usePanes, type Pane } from "../../stores/panes";
import { useApp, type PaneId } from "../../stores/app";
import { useSettings } from "../../stores/settings";
import { basename } from "../../lib/format";
import { showMenu } from "../../stores/menu";

export function TabStrip({ pane }: { pane: Pane }) {
  const activePaneId = useApp((s) => s.activePaneId);
  const setActivePane = useApp((s) => s.setActivePane);
  const paneAccentLine = useSettings((s) => s.paneAccentLine);
  const activateTab = usePanes((s) => s.activateTab);
  const closeTab = usePanes((s) => s.closeTab);
  const openTab = usePanes((s) => s.openTab);
  const isActivePane = activePaneId === pane.id;
  const activeIdx = pane.tabs.findIndex((t) => t.id === pane.activeTabId);

  return (
    <div
      className={clsx(
        // the 2px top border is always reserved so toggling the accent line
        // (or switching panes) never shifts the tabs vertically
        "flex h-8 shrink-0 items-stretch overflow-x-auto border-t-2 bg-window pt-1",
        paneAccentLine && isActivePane ? "border-t-accent" : "border-t-transparent",
      )}
      onMouseDown={() => setActivePane(pane.id as PaneId)}
    >
      {/* the bottom divider lives on the children so it can break under the
          active tab, letting its bg-pane flow into the content area */}
      <div className="w-1 shrink-0 border-b border-edge" />
      {pane.tabs.map((tab, i) => {
        const isActive = i === activeIdx;
        return (
          <div
            key={tab.id}
            className={clsx(
              "group flex min-w-0 max-w-[180px] flex-1 cursor-default items-center gap-1 px-2 text-xs",
              isActive
                ? "rounded-t-md border-b border-b-transparent bg-pane text-primary"
                : "border-b border-edge text-secondary hover:bg-hov hover:text-primary",
              // separators only between two inactive tabs
              i > 0 && !isActive && i !== activeIdx + 1 && "border-l",
            )}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeTab(pane.id as PaneId, tab.id);
                return;
              }
              activateTab(pane.id as PaneId, tab.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              showMenu(e.clientX, e.clientY, [
                {
                  type: "item",
                  label: "New Tab",
                  shortcut: "cmd+t",
                  action: () => openTab(pane.id as PaneId, tab.path),
                },
                {
                  type: "item",
                  label: "Close Tab",
                  shortcut: "cmd+w",
                  action: () => closeTab(pane.id as PaneId, tab.id),
                },
              ]);
            }}
            title={tab.path}
          >
            {/* balances the close button so the title sits centered */}
            <span className="w-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-center">
              {basename(tab.path) || "/"}
            </span>
            <button
              className={clsx(
                "flex h-4 w-4 shrink-0 cursor-default items-center justify-center rounded text-tertiary hover:bg-hov hover:text-primary",
                !isActive && "invisible group-hover:visible",
              )}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(pane.id as PaneId, tab.id);
              }}
              aria-label="Close tab"
            >
              <X size={11} strokeWidth={1.75} />
            </button>
          </div>
        );
      })}
      <div className="flex min-w-0 flex-1 items-center border-b border-edge">
        <button
          className="mx-1 shrink-0 cursor-default rounded p-1 text-tertiary hover:bg-hov hover:text-primary"
          title="New tab (⌘T)"
          onClick={() => {
            const active = pane.tabs.find((t) => t.id === pane.activeTabId);
            openTab(pane.id as PaneId, active?.path ?? "/");
          }}
        >
          <Plus size={13} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
