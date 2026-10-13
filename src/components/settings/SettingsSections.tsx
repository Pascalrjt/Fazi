/** The contents of each Settings section (see sections.ts for the order). */
import { useState } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  FileText,
  Folder,
  X,
} from "lucide-react";
import {
  useSettings,
  type Density,
  type SidebarPosition,
  type Theme,
  type ViewMode,
} from "../../stores/settings";
import { leavingSoonIn, useCleanup } from "../../stores/cleanup";
import { useVolumes } from "../../stores/volumes";
import { countWithSize, ruleFolderName } from "../../lib/cleanup";
import { displayPath, pluralize } from "../../lib/format";
import { getCommand } from "../../lib/commands/registry";
import { shortcutLabel } from "../../lib/keyboard";
import { pinFolders } from "../../lib/pin";
import type { SortDir, SortKey } from "../../lib/sort";
import * as ipc from "../../lib/ipc";
import {
  AddButton,
  Chips,
  EmptyNote,
  ListBox,
  MiniButton,
  Segmented,
  SettingGroup,
  SettingRow,
  Stepper,
  TextField,
  Toggle,
} from "./controls";
import { totalModified } from "./sections";

// ---------------------------------------------------------------- General

export function GeneralSection() {
  const s = useSettings();
  return (
    <>
      <SettingGroup title="Startup">
        <SettingRow
          label="Reopen tabs at launch"
          hint="Open the tabs and panes from your last session."
          keywords="restore session windows"
          setting="restoreTabs"
        >
          <Toggle label="Reopen tabs at launch" checked={s.restoreTabs} onChange={(v) => s.patch({ restoreTabs: v })} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Browsing">
        <SettingRow label="View files as" hint="⌘1 and ⌘2 switch this anywhere." keywords="default view list icons grid" setting="viewMode">
          <Segmented<ViewMode>
            label="View files as"
            value={s.viewMode}
            options={[
              ["list", "List"],
              ["grid", "Icons"],
            ]}
            onChange={(v) => s.setViewMode(v)}
          />
        </SettingRow>
        <SettingRow
          label="Show folder sizes"
          hint="Calculate folder sizes in list view. Sizes are estimates and can lag behind changes."
          keywords="folder size calculate"
          setting="showFolderSizes"
        >
          <Toggle label="Show folder sizes" checked={s.showFolderSizes} onChange={(v) => s.patch({ showFolderSizes: v })} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="New tabs">
        <SettingRow
          label="Sort by"
          hint="Each tab keeps its own sort once you change it."
          keywords="default sort order name size modified kind ascending descending"
          setting={["defaultSortKey", "defaultSortDir"]}
        >
          <div className="flex items-center gap-1.5">
            <Segmented<SortKey>
              label="Sort by"
              value={s.defaultSortKey}
              options={[
                ["name", "Name"],
                ["size", "Size"],
                ["mtime", "Modified"],
                ["kind", "Kind"],
              ]}
              onChange={(v) => s.setDefaultSort(v, s.defaultSortDir)}
            />
            <button
              className="focusable flex h-[26px] w-[26px] cursor-default items-center justify-center rounded-[7px] bg-hov text-secondary hover:text-primary"
              title={s.defaultSortDir === "asc" ? "Ascending" : "Descending"}
              aria-label={`Sort direction: ${s.defaultSortDir === "asc" ? "ascending" : "descending"}`}
              onClick={() => s.setDefaultSort(s.defaultSortKey, (s.defaultSortDir === "asc" ? "desc" : "asc") as SortDir)}
            >
              {s.defaultSortDir === "asc" ? <ArrowUp size={13} strokeWidth={1.75} /> : <ArrowDown size={13} strokeWidth={1.75} />}
            </button>
          </div>
        </SettingRow>
        <SettingRow
          label="Show hidden files"
          hint="Show dotfiles and other hidden items. ⌘⇧. switches this for the current tab."
          keywords="dotfiles invisible"
          setting="showHidden"
        >
          <Toggle label="Show hidden files" checked={s.showHidden} onChange={(v) => s.patch({ showHidden: v })} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Confirmations">
        <SettingRow
          label="Ask before deleting immediately"
          hint="Confirm Delete Immediately (⌘⌥⌫), which skips the Trash."
          keywords="confirm permanent delete dialog"
          setting="confirmPermanentDelete"
        >
          <Toggle
            label="Ask before deleting immediately"
            checked={s.confirmPermanentDelete}
            onChange={(v) => s.patch({ confirmPermanentDelete: v })}
          />
        </SettingRow>
        <SettingRow label="Ask before emptying the Trash" keywords="confirm empty trash dialog" setting="confirmEmptyTrash">
          <Toggle
            label="Ask before emptying the Trash"
            checked={s.confirmEmptyTrash}
            onChange={(v) => s.patch({ confirmEmptyTrash: v })}
          />
        </SettingRow>
      </SettingGroup>
    </>
  );
}

