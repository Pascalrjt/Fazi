import { useEffect } from "react";

/**
 * While `open`, intercept Escape with a capture-phase window listener
 * (preventDefault + stopImmediatePropagation, so nothing underneath sees the
 * key) and run `onEscape`. Added per-open, removed on close/unmount. Pass a
 * stable (useCallback) handler — the listener re-registers when it changes.
 */
export function useCaptureEscape(open: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onEscape();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onEscape]);
}
