/**
 * Vim cheat sheet: a which-key-style reference card anchored bottom-right
 * (above the status bar), like lazyvim's. Toggled by g? (interpreter →
 * vimHelp command), the palette entry, or clicking the mode indicator in the
 * status bar. Deliberately NOT a modal: browse keys keep working while it's
 * up, so you can practice the motions with the card in view — which is also
 * what lets g? toggle it closed again. Escape closes it (capture-phase, so it
 * wins over the vim interpreter and the registry's Escape cascade).
 */
import { useEffect } from "react";
import { VIM_CHEATS } from "../../lib/vim";
import { useApp } from "../../stores/app";

export function VimCheatSheet() {
  const open = useApp((s) => s.vimHelpOpen);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        useApp.getState().setVimHelpOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="anim-pop fixed bottom-8 right-2 z-[80] w-[480px] overflow-hidden rounded-xl border border-edge bg-raised"
      style={{ boxShadow: "var(--shadow-overlay)" }}
    >
      <div className="px-4 py-2.5">
        {VIM_CHEATS.map(([keys, desc]) => (
          <div key={keys} className="flex items-baseline gap-4 py-[3px] text-[12px]">
            <span className="tnum w-24 shrink-0 text-primary">{keys}</span>
            <span className="text-secondary">{desc}</span>
          </div>
        ))}
      </div>
      <div className="flex h-7 items-center border-t border-edge px-4 text-[11px] text-tertiary">
        g? toggles this card · Esc closes
      </div>
    </div>
  );
}
