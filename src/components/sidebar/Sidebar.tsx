/**
 * Sidebar: Favorites (default folders), iCloud Drive, Volumes with eject.
 * Rows navigate on click, act as drop targets, and offer a context menu.
 */
import { useState } from "react";
import clsx from "clsx";
import { useVolumes } from "../../stores/volumes";
import { useSettings } from "../../stores/settings";
import { useApp } from "../../stores/app";
import { usePanes, activeTabOf } from "../../stores/panes";
import { dragHasPaths, dropPaths } from "../../lib/dnd";
import { ejectVolume } from "../../lib/actions";
import { showMenu } from "../../stores/menu";
import { formatBytes } from "../../lib/format";
import type { Volume } from "../../types/ipc";

interface RowSpec {
  key: string;
  label: string;
  path: string;
  glyph: string;
  volume?: Volume;
}

function SidebarRow({ row }: { row: RowSpec }) {
  const activePaneId = useApp((s) => s.activePaneId);
  const pane = usePanes((s) => s.panes.find((p) => p.id === activePaneId) ?? s.panes[0]);
  const tab = pane ? activeTabOf(pane) : null;
  const navigate = usePanes((s) => s.navigate);
  const openTab = usePanes((s) => s.openTab);
  const [dropping, setDropping] = useState(false);

  const isCurrent = tab?.path === row.path;

  return (
    <div
      className={clsx(
        "group mx-2 flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-[13px]",
        isCurrent ? "bg-accent-dim text-primary" : "text-secondary hover:bg-hov",
        dropping && "drop-ring",
      )}
      onClick={() => {
        if (pane && tab) navigate(pane.id, tab.id, row.path);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          {
            type: "item",
            label: "Open in New Tab",
            action: () => pane && openTab(pane.id, row.path),
          },
          ...(row.volume && row.volume.isEjectable
            ? [
                { type: "separator" as const },
                {
                  type: "item" as const,
                  label: `Eject “${row.label}”`,
                  action: () => ejectVolume(row.path, row.label),
                },
              ]
            : []),
        ]);
      }}
      onDragOver={(e) => {
        if (!dragHasPaths(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        dropPaths(e, row.path);
      }}
      title={
        row.volume
          ? `${row.label} — ${formatBytes(row.volume.availableBytes)} available`
          : row.path
      }
    >
      <span className="w-4 text-center text-[13px]">{row.glyph}</span>
      <span className="min-w-0 flex-1 truncate">{row.label}</span>
      {row.volume?.isEjectable && (
        <button
          className="hidden shrink-0 cursor-default rounded px-1 text-[11px] text-tertiary hover:text-primary group-hover:block"
          title={`Eject ${row.label}`}
          onClick={(e) => {
            e.stopPropagation();
            ejectVolume(row.path, row.label);
          }}
        >
          ⏏
        </button>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="mx-4 mb-1 mt-4 text-[11px] font-semibold uppercase tracking-wide text-tertiary">
      {children}
    </div>
  );
}

export function Sidebar() {
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const folders = useVolumes((s) => s.folders);
  const volumes = useVolumes((s) => s.volumes);

  if (collapsed) return null;

  const favorites: RowSpec[] = folders
    ? [
        { key: "home", label: "Home", path: folders.home, glyph: "⌂" },
        { key: "desktop", label: "Desktop", path: folders.desktop, glyph: "🖥" },
        { key: "documents", label: "Documents", path: folders.documents, glyph: "📄" },
        { key: "downloads", label: "Downloads", path: folders.downloads, glyph: "⤓" },
        { key: "applications", label: "Applications", path: folders.applications, glyph: "▣" },
      ]
    : [];

  const icloud: RowSpec[] =
    folders?.icloudDrive != null
      ? [{ key: "icloud", label: "iCloud Drive", path: folders.icloudDrive, glyph: "☁" }]
      : [];

  const volumeRows: RowSpec[] = volumes.map((v) => ({
    key: `vol:${v.path}`,
    label: v.name,
    path: v.path,
    glyph: v.isRoot ? "⏺" : v.isRemovable ? "◨" : "◧",
    volume: v,
  }));

  return (
    <div className="flex w-[200px] shrink-0 flex-col overflow-y-auto border-r border-edge bg-window pb-2">
      {favorites.length > 0 && (
        <>
          <SectionLabel>Favorites</SectionLabel>
          {favorites.map((row) => (
            <SidebarRow key={row.key} row={row} />
          ))}
        </>
      )}
      {icloud.length > 0 && (
        <>
          <SectionLabel>iCloud</SectionLabel>
          {icloud.map((row) => (
            <SidebarRow key={row.key} row={row} />
          ))}
        </>
      )}
      {volumeRows.length > 0 && (
        <>
          <SectionLabel>Volumes</SectionLabel>
          {volumeRows.map((row) => (
            <SidebarRow key={row.key} row={row} />
          ))}
        </>
      )}
      {favorites.length === 0 && volumeRows.length === 0 && (
        <div className="px-4 py-6 text-xs text-tertiary">
          Locations appear here when the backend is running.
        </div>
      )}
    </div>
  );
}
