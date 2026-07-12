/**
 * Sidebar pin resolution shared by the Favorites section (HTML5 drops) and
 * the native drag bridge (Finder drag-in / native self-drops). Must NOT
 * import lib/dnd.ts — dnd.ts imports this for its pin dispatch.
 */
import { usePanes, activePaneTab } from "../stores/panes";
import { useVolumes } from "../stores/volumes";
import { useSettings } from "../stores/settings";
import { toast } from "../stores/app";
import * as ipc from "./ipc";
import { basename, pluralize } from "./format";
import type { Entry } from "../types/ipc";

/** Default sidebar rows' paths — pins dedupe against these. */
export function defaultSidebarPaths(): string[] {
  const f = useVolumes.getState().folders;
  return f ? [f.home, f.desktop, f.documents, f.downloads, f.applications] : [];
}

/** Find an entry for `path` in any open listing (cheap pin resolution). */
function entryFromListings(path: string): Entry | null {
  for (const pane of usePanes.getState().panes) {
    for (const tab of pane.tabs) {
      const hit = tab.entries.find((en) => en.path === path);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Resolve paths to entries (open listings, else statPath via the active
 * tab's listingId), keep plain dirs, pin at `atIndex` (append when omitted),
 * and toast the outcome.
 */
export async function pinFolders(paths: string[], atIndex?: number): Promise<void> {
  const at = activePaneTab();
  const resolved: Entry[] = [];
  for (const path of paths) {
    let entry = entryFromListings(path);
    if (!entry && at?.tab.listingId) {
      try {
        entry = await ipc.statPath(path, at.tab.listingId);
      } catch {
        entry = null;
      }
    }
    if (entry) resolved.push(entry);
  }
  const dirs = resolved.filter((en) => en.kind === "dir" && !en.isPackage);
  if (dirs.length === 0) {
    toast("Only folders can be added to the sidebar");
    return;
  }
  const added = useSettings
    .getState()
    .addFavorites(
      dirs.map((en) => ({ path: en.path, name: en.name || basename(en.path) })),
      defaultSidebarPaths(),
      atIndex,
    );
  if (added === 0) {
    toast("Already in the sidebar");
  } else {
    toast(`Added ${pluralize(added, "folder")} to the sidebar`);
  }
}
