/**
 * In-app settings overlay (⌘,): left nav, one pane per section. Opens as a
 * modal (KeyContext "modal" — browse shortcuts don't fire underneath).
 */
import { useEffect, useState } from "react";
import clsx from "clsx";
import {
  ArrowRightLeft,
  Check,
  Keyboard,
  Palette,
  PanelLeft,
  Search,
  Settings2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useApp } from "../../stores/app";
import { useSettings, type Density, type SidebarPosition, type Theme } from "../../stores/settings";
import { NumberField, Segmented, SettingRow, SettingsFilterContext, Toggle } from "./controls";
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

const PANES: Array<[PaneId, string, LucideIcon]> = [
  ["general", "General", Settings2],
  ["appearance", "Appearance", Palette],
  ["keyboard", "Keyboard", Keyboard],
  ["search", "Search", Search],
  ["operations", "Operations", ArrowRightLeft],
  ["sidebar", "Sidebar", PanelLeft],
  ["advanced", "Advanced", Wrench],
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

const DEFAULT_ACCENT_PREVIEW = "#4f8ef7";

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
                "flex h-5 w-5 cursor-default items-center justify-center rounded-full border",
                s.accent === color ? "border-primary" : "border-edge",
              )}
              style={{ background: color === "" ? DEFAULT_ACCENT_PREVIEW : color }}
              onClick={() => s.patch({ accent: color })}
            >
              {s.accent === color && <Check size={12} strokeWidth={2.5} className="text-white" />}
            </button>
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
      <SettingRow
        label="Alternating row colors"
        hint="Stripe list rows to make them easier to follow."
      >
        <Toggle checked={s.zebraStripes} onChange={(v) => s.patch({ zebraStripes: v })} />
      </SettingRow>
      <SettingRow
        label="Accent line"
        hint="Accent-colored line above the active pane's tabs."
      >
        <Toggle checked={s.paneAccentLine} onChange={(v) => s.patch({ paneAccentLine: v })} />
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
      <SettingRow
        label="Fuzzy-index entry cap"
        hint="0 = no cap (index everything). Above 0, the ⌘P index stops walking past this many items and flags itself as capped."
      >
        <NumberField
          value={s.fuzzyIndexEntryCap}
          min={0}
          max={100_000_000}
          step={100_000}
          onCommit={(v) => s.patch({ fuzzyIndexEntryCap: v })}
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
      <SettingRow label="Position" hint="Which edge of the window the sidebar docks to.">
        <Segmented
          value={s.sidebarPosition}
          options={[
            ["left", "Left"],
            ["right", "Right"],
          ]}
          onChange={(v) => s.patch({ sidebarPosition: v as SidebarPosition })}
        />
      </SettingRow>
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

/** One search-results group; hidden via CSS when every row filtered out. */
function SearchSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="settings-section mb-4">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-tertiary">
        {label}
      </div>
      <div className="divide-y divide-edge">{children}</div>
    </section>
  );
}

/** All SettingRow-based panes stacked; each row filters itself against the
 *  query from SettingsFilterContext. The Keyboard pane (a recorder, not
 *  SettingRows) is represented by a pointer row. */
function SearchResults({ openPane }: { openPane: (pane: PaneId) => void }) {
  return (
    <>
      <SearchSection label="General"><GeneralPane /></SearchSection>
      <SearchSection label="Appearance"><AppearancePane /></SearchSection>
      <SearchSection label="Keyboard">
        <SettingRow label="Keyboard shortcuts" hint="Rebind command shortcuts.">
          <button
            className="cursor-default rounded border border-edge px-2 py-0.5 text-[11px] text-secondary hover:bg-hov"
            onClick={() => openPane("keyboard")}
          >
            Open Keyboard settings
          </button>
        </SettingRow>
      </SearchSection>
      <SearchSection label="Search"><SearchPane /></SearchSection>
      <SearchSection label="Operations"><OperationsPane /></SearchSection>
      <SearchSection label="Sidebar"><SidebarPane /></SearchSection>
      <SearchSection label="Advanced"><AdvancedPane /></SearchSection>
      <div className="settings-empty pt-6 text-center text-[12px] text-tertiary">
        No matching settings
      </div>
    </>
  );
}

export function SettingsOverlay() {
  const open = useApp((s) => s.settingsOpen);
  const setOpen = useApp((s) => s.setSettingsOpen);
  const [pane, setPane] = useState<PaneId>("general");
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        // Esc clears an active search first; a second press closes.
        if (query !== "") setQuery("");
        else setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setOpen, query]);

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
          <div className="mb-2 flex h-7 items-center gap-1.5 rounded-md border border-edge bg-pane px-2">
            <Search size={12} strokeWidth={1.75} className="shrink-0 text-tertiary" />
            <input
              value={query}
              placeholder="Search"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              className="w-full bg-transparent text-xs text-primary outline-none placeholder:text-tertiary"
              spellCheck={false}
            />
          </div>
          {PANES.map(([id, label, Icon]) => (
            <button
              key={id}
              className={clsx(
                "flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]",
                pane === id && q === ""
                  ? "bg-accent-dim text-primary"
                  : "text-secondary hover:bg-hov",
              )}
              onClick={() => {
                setQuery("");
                setPane(id);
              }}
            >
              <Icon size={14} strokeWidth={1.75} className="shrink-0" />
              {label}
            </button>
          ))}
        </div>
        <div className="settings-body min-w-0 flex-1 overflow-y-auto p-5">
          <SettingsFilterContext.Provider value={q}>
            {q !== "" ? (
              <SearchResults
                openPane={(p) => {
                  setQuery("");
                  setPane(p);
                }}
              />
            ) : (
              <div className="divide-y divide-edge">
                {pane === "general" && <GeneralPane />}
                {pane === "appearance" && <AppearancePane />}
                {pane === "keyboard" && <KeyboardPane />}
                {pane === "search" && <SearchPane />}
                {pane === "operations" && <OperationsPane />}
                {pane === "sidebar" && <SidebarPane />}
                {pane === "advanced" && <AdvancedPane />}
              </div>
            )}
          </SettingsFilterContext.Provider>
        </div>
      </div>
    </div>
  );
}
