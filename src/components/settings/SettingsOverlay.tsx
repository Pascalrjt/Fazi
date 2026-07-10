/**
 * In-app settings overlay (⌘,): left nav, one pane per section. Opens as a
 * modal (KeyContext "modal" — browse shortcuts don't fire underneath).
 */
import { useEffect, useState } from "react";
import clsx from "clsx";
import { useApp } from "../../stores/app";
import { useSettings, type Density, type Theme } from "../../stores/settings";
import { NumberField, Segmented, SettingRow, Toggle } from "./controls";
import { KeyboardPane } from "./KeyboardPane";
import type { SortDir, SortKey } from "../../lib/sort";

type PaneId =
  | "general"
  | "appearance"
  | "keyboard"
  | "search"
  | "operations"
  | "sidebar"
  | "advanced";

const PANES: Array<[PaneId, string]> = [
  ["general", "General"],
  ["appearance", "Appearance"],
  ["keyboard", "Keyboard"],
  ["search", "Search"],
  ["operations", "Operations"],
  ["sidebar", "Sidebar"],
  ["advanced", "Advanced"],
];

function GeneralPane() {
  const s = useSettings();
  return (
    <>
      <SettingRow label="Show hidden files">
        <Toggle checked={s.showHidden} onChange={(v) => s.patch({ showHidden: v })} />
      </SettingRow>
      <SettingRow label="Default view">
        <Segmented
          value={s.viewMode}
          options={[
            ["list", "List"],
            ["grid", "Icons"],
          ]}
          onChange={(v) => s.setViewMode(v)}
        />
      </SettingRow>
      <SettingRow label="Default sort">
        <div className="flex gap-2">
          <Segmented
            value={s.defaultSortKey}
            options={[
              ["name", "Name"],
              ["size", "Size"],
              ["mtime", "Modified"],
              ["kind", "Kind"],
            ]}
            onChange={(v) => s.setDefaultSort(v as SortKey, s.defaultSortDir)}
          />
          <Segmented
            value={s.defaultSortDir}
            options={[
              ["asc", "↑"],
              ["desc", "↓"],
            ]}
            onChange={(v) => s.setDefaultSort(s.defaultSortKey, v as SortDir)}
          />
        </div>
      </SettingRow>
      <SettingRow label="Confirm permanent delete" hint="The ⌘⌥⌫ dialog.">
        <Toggle
          checked={s.confirmPermanentDelete}
          onChange={(v) => s.patch({ confirmPermanentDelete: v })}
        />
      </SettingRow>
      <SettingRow label="Confirm Empty Trash">
        <Toggle checked={s.confirmEmptyTrash} onChange={(v) => s.patch({ confirmEmptyTrash: v })} />
      </SettingRow>
    </>
  );
}

const ACCENTS: Array<[string, string]> = [
  ["", "Default"],
  ["#e0383e", "Red"],
  ["#e8883a", "Orange"],
  ["#e5c53b", "Yellow"],
  ["#4fa356", "Green"],
  ["#9a6ee8", "Purple"],
  ["#e56ba5", "Pink"],
];

function AppearancePane() {
  const s = useSettings();
  return (
    <>
      <SettingRow label="Theme">
        <Segmented
          value={s.theme}
          options={[
            ["system", "System"],
            ["light", "Light"],
            ["dark", "Dark"],
          ]}
          onChange={(v) => s.patch({ theme: v as Theme })}
        />
      </SettingRow>
      <SettingRow label="Accent">
        <div className="flex items-center gap-1.5">
          {ACCENTS.map(([color, name]) => (
            <button
              key={name}
              title={name}
              className={clsx(
                "h-5 w-5 cursor-default rounded-full border",
                s.accent === color ? "border-primary" : "border-edge",
              )}
              style={{ background: color === "" ? "var(--accent)" : color }}
              onClick={() => s.patch({ accent: color })}
            />
          ))}
        </div>
      </SettingRow>
      <SettingRow label="Density" hint="Compact tightens list rows.">
        <Segmented
          value={s.density}
          options={[
            ["normal", "Normal"],
            ["compact", "Compact"],
          ]}
          onChange={(v) => s.patch({ density: v as Density })}
        />
      </SettingRow>
    </>
  );
}

function SearchPane() {
  const s = useSettings();
  return (
    <>
      <SettingRow label="Search contents by default" hint="New search sessions start in Contents mode.">
        <Toggle
          checked={s.searchContentsDefault}
          onChange={(v) => s.patch({ searchContentsDefault: v })}
        />
      </SettingRow>
      <SettingRow label="Max results" hint="1–10,000; applied in the engine and the view.">
        <NumberField
          value={s.searchMaxResults}
          min={1}
          max={10_000}
          step={500}
          onCommit={(v) => s.patch({ searchMaxResults: v })}
        />
      </SettingRow>
      <SettingRow
        label="Fuzzy-index excludes"
        hint="One per line. A bare name matches at any depth; with “/” it's a path prefix from the indexed root."
      >
        <textarea
          className="h-24 w-full max-w-[320px] rounded-md border border-edge bg-pane px-2 py-1 font-mono text-[12px] text-primary outline-none focus:border-accent"
          defaultValue={s.fuzzyExcludes.join("\n")}
          spellCheck={false}
          onBlur={(e) =>
            s.patch({
              fuzzyExcludes: e.target.value
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => l !== ""),
            })
          }
          onKeyDown={(e) => e.stopPropagation()}
        />
      </SettingRow>
      <SettingRow label="Fuzzy-index entry cap" hint="The ⌘P index stops walking past this many items.">
        <NumberField
          value={s.fuzzyIndexMaxEntries}
          min={10_000}
          max={10_000_000}
          step={100_000}
          onCommit={(v) => s.patch({ fuzzyIndexMaxEntries: v })}
        />
      </SettingRow>
    </>
  );
}

