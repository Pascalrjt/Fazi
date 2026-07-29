import { useLayoutEffect, useRef } from "react";
import { captureBrowseFocus, restoreBrowseFocus } from "../lib/keyboardFocus";

/** Preserve keyboard ownership while a temporary surface is open. */
export function useBrowseFocusRestore(open: boolean): void {
  const wasOpen = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      returnFocus.current = captureBrowseFocus();
    } else if (!open && wasOpen.current) {
      const target = returnFocus.current;
      returnFocus.current = null;
      restoreBrowseFocus(target);
    }
    wasOpen.current = open;
  }, [open]);
}
