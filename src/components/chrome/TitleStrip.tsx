/**
 * The window's title strip: one 44pt row across the whole window holding
 * the traffic lights (moved down to center on it; see trafficLightPosition
 * in tauri.conf.json), back / forward / up, the active pane's path as an
 * address field, and the view controls. The sidebar toggle sits right
 * after the lights when the sidebar docks left, and at the strip's end,
 * above the sidebar, when it docks right. The sidebar and the pane cards
 * both start below the strip, so the lights always sit in a real title bar.
 */
import clsx from "clsx";
import { ArrowUp, Folder } from "lucide-react";
import { useApp } from "../../stores/app";
import { usePanes, activeTabOf } from "../../stores/panes";
import { useSettings } from "../../stores/settings";
import { getCommand } from "../../lib/commands/registry";
import { shortcutLabel } from "../../lib/keyboard";
import { PathBar } from "./PathBar";
import { SearchField } from "./SearchField";
import { IconButton, NavButtons, SidebarToggle, ViewControls } from "./WindowControls";

/** Matches the sidebar's width so a right-docked toggle sits above it. */
export const SIDEBAR_WIDTH = 236;

function UpButton() {
  const activePaneId = useApp((s) => s.activePaneId);
  const pane = usePanes((s) => s.panes.find((p) => p.id === activePaneId) ?? s.panes[0]);
  const tab = pane ? activeTabOf(pane) : null;
  const up = usePanes((s) => s.up);
  const shortcut = getCommand("up")?.shortcut;
  return (
    <IconButton
      icon={ArrowUp}
      title={`Enclosing Folder${shortcut ? ` (${shortcutLabel(shortcut)})` : ""}`}
      disabled={!tab || tab.path === "/"}
      onClick={() => pane && tab && up(pane.id, tab.id)}
    />
  );
}

/** The active pane's path, drawn as an address field. */
function AddressField() {
  const activePaneId = useApp((s) => s.activePaneId);
  const split = usePanes((s) => s.split);
  return (
    <div
      className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-[9px] bg-field pl-2.5 pr-1 shadow-[inset_0_0_0_0.5px_var(--border)] focus-within:shadow-[inset_0_0_0_1.5px_var(--accent)]"
      title="Double-click to type a path"
    >
      <Folder size={14} strokeWidth={1.75} className="shrink-0 text-tertiary" aria-hidden />
      {split && (
        <span className="shrink-0 rounded-[5px] bg-hov px-1.5 py-px text-[11px] font-semibold text-secondary">
          {activePaneId === "left" ? "Left" : "Right"}
        </span>
      )}
      <PathBar paneId={activePaneId} maxSegments={6} variant="address" />
    </div>
  );
}

export function TitleStrip() {
  const position = useSettings((s) => s.sidebarPosition);
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  return (
    <header
      className="relative flex h-11 shrink-0 items-center gap-1 pr-2"
      data-tauri-drag-region
    >
      {/* room for the traffic lights */}
      <div className="w-[84px] shrink-0 self-stretch" data-tauri-drag-region />
      {position === "left" && <SidebarToggle />}
      <NavButtons />
      <UpButton />
      <div className="ml-1 mr-1.5 flex min-w-0 flex-1">
        <AddressField />
      </div>
      {collapsed && <SearchField className="mr-1 w-[200px] shrink-0" />}
      <ViewControls />
      {position === "right" && (
        <div
          className={clsx("flex shrink-0 justify-end self-stretch items-center")}
          style={{ width: collapsed ? undefined : SIDEBAR_WIDTH }}
          data-tauri-drag-region
        >
          <SidebarToggle />
        </div>
      )}
    </header>
  );
}