function OperationsPane() {
  const s = useSettings();
  return (
    <>
      <SettingRow
        label="Verify copies (checksum)"
        hint="BLAKE3-hashes every copied file after it lands and flags mismatches. Cross-volume moves are always verified regardless — this adds full checksums to copies."
      >
        <Toggle checked={s.verifyCopies} onChange={(v) => s.patch({ verifyCopies: v })} />
      </SettingRow>
      <SettingRow label="Auto-hide finished op cards" hint="Milliseconds; failures always persist.">
        <NumberField
          value={s.opCardAutoHideMs}
          min={1000}
          max={60_000}
          step={500}
          onCommit={(v) => s.patch({ opCardAutoHideMs: v })}
        />
      </SettingRow>
    </>
  );
}

function SidebarPane() {
  const s = useSettings();
  return (
    <>
      <SettingRow label="Show Trash in sidebar">
        <Toggle checked={s.showTrashInSidebar} onChange={(v) => s.patch({ showTrashInSidebar: v })} />
      </SettingRow>
      <SettingRow
        label="Pinned folders"
        hint="Drag folders onto the Favorites section to pin; right-click a pin to remove."
      >
        <div className="text-[12px] text-secondary">
          {s.favorites.length === 0
            ? "No pinned folders yet."
            : s.favorites.map((f) => (
                <div key={f.path} className="flex items-center gap-2 py-0.5">
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <button
                    className="cursor-default rounded border border-edge px-1.5 text-[11px] text-secondary hover:bg-hov"
                    onClick={() => s.removeFavorite(f.path)}
                  >
                    Remove
                  </button>
                </div>
              ))}
        </div>
      </SettingRow>
    </>
  );
}

function AdvancedPane() {
  const s = useSettings();
  return (
    <>
      <SettingRow
        label="Folder sizes in list view"
        hint="Computed lazily and cached; explicitly approximate (external changes may be missed until the cache expires)."
      >
        <Toggle checked={s.showFolderSizes} onChange={(v) => s.patch({ showFolderSizes: v })} />
      </SettingRow>
      <SettingRow
        label="Native drag-out"
        hint="Drag files to Finder, Mail, and other apps. Off = internal drag & drop only."
      >
        <Toggle checked={s.dragOutEnabled} onChange={(v) => s.setDragOutEnabled(v)} />
      </SettingRow>
      <SettingRow label="Per-directory view settings" hint="Coming later.">
        <Toggle checked={false} onChange={() => {}} disabled />
      </SettingRow>
      <SettingRow
        label="Reset to defaults"
        hint="Restores every setting above. Pinned folders and column widths are kept."
      >
        <button
          className="cursor-default rounded border border-edge px-2.5 py-1 text-[12px] text-danger hover:bg-hov"
          onClick={() => s.resetToDefaults()}
        >
          Reset all settings
        </button>
      </SettingRow>
    </>
  );
}

export function SettingsOverlay() {
  const open = useApp((s) => s.settingsOpen);
  const setOpen = useApp((s) => s.setSettingsOpen);
  const [pane, setPane] = useState<PaneId>("general");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div
      className="anim-fade fixed inset-0 z-[85] flex items-start justify-center bg-black/30 pt-[9vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        className="anim-pop flex h-[70vh] w-[720px] overflow-hidden rounded-xl border border-edge bg-raised"
        style={{ boxShadow: "var(--shadow-overlay)" }}
      >
        <div className="w-[160px] shrink-0 border-r border-edge bg-window p-2">
          <div className="px-2 py-1.5 text-[13px] font-semibold text-primary">Settings</div>
          {PANES.map(([id, label]) => (
            <button
              key={id}
              className={clsx(
                "block w-full cursor-default rounded-md px-2 py-1.5 text-left text-[13px]",
                pane === id ? "bg-accent-dim text-primary" : "text-secondary hover:bg-hov",
              )}
              onClick={() => setPane(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto p-5">
          {pane === "general" && <GeneralPane />}
          {pane === "appearance" && <AppearancePane />}
          {pane === "keyboard" && <KeyboardPane />}
          {pane === "search" && <SearchPane />}
          {pane === "operations" && <OperationsPane />}
          {pane === "sidebar" && <SidebarPane />}
          {pane === "advanced" && <AdvancedPane />}
        </div>
      </div>
    </div>
  );
}
