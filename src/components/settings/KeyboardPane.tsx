/**
 * Keyboard settings: Vim mode, then every command's shortcut, grouped by
 * area and filterable. Click a shortcut to record a new one.
 *
 * The recorder captures a window keydown in the capture phase (stopping
 * propagation so nothing else fires), builds the shortcut via
 * shortcutFromEvent (lone modifiers ignored), and checks a PROSPECTIVE
 * registry for conflicts before anything persists. A conflicting capture is
 * blocked, with an offer to move the shortcut from the other command.
 */
import { useContext, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { RotateCcw, Search, X } from "lucide-react";
import { allCommands, type RegisteredCommand } from "../../lib/commands/registry";
import { conflictsForOverrides } from "../../lib/commands";
import { parseShortcut, shortcutFromEvent, shortcutLabel } from "../../lib/keyboard";
import { isVimReservedShortcut, VIM_CHEATS } from "../../lib/vim";
import { useSettings } from "../../stores/settings";
import { SettingGroup, SettingRow, SettingsFilterContext, Toggle } from "./controls";
import * as ipc from "../../lib/ipc";

interface Capture {
  commandId: string;
  shortcut: string;
  conflictWith: string | null;
  /** Blocked because Vim mode reserves the key (no move escape hatch). */
  vimReserved?: boolean;
}

/** Shortcut-list groups, in display order. Unlisted commands land in "Other". */
const CATEGORIES: Array<[string, string[]]> = [
  [
    "Files",
    ["open", "openWith", "contextMenu", "getInfo", "preview", "quicklookPanel", "newFolder", "rename",
      "batchRename", "duplicate", "compress", "extract", "share", "revealInFinder"],
  ],
  ["Edit", ["copy", "cut", "paste", "movePaste", "copyName", "copyPathname", "undo", "redo", "selectAll"]],
  ["Trash and cleanup", ["trash", "deletePermanent", "emptyTrash", "goTrash", "toggleCleanupKeep",
    "cleanupNow", "cleanupSettings"]],
  ["Go", ["back", "forward", "up", "goHome", "goDesktop", "goDocuments", "goDownloads", "goApplications",
    "openLocation", "eject"]],
  ["Tabs and panes", ["newTab", "closeTab", "nextTab", "prevTab", "dualPane", "swapPane", "toggleSidebar"]],
  ["View", ["viewList", "viewGrid", "toggleHidden", "refresh"]],
  ["Search and commands", ["focusSearch", "fuzzyFinder", "globalSearch", "palette", "toggleVimMode",
    "vimHelp", "settings"]],
];

function categoryOf(id: string): string {
  return CATEGORIES.find(([, ids]) => ids.includes(id))?.[0] ?? "Other";
}

function VimRows() {
  const vimMode = useSettings((s) => s.vimMode);
  const focusRing = useSettings((s) => s.paneAccentLine);
  const query = useContext(SettingsFilterContext);
  const patch = useSettings((s) => s.patch);
  return (
    <SettingGroup title="Vim">
      <SettingRow
        label="Vim mode"
        hint="Move with hjkl, select with v, copy and paste with yy, dd, and p. Letter keys stop jumping to file names; press / to filter instead."
        keywords="hjkl modal keys"
        setting="vimMode"
      >
        <Toggle label="Vim mode" checked={vimMode} onChange={(v) => patch({ vimMode: v })} />
      </SettingRow>
      <SettingRow
        label="Focus ring"
        hint="Outline the pane that receives your keystrokes."
        keywords="active pane outline accent"
        setting="paneAccentLine"
        needs={{ label: "Vim mode", on: vimMode }}
      >
        <Toggle
          label="Focus ring"
          checked={focusRing}
          disabled={!vimMode}
          onChange={(v) => patch({ paneAccentLine: v })}
        />
      </SettingRow>
      {vimMode && query === "" && (
        <div className="px-3.5 pb-3">
          <div className="grid grid-cols-[auto_1fr_auto_1fr] gap-x-2.5 gap-y-1.5 rounded-lg bg-pane px-3 py-2.5 text-[12px] text-secondary">
            {VIM_CHEATS.map(([keys, what]) => (
              <div key={keys} className="contents">
                <kbd className="justify-self-start whitespace-nowrap rounded-[5px] bg-raised px-1.5 py-0.5 font-sans text-[11.5px] text-primary shadow-[0_0_0_0.5px_var(--border-strong)]">
                  {keys}
                </kbd>
                <span>{what}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </SettingGroup>
  );
}

function ShortcutRow({
  cmd,
  overridden,
  recording,
  capture,
  titleOf,
  onRecord,
  onCancel,
  onTakeover,
}: {
  cmd: RegisteredCommand;
  overridden: boolean;
  recording: boolean;
  capture: Capture | null;
  titleOf(id: string): string;
  onRecord(): void;
  onCancel(): void;
  onTakeover(): void;
}) {
  const setOverride = useSettings((s) => s.setKeybindingOverride);
  const clearOverride = useSettings((s) => s.clearKeybindingOverride);
  const shortcut = cmd.shortcut;
  return (
    <div
      className="settings-row group/cmd flex min-h-8 flex-wrap items-center gap-1.5 rounded-[7px] py-0.5 pl-2 pr-1 hover:bg-hov"
      data-command-id={cmd.id}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-[13px] text-primary">
        {cmd.title}
        {overridden && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="Changed from default" />}
      </span>
      <span className="invisible flex gap-0.5 group-focus-within/cmd:visible group-hover/cmd:visible">
        {overridden && (
          <button
            className="flex h-[22px] w-[22px] cursor-default items-center justify-center rounded-[5px] text-tertiary hover:bg-hov hover:text-primary"
            title="Restore the default shortcut"
            aria-label={`Restore the default shortcut for ${cmd.title}`}
            onClick={() => clearOverride(cmd.id)}
          >
            <RotateCcw size={12} strokeWidth={1.75} />
          </button>
        )}
        {shortcut && (
          <button
            className="flex h-[22px] w-[22px] cursor-default items-center justify-center rounded-[5px] text-tertiary hover:bg-hov hover:text-primary"
            title="Remove the shortcut"
            aria-label={`Remove the shortcut for ${cmd.title}`}
            onClick={() => setOverride(cmd.id, null)}
          >
            <X size={12} strokeWidth={1.75} />
          </button>
        )}
      </span>
      <button
        className={clsx(
          "focusable flex h-[26px] min-w-[92px] cursor-default items-center rounded-md px-1",
          recording
            ? "justify-center bg-accent-faint shadow-[inset_0_0_0_1.5px_var(--accent)]"
            : "justify-end hover:bg-hov",
        )}
        aria-label={recording ? `Recording a shortcut for ${cmd.title}` : `Change the shortcut for ${cmd.title}`}
        onClick={recording ? onCancel : onRecord}
      >
        {capture ? (
          <kbd className="rounded-[5px] bg-raised px-1.5 py-0.5 font-sans text-[11.5px] text-primary shadow-[0_0_0_1.5px_var(--danger)]">
            {capture.vimReserved ? capture.shortcut : shortcutLabel(capture.shortcut)}
          </kbd>
        ) : recording ? (
          <span className="animate-pulse text-[12px] font-medium text-accent">Press keys…</span>
        ) : shortcut ? (
          <kbd className="rounded-[5px] bg-raised px-1.5 py-0.5 font-sans text-[11.5px] text-primary shadow-[0_0_0_0.5px_var(--border-strong),0_1px_0_var(--border-strong)]">
            {shortcutLabel(shortcut)}
          </kbd>
        ) : (
          <span className="pr-1 text-[12px] text-tertiary">None</span>
        )}
      </button>
      {capture && (
        <div
          className="mb-1.5 mt-0.5 flex basis-full items-center gap-2 rounded-[7px] bg-[color-mix(in_srgb,var(--danger)_11%,transparent)] py-1.5 pl-2.5 pr-1.5 text-[12px]"
          role="alert"
        >
          <span className="flex-1 text-primary">
            {capture.vimReserved
              ? `${capture.shortcut} belongs to Vim mode while it's on.`
              : `${shortcutLabel(capture.shortcut)} already runs “${titleOf(capture.conflictWith ?? "")}”.`}
          </span>
          <button
            className="h-6 cursor-default rounded-md bg-pane px-2.5 text-[12px] font-medium hover:bg-hov"
            onClick={onCancel}
          >
            {capture.vimReserved ? "OK" : "Cancel"}
          </button>
          {!capture.vimReserved && (
            <button
              className="h-6 cursor-default rounded-md bg-accent px-2.5 text-[12px] font-medium text-white"
              onClick={onTakeover}
            >
              Move it here
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Shortcuts() {
  const overrides = useSettings((s) => s.keybindingOverrides);
  const query = useContext(SettingsFilterContext);
  const [filter, setFilter] = useState("");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [capture, setCapture] = useState<Capture | null>(null);

  // Registry snapshot re-reads when overrides change (registry was rebuilt).
  const commands = useMemo(
    () => allCommands().filter((c) => !c.hidden),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [overrides],
  );

  useEffect(() => {
    if (recordingId == null) return;
    try {
      void ipc.setShortcutRecording(true).catch(() => {});
    } catch {
      // Browser-only preview/test: there is no native menu to suspend.
    }
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setRecordingId(null);
        setCapture(null);
        return;
      }
      const shortcut = shortcutFromEvent(e);
      if (shortcut == null) return; // lone modifier — keep recording
      // With Vim mode on, its reserved keys can't be recorded — sanitize
      // would silently strip them at registration anyway.
      const parsed = parseShortcut(shortcut);
      if (useSettings.getState().vimMode && parsed && isVimReservedShortcut(parsed)) {
        setCapture({ commandId: recordingId, shortcut, conflictWith: null, vimReserved: true });
        return;
      }
      const prospective = { ...useSettings.getState().keybindingOverrides, [recordingId]: [shortcut] };
      const conflicts = conflictsForOverrides(prospective);
      // Find the other command named in a conflict mentioning this one.
      let conflictWith: string | null = null;
      for (const c of conflicts) {
        if (c.includes(`"${recordingId}"`)) {
          const m = /"([^"]+)" and "([^"]+)"/.exec(c);
          if (m) conflictWith = m[1] === recordingId ? m[2] : m[1];
          break;
        }
      }
      if (conflictWith == null) {
        useSettings.getState().setKeybindingOverride(recordingId, [shortcut]);
        setRecordingId(null);
        setCapture(null);
      } else {
        // Blocked: show the conflict, offer to move the shortcut here.
        setCapture({ commandId: recordingId, shortcut, conflictWith });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      try {
        void ipc.setShortcutRecording(false).catch(() => {});
      } catch {
        // Browser-only preview/test.
      }
    };
  }, [recordingId]);

  const titleOf = (id: string) => commands.find((c) => c.id === id)?.title ?? id;
  // The settings search narrows to command names; the local filter also
  // matches areas and shortcut labels (type "⌘D" or "tabs").
  const q = (query || filter).trim().toLowerCase();
  const matches = commands.filter((c) =>
    query !== ""
      ? c.title.toLowerCase().includes(q)
      : `${c.title} ${categoryOf(c.id)} ${c.shortcut ? shortcutLabel(c.shortcut) : ""}`
          .toLowerCase()
          .includes(q),
  );
  const changed = Object.keys(overrides).length;
  const groups = [...CATEGORIES.map(([name]) => name), "Other"]
    .map((name) => [name, matches.filter((c) => categoryOf(c.id) === name)] as const)
    .filter(([, list]) => list.length > 0);

  const rows = groups.map(([name, list]) => (
    <div key={name} className="mt-2.5 first:mt-0">
      <div className="px-0.5 py-1 text-[11px] font-semibold text-tertiary">{name}</div>
      {list.map((cmd) => (
        <ShortcutRow
          key={cmd.id}
          cmd={cmd}
          overridden={cmd.id in overrides}
          recording={recordingId === cmd.id}
          capture={capture?.commandId === cmd.id ? capture : null}
          titleOf={titleOf}
          onRecord={() => {
            setCapture(null);
            setRecordingId(cmd.id);
          }}
          onCancel={() => {
            setCapture(null);
            setRecordingId(null);
          }}
          onTakeover={() => {
            if (!capture) return;
            const settings = useSettings.getState();
            if (capture.conflictWith) settings.setKeybindingOverride(capture.conflictWith, null);
            settings.setKeybindingOverride(capture.commandId, [capture.shortcut]);
            setCapture(null);
            setRecordingId(null);
          }}
        />
      ))}
    </div>
  ));

  // In settings search, matching commands join the results without the
  // list chrome; a search that matches none leaves the group hidden.
  if (query !== "") {
    return groups.length > 0 ? <SettingGroup title="Shortcuts"><div className="p-2">{rows}</div></SettingGroup> : null;
  }

  return (
    <SettingGroup title="Shortcuts">
      <div className="settings-row block p-3">
        <div className="mb-1 text-[11.5px] text-tertiary">
          Click a shortcut, then press the new keys. Esc cancels.
        </div>
        <div className="mb-2 flex items-center gap-2.5">
          <label className="flex h-7 flex-1 items-center gap-1.5 rounded-[7px] bg-hov px-2.5 text-tertiary focus-within:shadow-[0_0_0_1.5px_var(--accent)]">
            <Search size={12} strokeWidth={1.75} aria-hidden />
            <input
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-primary outline-none placeholder:text-tertiary"
              placeholder="Filter by name, area, or keys"
              aria-label="Filter shortcuts"
              value={filter}
              spellCheck={false}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && filter !== "") {
                  e.preventDefault();
                  setFilter("");
                }
                e.stopPropagation();
              }}
            />
          </label>
          {changed > 0 && (
            <button
              className="cursor-default text-[12px] font-medium text-accent hover:underline"
              onClick={() => useSettings.getState().patch({ keybindingOverrides: {} })}
            >
              Restore {changed} changed
            </button>
          )}
        </div>
        {rows.length > 0 ? rows : <div className="py-3 text-center text-[12px] text-tertiary">No commands match.</div>}
      </div>
    </SettingGroup>
  );
}

export function KeyboardPane() {
  return (
    <>
      <VimRows />
      <Shortcuts />
    </>
  );
}
