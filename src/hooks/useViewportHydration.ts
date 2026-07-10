/**
 * Feed the visible range's unhydrated rows into the shared hydration
 * scheduler, debounced 100 ms — a scroll flick never fires a request for
 * rows that already left the viewport (the cleanup cancels the pending
 * debounce on every range change).
 */
import { useEffect } from "react";
import type { Entry } from "../types/ipc";
import { requestViewportHydration } from "../lib/hydration";

export function useViewportHydration(
  listingId: string | null | undefined,
  visible: readonly Entry[],
  firstIndex: number,
  lastIndex: number,
): void {
  useEffect(() => {
    if (!listingId || visible.length === 0) return;
    const timer = setTimeout(() => {
      const ids: number[] = [];
      const end = Math.min(lastIndex, visible.length - 1);
      for (let i = Math.max(0, firstIndex); i <= end; i++) {
        const e = visible[i];
        if (e && !e.hydrated) ids.push(e.id);
      }
      if (ids.length > 0) requestViewportHydration(listingId, ids);
    }, 100);
    return () => clearTimeout(timer);
  }, [listingId, visible, firstIndex, lastIndex]);
}
