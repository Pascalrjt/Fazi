/** cmdk command palette (⌘K) fed by the command registry. */
import { useEffect } from "react";
import { Command } from "cmdk";
import { useApp } from "../../stores/app";
import { allCommands } from "../../lib/commands/registry";
import { shortcutLabel } from "../../lib/keyboard";

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const setOpen = useApp((s) => s.setPaletteOpen);

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

  const commands = allCommands().filter((c) => !c.hidden);

  return (
    <div
      className="anim-fade fixed inset-0 z-[85] flex items-start justify-center bg-black/30 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <Command
        label="Command palette"
        className="anim-pop w-[520px] overflow-hidden rounded-xl border border-edge bg-raised"
        style={{ boxShadow: "var(--shadow-overlay)" }}
      >
        <Command.Input
          autoFocus
          placeholder="Type a command…"
          className="w-full border-b border-edge bg-transparent px-4 py-3 text-[14px] text-primary outline-none placeholder:text-tertiary"
        />
        <Command.List className="max-h-[320px] overflow-y-auto p-1.5">
          <Command.Empty className="px-3 py-6 text-center text-xs text-tertiary">
            No matching command
          </Command.Empty>
          {commands.map((cmd) => {
            const disabled = cmd.enabled ? !cmd.enabled() : false;
            return (
              <Command.Item
                key={cmd.id}
                value={`${cmd.title} ${cmd.keywords ?? ""}`}
                disabled={disabled}
                onSelect={() => {
                  setOpen(false);
                  cmd.run();
                }}
                className="flex cursor-default items-center gap-3 rounded-md px-3 py-2 text-[13px] text-primary aria-disabled:opacity-40 data-[selected=true]:bg-accent data-[selected=true]:text-white"
              >
                <span className="min-w-0 flex-1 truncate">{cmd.title}</span>
                {cmd.shortcut && (
                  <span className="shrink-0 text-[11px] tracking-wide opacity-60">
                    {shortcutLabel(cmd.shortcut)}
                  </span>
                )}
              </Command.Item>
            );
          })}
        </Command.List>
      </Command>
    </div>
  );
}
