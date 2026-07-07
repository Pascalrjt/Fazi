/** Per-pane tab strip: active accent top-border, +, ✕, middle-click close. */
import clsx from "clsx";
import { usePanes, type Pane } from "../../stores/panes";
import { useApp, type PaneId } from "../../stores/app";
import { basename } from "../../lib/format";
import { showMenu } from "../../stores/menu";

export function TabStrip({ pane }: { pane: Pane }) {
  const activePaneId = useApp((s) => s.activePaneId);
  const setActivePane = useApp((s) => s.setActivePane);
  const activateTab = usePanes((s) => s.activateTab);
  const closeTab = usePanes((s) => s.closeTab);
  const openTab = usePanes((s) => s.openTab);
  const isActivePane = activePaneId === pane.id;

  return (
    <div
      className={clsx(
        "flex h-8 shrink-0 items-stretch gap-px overflow-x-auto border-b border-edge bg-window px-1 pt-1",
        isActivePane ? "border-t-2 border-t-accent" : "border-t-2 border-t-transparent",
      )}
      onMouseDown={() => setActivePane(pane.id as PaneId)}
    >
      {pane.tabs.map((tab) => {
        const isActive = tab.id === pane.activeTabId;
        return (
          <div
            key={tab.id}
            className={clsx(
              "group flex min-w-0 max-w-[180px] flex-1 cursor-default items-center gap-1 rounded-t-md px-2 text-xs",
              isActive
                ? "bg-pane text-primary"
                : "text-secondary hover:bg-hov hover:text-primary",
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
            <span className="min-w-0 flex-1 truncate">
              {basename(tab.path) || "/"}
            </span>
            <button
              className={clsx(
                "shrink-0 cursor-default rounded px-0.5 text-[10px] text-tertiary hover:text-primary",
                !isActive && "invisible group-hover:visible",
              )}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(pane.id as PaneId, tab.id);
              }}
              aria-label="Close tab"
            >
              ✕
            </button>
          </div>
        );
      })}
      <button
        className="mx-1 shrink-0 cursor-default self-center rounded px-1.5 py-0.5 text-xs text-tertiary hover:bg-hov hover:text-primary"
        title="New tab (⌘T)"
        onClick={() => {
          const active = pane.tabs.find((t) => t.id === pane.activeTabId);
          openTab(pane.id as PaneId, active?.path ?? "/");
        }}
      >
        +
      </button>
    </div>
  );
}
