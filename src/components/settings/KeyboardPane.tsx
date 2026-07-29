/**
 * Keybindings editor: per-command recorder with conflict blocking.
 *
 * The recorder captures a window keydown in the capture phase (stopping
 * propagation so nothing else fires), builds the shortcut via
 * shortcutFromEvent (lone modifiers ignored), and checks a PROSPECTIVE
 * registry for conflicts before anything persists — a conflicting capture is
 * blocked with an "unbind the other command" escape hatch.
 */
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { allCommands } from "../../lib/commands/registry";
import { conflictsForOverrides } from "../../lib/commands";
import { parseShortcut, shortcutFromEvent, shortcutLabel } from "../../lib/keyboard";
import { isVimReservedShortcut } from "../../lib/vim";
import { useSettings } from "../../stores/settings";
import { SettingRow, Toggle } from "./controls";
import * as ipc from "../../lib/ipc";

interface Capture {
  commandId: string;
  shortcut: string;
  conflictWith: string | null;
  /** Blocked because Vim mode reserves the key (no unbind escape hatch). */
  vimReserved?: boolean;
}

const VIM_CHEATS: Array<[string, string]> = [
  ["j / k", "move down / up (counts work: 12j)"],
  ["h", "enclosing folder"],
  ["l", "open selection"],
  ["gg / G", "first / last item"],
  ["v", "visual selection (j/k/gg/G extend, v or Esc exits)"],
  ["yy", "copy"],
  ["dd", "cut (pairs with p to move)"],
  ["p", "paste"],
  ["u / ⌃R", "undo / redo"],
  ["/", "filter this folder (Esc returns)"],
  ["?", "search everywhere"],
  [":", "command palette"],
  ["⌃P", "go to file (fuzzy finder)"],
  ["gt / gT", "next / previous tab"],
  ["Esc", "cancel pending key, exit visual, then clear as usual"],
];

function VimSection() {
  const vimMode = useSettings((s) => s.vimMode);
  return (
    <div className="mb-4 border-b border-edge pb-2">
      <SettingRow
        label="Vim mode"
        hint="Browse with hjkl, visual selection, yy/dd/p. Bare letters stop jumping to names; use / to filter instead."
      >
        <Toggle checked={vimMode} onChange={(v) => useSettings.getState().patch({ vimMode: v })} />
      </SettingRow>
      {vimMode && (
        <div className="mb-2 grid grid-cols-[90px_1fr] gap-x-3 gap-y-1 rounded-md border border-edge bg-pane p-3 text-[12px]">
          {VIM_CHEATS.map(([keys, what]) => (
            <div key={keys} className="contents">
              <span className="tnum text-secondary">{keys}</span>
              <span className="text-tertiary">{what}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function KeyboardPane() {
  const overrides = useSettings((s) => s.keybindingOverrides);
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
        // Blocked: show the conflict, offer to unbind the other command.
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

  return (
    <div>
      <VimSection />
      <div className="mb-2 text-[11px] text-tertiary">
        Click Record, then press the new shortcut. Esc cancels recording.
      </div>
      <div className="divide-y divide-edge">
        {commands.map((cmd) => {
          const overridden = cmd.id in overrides;
          const unbound = overrides[cmd.id] === null;
          const recording = recordingId === cmd.id;
          const rowCapture = capture?.commandId === cmd.id ? capture : null;
          return (
            <div key={cmd.id} className="py-1.5">
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-[13px] text-primary">
                  {cmd.title}
                  {overridden && (
                    <span className="ml-2 rounded bg-accent-faint px-1 text-[10px] text-accent">
                      custom
                    </span>
                  )}
                </span>
                <span
                  className={clsx(
                    "w-24 shrink-0 text-right text-[12px]",
                    recording ? "text-accent" : unbound ? "text-tertiary" : "text-secondary",
                  )}
                >
                  {rowCapture
                    ? `${shortcutLabel(rowCapture.shortcut)} ${rowCapture.vimReserved ? "reserved" : "conflicts"}`
                    : recording
                      ? "press keys…"
                      : unbound
                        ? "—"
                        : cmd.shortcut
                          ? shortcutLabel(cmd.shortcut)
                          : "—"}
                </span>
                <div className="flex shrink-0 gap-1">
                  <button
                    className={clsx(
                      "cursor-default rounded border border-edge px-2 py-0.5 text-[11px] hover:bg-hov",
                      recording ? "text-accent" : "text-secondary",
                    )}
                    onClick={() => {
                      setCapture(null);
                      setRecordingId(recording ? null : cmd.id);
                    }}
                  >
                    {recording ? "Cancel" : "Record"}
                  </button>
                  <button
                    className="cursor-default rounded border border-edge px-2 py-0.5 text-[11px] text-secondary hover:bg-hov disabled:opacity-40"
                    disabled={unbound}
                    title="Remove the shortcut"
                    onClick={() => useSettings.getState().setKeybindingOverride(cmd.id, null)}
                  >
                    Unbind
                  </button>
                  <button
                    className="cursor-default rounded border border-edge px-2 py-0.5 text-[11px] text-secondary hover:bg-hov disabled:opacity-40"
                    disabled={!overridden}
                    title="Restore the default shortcut"
                    onClick={() => useSettings.getState().clearKeybindingOverride(cmd.id)}
                  >
                    Reset
                  </button>
                </div>
              </div>
              {rowCapture && (
                <div
                  className="mt-1.5 rounded-md border border-edge bg-pane p-2.5 text-[12px]"
                  aria-live="polite"
                >
                  <span className="text-danger">
                    {rowCapture.vimReserved
                      ? `${shortcutLabel(rowCapture.shortcut)} is reserved while Vim mode is on.`
                      : `${shortcutLabel(rowCapture.shortcut)} is taken by “${titleOf(rowCapture.conflictWith ?? "")}”.`}
                  </span>
                  <div className="mt-1.5 flex gap-2">
                    {!rowCapture.vimReserved && (
                      <button
                        className="cursor-default rounded border border-edge px-2 py-0.5 text-[11px] text-secondary hover:bg-hov"
                        onClick={() => {
                          const settings = useSettings.getState();
                          if (rowCapture.conflictWith) {
                            settings.setKeybindingOverride(rowCapture.conflictWith, null);
                          }
                          settings.setKeybindingOverride(rowCapture.commandId, [rowCapture.shortcut]);
                          setCapture(null);
                          setRecordingId(null);
                        }}
                      >
                        Unbind “{titleOf(rowCapture.conflictWith ?? "")}” and use it here
                      </button>
                    )}
                    <button
                      className="cursor-default rounded border border-edge px-2 py-0.5 text-[11px] text-secondary hover:bg-hov"
                      onClick={() => {
                        setCapture(null);
                        setRecordingId(null);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
