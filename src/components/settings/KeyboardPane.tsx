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
import { shortcutFromEvent, shortcutLabel } from "../../lib/keyboard";
import { useSettings } from "../../stores/settings";

interface Capture {
  commandId: string;
  shortcut: string;
  conflictWith: string | null;
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
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recordingId]);

  const titleOf = (id: string) => commands.find((c) => c.id === id)?.title ?? id;

  return (
    <div>
      <div className="mb-2 text-[11px] text-tertiary">
        Click Record, then press the new shortcut. Esc cancels recording.
      </div>
      {capture && (
        <div className="mb-3 rounded-md border border-edge bg-pane p-2.5 text-[12px]">
          <span className="text-danger">
            {shortcutLabel(capture.shortcut)} is taken by “{titleOf(capture.conflictWith ?? "")}”.
          </span>
          <div className="mt-1.5 flex gap-2">
            <button
              className="cursor-default rounded border border-edge px-2 py-0.5 text-[11px] text-secondary hover:bg-hov"
              onClick={() => {
                const s = useSettings.getState();
                // Unbind the other command, then bind this one.
                if (capture.conflictWith) s.setKeybindingOverride(capture.conflictWith, null);
                s.setKeybindingOverride(capture.commandId, [capture.shortcut]);
                setCapture(null);
                setRecordingId(null);
              }}
            >
              Unbind “{titleOf(capture.conflictWith ?? "")}” and use it here
            </button>
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
      <div className="divide-y divide-edge">
        {commands.map((cmd) => {
          const overridden = cmd.id in overrides;
          const unbound = overrides[cmd.id] === null;
          const recording = recordingId === cmd.id;
          return (
            <div key={cmd.id} className="flex items-center gap-3 py-1.5">
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
                {recording ? "press keys…" : unbound ? "—" : cmd.shortcut ? shortcutLabel(cmd.shortcut) : "—"}
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
          );
        })}
      </div>
    </div>
  );
}