// ---------------------------------------------------------------- Appearance

const ACCENTS: Array<[string, string]> = [
  ["", "Default"],
  ["#e0383e", "Red"],
  ["#e8883a", "Orange"],
  ["#d4a92a", "Yellow"],
  ["#4fa356", "Green"],
  ["#9a6ee8", "Purple"],
  ["#e56ba5", "Pink"],
];

const THEMES: Array<[Theme, string]> = [
  ["system", "Auto"],
  ["light", "Light"],
  ["dark", "Dark"],
];

/** A miniature window in the theme's colors (Auto splits diagonally). */
function ThemeArt({ theme }: { theme: Theme }) {
  const frame =
    theme === "system" ? "linear-gradient(135deg, #dbe1e9 50%, #15181d 50%)" : theme === "light" ? "#dbe1e9" : "#15181d";
  const card =
    theme === "system" ? "linear-gradient(135deg, #fff 50%, #1f2228 50%)" : theme === "light" ? "#fff" : "#1f2228";
  const line = theme === "dark" ? "rgba(255,255,255,0.22)" : "rgba(24,38,66,0.25)";
  return (
    <span className="relative block h-[42px] w-16 overflow-hidden rounded-[7px]" style={{ background: frame }} aria-hidden>
      <span className="absolute bottom-1.5 left-[22px] right-1.5 top-1.5 rounded-[3px]" style={{ background: card }} />
      <span className="absolute left-1.5 top-2 h-[3px] w-3 rounded-sm bg-accent" />
      <span className="absolute left-1.5 top-3.5 h-[3px] w-3 rounded-sm" style={{ background: line }} />
      <span className="absolute left-1.5 top-5 h-[3px] w-3 rounded-sm" style={{ background: line }} />
    </span>
  );
}

