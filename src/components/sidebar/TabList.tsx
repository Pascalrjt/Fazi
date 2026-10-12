/**
 * Vertical tabs for one pane, living in the sidebar under the favorites.
 * Click (or ⏎ from the keyboard) activates, middle-click or ✕ closes, and
 * right-click offers New Tab / Close Tab. Rows are `data-sidebar-row`s, so
 * the sidebar's arrow and Vim navigation walks through them too. In dual
 * pane, each pane gets its own group.
 */
import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import {
  Download,
  FileText,
  Folder,
  HardDrive,
  House,
  LayoutGrid,
  Monitor,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { usePanes } from "../../stores/panes";
import { useApp, type PaneId } from "../../stores/app";
import { useVolumes } from "../../stores/volumes";
import { basename, tabHints } from "../../lib/format";
import { showMenu } from "../../stores/menu";
import { getCommand } from "../../lib/commands/registry";
import { shortcutLabel } from "../../lib/keyboard";
import { focusActivePane } from "../../lib/keyboardFocus";
import { CleanupBadge } from "./CleanupBadge";

/** Known places keep their sidebar icon as tabs; everything else is a folder. */
function useTabIcon(): (path: string) => LucideIcon {
  const folders = useVolumes((s) => s.folders);
  const volumes = useVolumes((s) => s.volumes);
  return (path) => {
    if (folders) {
      if (path === folders.home) return House;
      if (path === folders.desktop) return Monitor;
      if (path === folders.documents) return FileText;
      if (path === folders.downloads) return Download;
      if (path === folders.applications) return LayoutGrid;
      if (path === folders.trash) return Trash2;
    }
    if (volumes.some((v) => v.path === path)) return HardDrive;
    return Folder;
  };
}

function shortcutHint(commandId: string): string {
  const shortcut = getCommand(commandId)?.shortcut;
  return shortcut ? ` (${shortcutLabel(shortcut)})` : "";
}

/** Two-tone rectangle marking which half of the window a group drives. */
function PaneMark({ side }: { side: PaneId }) {
  return (
    <span className="relative h-2.5 w-3.5 shrink-0 overflow-hidden rounded-[2px] border-[1.25px] border-current" aria-hidden>
      <span
        className={clsx("absolute inset-y-0 w-1/2 bg-current opacity-55", side === "left" ? "left-0" : "right-0")}
      />
    </span>
  );
}

export function TabList({
  paneId,
  showHeader,
  tabStopKey,
  onFocused,
}: {
  paneId: PaneId;
  showHeader: boolean;
  tabStopKey: string | null;
  onFocused(key: string): void;
}) {
  const pane = usePanes((s) => s.panes.find((p) => p.id === paneId));
  const activateTab = usePanes((s) => s.activateTab);
  const closeTab = usePanes((s) => s.closeTab);
  const openTab = usePanes((s) => s.openTab);
  const activePaneId = useApp((s) => s.activePaneId);
  const setActivePane = useApp((s) => s.setActivePane);
  const iconFor = useTabIcon();

  if (!pane) return null;
  const hints = tabHints(pane.tabs.map((t) => t.path));
  const paneActive = activePaneId === paneId;
  const label = paneId === "left" ? "Left pane" : "Right pane";

  return (
    <div role="tablist" aria-orientation="vertical" aria-label={showHeader ? label : "Tabs"} className="mb-1">
      {showHeader && (
        <button
          className={clsx(
            "mt-1.5 flex h-6 w-full cursor-default items-center gap-1.5 px-2 text-[11px] font-semibold",
            paneActive ? "text-secondary" : "text-tertiary hover:text-secondary",
          )}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setActivePane(paneId);
            focusActivePane();
          }}
          tabIndex={-1}
        >
          <PaneMark side={paneId} />
          {label}
        </button>
      )}
      {pane.tabs.map((tab, i) => {
        const isActive = tab.id === pane.activeTabId;
        const focused = isActive && paneActive;
        const Icon = iconFor(tab.path);
        const key = `tab:${paneId}:${tab.id}`;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            data-sidebar-row
            data-sidebar-key={key}
            data-tab-id={tab.id}
            tabIndex={key === tabStopKey ? 0 : -1}
            className={clsx(
              "group flex h-8 cursor-default items-center gap-2 rounded-lg pl-2.5 pr-1.5 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-accent",
              focused
                ? "bg-tab text-primary shadow-[var(--shadow-tab)]"
                : isActive
                  ? "bg-hov text-primary"
                  : "text-secondary hover:bg-hov",
            )}
            title={tab.path}
            onFocus={() => onFocused(key)}
            onMouseDown={(e) => {
              // Pointer activation hands the keyboard straight to the pane.
              e.preventDefault();
              if (e.button === 1) closeTab(paneId, tab.id);
            }}
            onAuxClick={(e) => e.preventDefault()}
            onClick={() => {
              activateTab(paneId, tab.id);
              setActivePane(paneId);
              focusActivePane();
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              showMenu(e.clientX, e.clientY, [
                {
                  type: "item",
                  label: "New Tab",
                  shortcut: getCommand("newTab")?.shortcut,
                  action: () => openTab(paneId, tab.path),
                },
                {
                  type: "item",
                  label: "Close Tab",
                  shortcut: getCommand("closeTab")?.shortcut,
                  action: () => closeTab(paneId, tab.id),
                },
              ]);
            }}
          >
            <Icon
              size={15}
              strokeWidth={1.75}
              className={clsx("shrink-0", focused ? "text-accent" : "text-tertiary")}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">
              {basename(tab.path) || "/"}
              {hints[i] && <span className="text-[11.5px] text-tertiary"> {hints[i]}</span>}
            </span>
            <CleanupBadge folder={tab.path} />
            <button
              className={clsx(
                "flex h-5 w-5 shrink-0 cursor-default items-center justify-center rounded text-tertiary hover:bg-hov hover:text-primary",
                !focused && "invisible group-hover:visible",
              )}
              title={`Close Tab${shortcutHint("closeTab")}`}
              aria-label="Close tab"
              tabIndex={-1}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(paneId, tab.id);
              }}
            >
              <X size={11} strokeWidth={1.75} />
            </button>
          </div>
        );
      })}
      <button
        className="flex h-[30px] w-full cursor-default items-center gap-2 rounded-lg px-2.5 text-[12.5px] text-tertiary hover:bg-hov hover:text-secondary"
        title={`New Tab${shortcutHint("newTab")}`}
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const active = pane.tabs.find((t) => t.id === pane.activeTabId);
          openTab(paneId, active?.path ?? "/");
          setActivePane(paneId);
          focusActivePane();
        }}
      >
        <Plus size={14} strokeWidth={1.75} />
        New tab
      </button>
    </div>
  );
}
