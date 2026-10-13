/**
 * Small window-chrome controls shared by the sidebar and the pane headers:
 * back/forward, sidebar show/hide, view mode, Get Info, dual pane, and the
 * overflow menu. Tooltips read shortcuts from the registry, so keybinding
 * overrides show up here too.
 */
import clsx from "clsx";
import {
  ChevronLeft,
  ChevronRight,
  Columns2,
  Ellipsis,
  Info,
  LayoutGrid,
  List,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  type LucideIcon,
} from "lucide-react";
import { useApp } from "../../stores/app";
import { usePanes, activeTabOf } from "../../stores/panes";
import { useSettings, type ViewMode } from "../../stores/settings";
import { allCommands, getCommand, runCommand } from "../../lib/commands/registry";
import { shortcutLabel } from "../../lib/keyboard";
import { showMenu, type MenuItem } from "../../stores/menu";
import { Segmented } from "./SearchField";

/** "Get Info (⌘I)" — the label plus the command's current shortcut. */
function withShortcut(label: string, commandId: string): string {
  const shortcut = getCommand(commandId)?.shortcut;
  return shortcut ? `${label} (${shortcutLabel(shortcut)})` : label;
}

export function IconButton({
  icon: Icon,
  title,
  disabled,
  active,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  disabled?: boolean;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      // Mouse-operated chrome should not steal keyboard ownership from the
      // browse surface; buttons stay reachable via Tab.
      onMouseDown={(e) => e.preventDefault()}
      className={clsx(
        "focusable flex h-7 w-7 shrink-0 cursor-default items-center justify-center rounded-md",
        disabled
          ? "text-tertiary opacity-60"
          : active
            ? "text-accent hover:bg-hov"
            : "text-secondary hover:bg-hov hover:text-primary",
      )}
    >
      <Icon size={15} strokeWidth={1.75} />
    </button>
  );
}

/** Back / forward for the active pane's active tab. */
export function NavButtons({ disabled }: { disabled?: boolean }) {
  const activePaneId = useApp((s) => s.activePaneId);
  const pane = usePanes((s) => s.panes.find((p) => p.id === activePaneId) ?? s.panes[0]);
  const tab = pane ? activeTabOf(pane) : null;
  const back = usePanes((s) => s.back);
  const forward = usePanes((s) => s.forward);
  return (
    <div className="flex shrink-0 items-center">
      <IconButton
        icon={ChevronLeft}
        title={withShortcut("Back", "back")}
        disabled={disabled || !tab || tab.back.length === 0}
        onClick={() => pane && tab && back(pane.id, tab.id)}
      />
      <IconButton
        icon={ChevronRight}
        title={withShortcut("Forward", "forward")}
        disabled={disabled || !tab || tab.forward.length === 0}
        onClick={() => pane && tab && forward(pane.id, tab.id)}
      />
    </div>
  );
}

/** Hide / show the sidebar; the icon points the way it will move. */
export function SidebarToggle() {
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const position = useSettings((s) => s.sidebarPosition);
  const icon =
    position === "right"
      ? collapsed
        ? PanelRightOpen
        : PanelRightClose
      : collapsed
        ? PanelLeftOpen
        : PanelLeftClose;
  return (
    <IconButton
      icon={icon}
      title={withShortcut(collapsed ? "Show Sidebar" : "Hide Sidebar", "toggleSidebar")}
      onClick={() => runCommand("toggleSidebar")}
    />
  );
}

function overflowMenuItems(): MenuItem[] {
  const items: MenuItem[] = [];
  const byId = (id: string) => allCommands().find((c) => c.id === id);
  const add = (id: string, label?: string): void => {
    const cmd = byId(id);
    if (!cmd) return;
    items.push({
      type: "item",
      label: label ?? cmd.title,
      shortcut: cmd.shortcut,
      action: () => runCommand(id),
    });
  };
  add("newFolder");
  add("newTab");
  items.push({ type: "separator" });
  add("toggleHidden");
  add("toggleSidebar");
  add("dualPane");
  items.push({ type: "separator" });
  add("getInfo");
  add("revealInFinder");
  add("eject");
  items.push({ type: "separator" });
  add("palette", "Command Palette…");
  return items;
}

/** View mode, Get Info, dual pane, and the overflow menu. */
export function ViewControls() {
  const viewMode = useSettings((s) => s.viewMode);
  const setViewMode = useSettings((s) => s.setViewMode);
  const infoOpen = useApp((s) => s.getInfoOpen);
  const split = usePanes((s) => s.split);
  return (
    <div className="flex shrink-0 items-center gap-0.5" onMouseDown={(e) => e.preventDefault()}>
      <div className="mr-1">
        <Segmented<ViewMode>
          label="View"
          value={viewMode}
          options={[
            ["list", <List size={13} strokeWidth={1.75} />, withShortcut("List view", "viewList")],
            ["grid", <LayoutGrid size={13} strokeWidth={1.75} />, withShortcut("Icon view", "viewGrid")],
          ]}
          onChange={setViewMode}
        />
      </div>
      <IconButton
        icon={Info}
        title={withShortcut("Get Info", "getInfo")}
        active={infoOpen}
        onClick={() => runCommand("getInfo")}
      />
      <IconButton
        icon={Columns2}
        title={withShortcut("Dual Pane", "dualPane")}
        active={split}
        onClick={() => runCommand("dualPane")}
      />
      <button
        title="More"
        aria-label="More"
        className="focusable flex h-7 w-7 shrink-0 cursor-default items-center justify-center rounded-md text-secondary hover:bg-hov hover:text-primary"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          showMenu(rect.right - 232, rect.bottom + 4, overflowMenuItems());
        }}
      >
        <Ellipsis size={15} strokeWidth={1.75} />
      </button>
    </div>
  );
}