export function AppearanceSection() {
  const s = useSettings();
  return (
    <>
      <SettingGroup title="Look">
        <SettingRow label="Theme" keywords="dark light mode system appearance auto" setting="theme">
          <div role="radiogroup" aria-label="Theme" className="flex gap-2.5">
            {THEMES.map(([value, name]) => (
              <button
                key={value}
                role="radio"
                aria-checked={s.theme === value}
                className={clsx(
                  "focusable flex cursor-default flex-col items-center gap-1 text-[11.5px]",
                  s.theme === value ? "font-medium text-primary" : "text-secondary",
                )}
                onClick={() => s.patch({ theme: value })}
              >
                <span
                  className={clsx(
                    "rounded-[8px]",
                    s.theme === value
                      ? "shadow-[0_0_0_2px_var(--accent)]"
                      : "shadow-[0_0_0_0.5px_var(--border-strong)]",
                  )}
                >
                  <ThemeArt theme={value} />
                </span>
                {name}
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow label="Accent color" hint="Colors selection, focus, and switches." keywords="accent color highlight tint" setting="accent">
          <div role="radiogroup" aria-label="Accent color" className="flex gap-[7px]">
            {ACCENTS.map(([color, name]) => (
              <button
                key={name}
                role="radio"
                aria-checked={s.accent === color}
                title={name}
                aria-label={name}
                className="flex h-5 w-5 cursor-default items-center justify-center rounded-full text-white"
                style={{
                  background: color === "" ? "var(--accent-default)" : color,
                  boxShadow:
                    s.accent === color
                      ? `0 0 0 2px var(--bg-raised), 0 0 0 3.5px ${color === "" ? "var(--accent-default)" : color}`
                      : "inset 0 0 0 0.5px rgba(0,0,0,0.18)",
                }}
                onClick={() => s.patch({ accent: color })}
              >
                {s.accent === color && <Check size={11} strokeWidth={2.5} />}
              </button>
            ))}
          </div>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Lists">
        <SettingRow label="Row height" hint="Compact fits more rows on screen." keywords="density compact spacing" setting="density">
          <Segmented<Density>
            label="Row height"
            value={s.density}
            options={[
              ["normal", "Regular"],
              ["compact", "Compact"],
            ]}
            onChange={(v) => s.patch({ density: v })}
          />
        </SettingRow>
        <SettingRow
          label="Alternating row colors"
          hint="Stripe list rows to make them easier to follow."
          keywords="zebra stripes"
          setting="zebraStripes"
        >
          <Toggle label="Alternating row colors" checked={s.zebraStripes} onChange={(v) => s.patch({ zebraStripes: v })} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Layout">
        <SettingRow
          label="Sidebar position"
          hint="Dock the sidebar and its tabs to this edge of the window."
          keywords="dock side left right tabs"
          setting="sidebarPosition"
        >
          <Segmented<SidebarPosition>
            label="Sidebar position"
            value={s.sidebarPosition}
            options={[
              ["left", "Left"],
              ["right", "Right"],
            ]}
            onChange={(v) => s.patch({ sidebarPosition: v })}
          />
        </SettingRow>
      </SettingGroup>
    </>
  );
}

// ---------------------------------------------------------------- Sidebar

export function SidebarSection() {
  const s = useSettings();
  const home = useVolumes((v) => v.folders?.home ?? null);
  const pin = async () => {
    const picked = await ipc.pickFolder(home ?? undefined).catch(() => null);
    if (picked != null) await pinFolders([picked]);
  };
  return (
    <>
      <SettingGroup title="Locations">
        <SettingRow label="Show Trash in sidebar" keywords="trash bin" setting="showTrashInSidebar">
          <Toggle
            label="Show Trash in sidebar"
            checked={s.showTrashInSidebar}
            onChange={(v) => s.patch({ showTrashInSidebar: v })}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Pinned">
        <SettingRow
          label="Pinned folders"
          hint="Drag folders onto the sidebar to pin them. Use the arrows to reorder."
          keywords="favorites pins"
          block
        >
          {s.favorites.length === 0 ? (
            <EmptyNote>No pinned folders yet. Drag a folder onto the sidebar to pin it.</EmptyNote>
          ) : (
            <ListBox>
              {s.favorites.map((f, i) => (
                <div key={f.path} className="flex min-h-8 items-center gap-2 py-1 pl-2.5 pr-1.5">
                  <Folder size={13} strokeWidth={1.75} className="shrink-0 text-secondary" aria-hidden />
                  <span className="shrink-0 text-[13px] font-medium text-primary">{f.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-tertiary">{displayPath(f.path, home)}</span>
                  <MiniButton label={`Move ${f.name} up`} disabled={i === 0} onClick={() => s.moveFavorite(f.path, i - 1)}>
                    <ChevronUp size={12} strokeWidth={1.75} />
                  </MiniButton>
                  <MiniButton
                    label={`Move ${f.name} down`}
                    disabled={i === s.favorites.length - 1}
                    onClick={() => s.moveFavorite(f.path, i + 2)}
                  >
                    <ChevronDown size={12} strokeWidth={1.75} />
                  </MiniButton>
                  <MiniButton label={`Unpin ${f.name}`} onClick={() => s.removeFavorite(f.path)}>
                    <X size={12} strokeWidth={1.75} />
                  </MiniButton>
                </div>
              ))}
            </ListBox>
          )}
          <AddButton onClick={() => void pin()}>Pin a Folder…</AddButton>
        </SettingRow>
      </SettingGroup>
    </>
  );
}

// ---------------------------------------------------------------- Search

export function SearchSection() {
  const s = useSettings();
  const capped = s.fuzzyIndexEntryCap > 0;
  return (
    <>
      <SettingGroup title="Search Everywhere">
        <SettingRow
          label="Search file contents"
          hint="New searches match text inside files as well as names."
          keywords="contents full text spotlight default"
          setting="searchContentsDefault"
        >
          <Toggle
            label="Search file contents"
            checked={s.searchContentsDefault}
            onChange={(v) => s.patch({ searchContentsDefault: v })}
          />
        </SettingRow>
        <SettingRow label="Result limit" hint="Stop listing results after this many." keywords="max results cap" setting="searchMaxResults">
          <Stepper
            label="Result limit"
            value={s.searchMaxResults}
            min={1}
            max={10_000}
            step={500}
            unit="results"
            onCommit={(v) => s.patch({ searchMaxResults: v })}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Go to File index">
        <SettingRow
          label="Skip when indexing"
          hint="A name matches at any depth. A path like Library/Caches starts at the indexed folder."
          keywords="fuzzy index excludes ignore node_modules ⌘p"
          setting="fuzzyExcludes"
          block
        >
          <Chips
            label="Add an excluded name or path"
            placeholder="Add a name or path…"
            values={s.fuzzyExcludes}
            onChange={(v) => s.patch({ fuzzyExcludes: v })}
          />
        </SettingRow>
        <SettingRow
          label="Index size limit"
          hint="Stop indexing after this many items. Use this when indexing a huge folder is slow."
          keywords="fuzzy index entry cap limit"
          setting="fuzzyIndexEntryCap"
        >
          <div className="flex items-center gap-1.5">
            <Segmented<"off" | "on">
              label="Index size limit"
              value={capped ? "on" : "off"}
              options={[
                ["off", "No limit"],
                ["on", "Limit"],
              ]}
              onChange={(v) => s.patch({ fuzzyIndexEntryCap: v === "on" ? 500_000 : 0 })}
            />
            {capped && (
              <Stepper
                label="Index size limit"
                value={s.fuzzyIndexEntryCap}
                min={100_000}
                max={100_000_000}
                step={100_000}
                unit="items"
                onCommit={(v) => s.patch({ fuzzyIndexEntryCap: v })}
              />
            )}
          </div>
        </SettingRow>
      </SettingGroup>
    </>
  );
}

// ---------------------------------------------------------------- Transfers

export function TransfersSection() {
  const s = useSettings();
  return (
    <>
      <SettingGroup title="Copying">
        <SettingRow
          label="Verify copies"
          hint="Compare each copied file with its original using a checksum. Copies take longer. Moves between disks are always verified."
          keywords="checksum blake3 integrity"
          setting="verifyCopies"
        >
          <Toggle label="Verify copies" checked={s.verifyCopies} onChange={(v) => s.patch({ verifyCopies: v })} />
        </SettingRow>
        <SettingRow
          label="Hide finished transfers after"
          hint="Failed transfers stay until you close them."
          keywords="operations progress card auto hide"
          setting="opCardAutoHideMs"
        >
          <Stepper
            label="Hide finished transfers after"
            value={Math.round(s.opCardAutoHideMs / 1000)}
            min={1}
            max={60}
            step={1}
            unit="s"
            onCommit={(v) => s.patch({ opCardAutoHideMs: v * 1000 })}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Other apps">
        <SettingRow
          label="Drag files to other apps"
          hint="Drag from Fazi into Finder, Mail, and other apps. Turn this off to keep drags inside Fazi."
          keywords="native drag out drop"
          setting="dragOutEnabled"
        >
          <Toggle label="Drag files to other apps" checked={s.dragOutEnabled} onChange={(v) => s.setDragOutEnabled(v)} />
        </SettingRow>
        <SettingRow
          label="Use the macOS share sheet"
          hint="Share opens the system share sheet in place of Fazi's Share submenu."
          keywords="share picker airdrop"
          setting="nativeSharePicker"
        >
          <Toggle
            label="Use the macOS share sheet"
            checked={s.nativeSharePicker}
            onChange={(v) => s.patch({ nativeSharePicker: v })}
          />
        </SettingRow>
      </SettingGroup>
    </>
  );
}

// ---------------------------------------------------------------- Auto-cleanup

const DEFAULT_RULE_DAYS = 14;

function expandHome(path: string, home: string | null): string {
  if (home == null) return path;
  if (path === "~") return home;
  return path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}

/** What the next check would do in one rule folder, from the latest scan. */
function RuleForecast({ rulePath }: { rulePath: string }) {
  const enabled = useSettings((s) => s.cleanupEnabled);
  const report = useCleanup((c) => c.reports.find((r) => r.rulePath === rulePath));
  // Subscribe to the scan and the clock; derive outside the selector so it
  // never returns a fresh array (zustand would re-render forever).
  useCleanup((c) => c.items);
  useCleanup((c) => c.now);
  const soon = report && report.error == null ? leavingSoonIn(report.folder) : [];
  const sweep = useCleanup((c) => c.sweep);
  let body: React.ReactNode;
  if (!enabled) body = <span className="text-tertiary">Paused while auto-cleanup is off</span>;
  else if (report?.error) body = <span className="text-danger">{report.error}</span>;
  else if (!report) body = <span className="text-tertiary">Checking…</span>;
  else if (soon.length === 0) body = <span className="text-secondary">Nothing goes to the Trash by tomorrow</span>;
  else
    body = (
      <span className="text-secondary">
        {countWithSize(soon)} {soon.length === 1 ? "goes" : "go"} to the Trash by tomorrow ·{" "}
        <button className="cursor-default font-medium text-accent hover:underline" onClick={() => void sweep({ manual: true })}>
          Run now
        </button>
      </span>
    );
  return <div className="basis-full pb-1 pl-5 text-[11.5px]">{body}</div>;
}

export function CleanupSection() {
  const s = useSettings();
  const home = useVolumes((v) => v.folders?.home ?? null);
  const keepShortcut = getCommand("toggleCleanupKeep")?.shortcut;

  const setRuleDays = (path: string, days: number) =>
    s.patch({ cleanupRules: s.cleanupRules.map((r) => (r.path === path ? { ...r, days } : r)) });
  const removeRule = (path: string) => s.patch({ cleanupRules: s.cleanupRules.filter((r) => r.path !== path) });
  const addRule = async () => {
    const picked = await ipc.pickFolder(home ?? undefined).catch(() => null);
    if (picked == null) return;
    if (s.cleanupRules.some((r) => expandHome(r.path, home) === picked)) return;
    s.patch({ cleanupRules: [...s.cleanupRules, { path: picked, days: DEFAULT_RULE_DAYS }] });
  };

  return (
    <>
      <SettingGroup>
        <SettingRow
          label="Auto-cleanup"
          hint="Move old items in the folders below to the Trash. Fazi checks when it opens and every hour after. The first check runs an hour after you turn this on."
          keywords="auto cleanup trash old downloads sweep"
          setting="cleanupEnabled"
        >
          <Toggle label="Auto-cleanup" checked={s.cleanupEnabled} onChange={(v) => s.patch({ cleanupEnabled: v })} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Rules">
        <SettingRow
          label="Folders"
          hint="Only items directly inside each folder count. Age counts from when an item arrived."
          keywords="cleanup rules days downloads"
          setting="cleanupRules"
          block
        >
          {s.cleanupRules.length === 0 ? (
            <EmptyNote>No folders yet.</EmptyNote>
          ) : (
            <ListBox>
              {s.cleanupRules.map((rule) => {
                const name = ruleFolderName(rule.path);
                const Icon = expandHome(rule.path, home) === `${home}/Downloads` ? Download : Folder;
                return (
                  <div key={rule.path} className="flex min-h-8 flex-wrap items-center gap-2 py-1 pl-2.5 pr-1.5">
                    <Icon size={13} strokeWidth={1.75} className="shrink-0 text-secondary" aria-hidden />
                    <span
                      className="min-w-0 flex-1 truncate text-[13px] font-medium text-primary"
                      title={displayPath(expandHome(rule.path, home), home)}
                    >
                      {name}
                    </span>
                    <span className="flex items-center gap-1.5 text-[12px] text-secondary">
                      after
                      <Stepper
                        label={`Days before items in ${name} move to the Trash`}
                        value={rule.days}
                        min={1}
                        max={365}
                        step={1}
                        onCommit={(v) => setRuleDays(rule.path, v)}
                      />
                      {rule.days === 1 ? "day" : "days"}
                    </span>
                    <MiniButton label={`Remove ${name}`} onClick={() => removeRule(rule.path)}>
                      <X size={12} strokeWidth={1.75} />
                    </MiniButton>
                    <RuleForecast rulePath={rule.path} />
                  </div>
                );
              })}
            </ListBox>
          )}
          <AddButton onClick={() => void addRule()}>Add a Folder…</AddButton>
        </SettingRow>
        <SettingRow
          label="Keep recently opened files"
          hint="A file you opened within this window stays put."
          keywords="skip opened recent"
          setting="cleanupSkipOpenedDays"
        >
          <Segmented
            label="Keep recently opened files"
            value={String(s.cleanupSkipOpenedDays)}
            options={[
              ["0", "Off"],
              ["1", "1 day"],
              ["3", "3 days"],
              ["7", "7 days"],
            ]}
            onChange={(v) => s.patch({ cleanupSkipOpenedDays: Number(v) })}
          />
        </SettingRow>
        <SettingRow
          label="Protected subfolder"
          hint="A subfolder with this name is never cleaned. Leave it empty for none."
          keywords="keep folder excluded subfolder"
          setting="cleanupKeepFolder"
        >
          <TextField
            label="Protected subfolder"
            value={s.cleanupKeepFolder}
            placeholder="None"
            onCommit={(v) => s.patch({ cleanupKeepFolder: v })}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Exceptions">
        <SettingRow
          label="Kept items"
          hint={`Items you kept${keepShortcut ? ` with ${shortcutLabel(keepShortcut)}` : ""} or put back from the Trash. Auto-cleanup leaves them alone.`}
          keywords="kept pinned skip cleanup"
          block
        >
          {s.cleanupKept.length === 0 ? (
            <EmptyNote>Nothing kept.</EmptyNote>
          ) : (
            <>
              <ListBox>
                {s.cleanupKept.map((k) => {
                  const slash = k.path.lastIndexOf("/");
                  return (
                    <div key={`${k.dev}:${k.ino}`} className="flex min-h-8 items-center gap-2 py-1 pl-2.5 pr-1.5">
                      <FileText size={13} strokeWidth={1.75} className="shrink-0 text-secondary" aria-hidden />
                      <span className="shrink-0 truncate text-[13px] font-medium text-primary">{k.path.slice(slash + 1)}</span>
                      <span className="min-w-0 flex-1 truncate text-[11.5px] text-tertiary">
                        {displayPath(k.path.slice(0, slash) || "/", home)}
                      </span>
                      <MiniButton
                        label={`Stop keeping ${k.path.slice(slash + 1)}`}
                        title="Stop keeping"
                        onClick={() =>
                          s.patch({ cleanupKept: s.cleanupKept.filter((x) => x.dev !== k.dev || x.ino !== k.ino) })
                        }
                      >
                        <span className="px-1 text-secondary">Stop keeping</span>
                      </MiniButton>
                    </div>
                  );
                })}
              </ListBox>
              {s.cleanupKept.length > 1 && (
                <button
                  className="focusable mt-2 h-6 cursor-default rounded-md px-2 text-[12px] font-medium text-secondary hover:bg-hov"
                  onClick={() => s.patch({ cleanupKept: [] })}
                >
                  Stop keeping all {s.cleanupKept.length}
                </button>
              )}
            </>
          )}
        </SettingRow>
      </SettingGroup>
    </>
  );
}

// ---------------------------------------------------------------- Reset

export function ResetSection() {
  const values = useSettings();
  const [confirming, setConfirming] = useState(false);
  const n = totalModified(values);
  const label = `${pluralize(n, "changed setting")}`;
  return (
    <SettingGroup>
      <SettingRow
        label="Reset all settings"
        hint="Return every setting to its default. Pinned folders, kept items, and column widths stay."
        keywords="defaults restore"
      >
        {confirming && n > 0 ? (
          <div
            className="flex items-center gap-2 rounded-lg bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] py-1.5 pl-2.5 pr-1.5 text-[12.5px]"
            role="alert"
          >
            <AlertTriangle size={14} strokeWidth={1.75} className="text-danger" aria-hidden />
            <span className="text-primary">Reset {label}?</span>
            <button
              className="h-6 cursor-default rounded-md bg-pane px-2.5 text-[12px] font-medium hover:bg-hov"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
            <button
              className="h-6 cursor-default rounded-md bg-danger px-2.5 text-[12px] font-medium text-white"
              onClick={() => {
                values.resetToDefaults();
                setConfirming(false);
              }}
            >
              Reset
            </button>
          </div>
        ) : (
          <button
            className={clsx(
              "focusable h-[26px] cursor-default rounded-md px-3 text-[12px] font-medium",
              n === 0
                ? "bg-hov text-tertiary"
                : "bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] text-danger hover:bg-[color-mix(in_srgb,var(--danger)_16%,transparent)]",
            )}
            disabled={n === 0}
            onClick={() => setConfirming(true)}
          >
            {n === 0 ? "Everything is at its default" : `Reset ${label}…`}
          </button>
        )}
      </SettingRow>
    </SettingGroup>
  );
}
