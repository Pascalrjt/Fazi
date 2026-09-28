/**
 * Auto-cleanup state and scheduling. Sweeps run only while Fazi is open: a
 * couple of minutes after launch, then hourly. Turning the feature on waits a
 * full hour before the first sweep, so items already past their rule are
 * flagged (and can be kept) before anything moves.
 */
import { create } from "zustand";
import * as ipc from "../lib/ipc";
import { countWithSize, leavingSoon, ruleFolderName } from "../lib/cleanup";
import { pluralize } from "../lib/format";
import type { CleanupFolderReport, CleanupItem, CleanupOptions } from "../types/ipc";
import { toast } from "./app";
import { usePanes } from "./panes";
import { useSettings, type KeptItem, type SettingsValues } from "./settings";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** First sweep after launch: long enough for the indicators to be seen. */
const LAUNCH_DELAY = 2 * MINUTE;
/** First sweep after the feature is turned on. */
const ENABLE_DELAY = HOUR;
const RESCAN_EVERY = 5 * MINUTE;

/** A scanned item plus the rule that covers it. */
export interface CleanupEntry extends CleanupItem {
  folder: string;
  days: number;
}

interface CleanupState {
  reports: CleanupFolderReport[];
  /** Every scanned item, by path. */
  items: Map<string, CleanupEntry>;
  /** Folders that scanned cleanly (absolute paths). */
  folders: Set<string>;
  /** Clock for countdown labels; ticks every minute. */
  now: number;
  nextSweepAt: number | null;
  sweeping: boolean;
  /** Banner dismissals: folder → the leaving-soon set it was dismissed for. */
  dismissed: Record<string, string>;

  scan(): Promise<void>;
  sweep(opts?: { manual?: boolean }): Promise<void>;
  dismissBanner(folder: string, signature: string): void;
}

export function cleanupOptions(s: SettingsValues = useSettings.getState()): CleanupOptions {
  return {
    rules: s.cleanupRules,
    pins: s.cleanupKept.map(({ dev, ino }) => ({ dev, ino })),
    skipOpenedDays: s.cleanupSkipOpenedDays,
    keepFolder: s.cleanupKeepFolder.trim(),
  };
}

function indexReports(reports: CleanupFolderReport[]): Pick<CleanupState, "items" | "folders"> {
  const items = new Map<string, CleanupEntry>();
  const folders = new Set<string>();
  for (const r of reports) {
    if (r.error != null) continue;
    folders.add(r.folder);
    for (const item of r.items) items.set(item.path, { ...item, folder: r.folder, days: r.days });
  }
  return { items, folders };
}

/** Kept items that were deleted or moved out of their folder are dropped; a
 *  rename in place updates the stored path. Folders that failed to scan
 *  (an unmounted volume) keep their pins untouched. */
function reconcileKept(reports: CleanupFolderReport[]): void {
  const settings = useSettings.getState();
  const byIdentity = new Map<string, CleanupItem>();
  const scanned = new Set<string>();
  for (const r of reports) {
    if (r.error != null) continue;
    scanned.add(r.folder);
    for (const item of r.items) byIdentity.set(`${item.dev}:${item.ino}`, item);
  }
  let changed = false;
  const next: KeptItem[] = [];
  for (const kept of settings.cleanupKept) {
    const parent = kept.path.slice(0, kept.path.lastIndexOf("/")) || "/";
    const found = byIdentity.get(`${kept.dev}:${kept.ino}`);
    if (found) {
      if (found.path !== kept.path) changed = true;
      next.push({ ...kept, path: found.path });
    } else if (scanned.has(parent)) {
      changed = true;
    } else {
      next.push(kept);
    }
  }
  if (changed) settings.patch({ cleanupKept: next });
}

let scanSeq = 0;

export const useCleanup = create<CleanupState>()((set, get) => ({
  reports: [],
  items: new Map(),
  folders: new Set(),
  now: Date.now(),
  nextSweepAt: null,
  sweeping: false,
  dismissed: {},

  scan: async () => {
    if (!useSettings.getState().cleanupEnabled) return;
    const seq = ++scanSeq;
    try {
      const reports = await ipc.cleanupScan(cleanupOptions());
      // A newer scan (or a sweep's fresh report) superseded this one.
      if (seq !== scanSeq || !useSettings.getState().cleanupEnabled) return;
      set({ reports, ...indexReports(reports), now: Date.now() });
      reconcileKept(reports);
    } catch {
      // no backend (tests / browser preview) — indicators stay empty
    }
  },

  sweep: async (opts) => {
    if (get().sweeping || !useSettings.getState().cleanupEnabled) return;
    set({ sweeping: true });
    try {
      const result = await ipc.cleanupSweep(cleanupOptions());
      scanSeq++;
      set({
        reports: result.reports,
        ...indexReports(result.reports),
        now: Date.now(),
        nextSweepAt: Date.now() + HOUR,
      });
      reconcileKept(result.reports);
      if (result.swept.length > 0) {
        usePanes.getState().removeEntriesByPath(result.swept.map((s) => s.original));
        const folders = new Set(result.swept.map((s) => s.original.slice(0, s.original.lastIndexOf("/"))));
        const from = folders.size === 1 ? ` from ${ruleFolderName([...folders][0])}` : "";
        const pairs = result.swept.map(({ original, trashed }) => ({ original, trashed }));
        toast(`Moved ${countWithSize(result.swept)}${from} to Trash`, {
          sticky: true,
          action: { label: "Put Back", run: () => void putBack(pairs) },
        });
      } else if (opts?.manual && result.errors.length === 0) {
        toast("Nothing is due for cleanup");
      }
      if (result.errors.length > 0) {
        toast(
          `Auto-cleanup couldn't move ${pluralize(result.errors.length, "item")}: ${result.errors[0]}`,
          { danger: true },
        );
      }
    } catch (err) {
      toast(`Auto-cleanup failed: ${err}`, { danger: true });
    } finally {
      set({ sweeping: false });
    }
  },

  dismissBanner: (folder, signature) =>
    set((s) => ({ dismissed: { ...s.dismissed, [folder]: signature } })),
}));

/** Restore a sweep and keep what came back: those items are past their rule,
 *  so without a pin the next sweep would take them again. */
async function putBack(pairs: Array<{ original: string; trashed: string }>): Promise<void> {
  try {
    const result = await ipc.cleanupRestore(pairs);
    if (result.restored.length > 0) {
      const settings = useSettings.getState();
      const kept = settings.cleanupKept.filter(
        (k) => !result.restored.some((r) => r.dev === k.dev && r.ino === k.ino),
      );
      settings.patch({ cleanupKept: [...kept, ...result.restored] });
      toast(`Put back ${pluralize(result.restored.length, "item")} and marked them Keep`);
    }
    if (result.errors.length > 0) {
      toast(
        `Couldn't put back ${pluralize(result.errors.length, "item")}: ${result.errors[0]}`,
        { danger: true },
      );
    }
  } catch (err) {
    toast(`Couldn't put back: ${err}`, { danger: true });
  }
}

/** Items in the given folder leaving by the end of tomorrow. */
export function leavingSoonIn(folder: string, s: CleanupState = useCleanup.getState()): CleanupEntry[] {
  const out: CleanupEntry[] = [];
  for (const item of s.items.values()) {
    if (item.folder === folder && leavingSoon(item, s.now)) out.push(item);
  }
  return out;
}

/** Every leaving-soon item across all rule folders. */
export function leavingSoonAll(s: CleanupState = useCleanup.getState()): CleanupEntry[] {
  const out: CleanupEntry[] = [];
  for (const item of s.items.values()) if (leavingSoon(item, s.now)) out.push(item);
  return out;
}

/**
 * Keep / stop keeping. Mixed selections become all kept; a fully kept
 * selection is released. Items outside rule folders are ignored.
 */
export function toggleKeep(paths: string[]): void {
  const { items } = useCleanup.getState();
  const targets = paths
    .map((p) => items.get(p))
    .filter((i): i is CleanupEntry => i != null && (i.status === "scheduled" || i.status === "kept"));
  if (targets.length === 0) {
    toast("Keep works on items in auto-cleanup folders");
    return;
  }
  const settings = useSettings.getState();
  const same = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) =>
    a.dev === b.dev && a.ino === b.ino;
  if (targets.every((t) => t.status === "kept")) {
    settings.patch({
      cleanupKept: settings.cleanupKept.filter((k) => !targets.some((t) => same(t, k))),
    });
    toast(`Auto-cleanup will include ${pluralize(targets.length, "item")} again`);
  } else {
    const fresh = targets
      .filter((t) => t.status !== "kept")
      .map(({ dev, ino, path }) => ({ dev, ino, path }));
    settings.patch({ cleanupKept: [...settings.cleanupKept, ...fresh] });
    toast(`Keeping ${pluralize(fresh.length, "item")}`);
  }
}

export function isInCleanupFolder(path: string): boolean {
  return useCleanup.getState().items.has(path);
}

let started = false;

/** Boot-time wiring: clock, sweep timer, and rescans on relevant changes. */
export function startCleanup(): void {
  if (started) return;
  started = true;

  const enabledAtLaunch = useSettings.getState().cleanupEnabled;
  if (enabledAtLaunch) {
    useCleanup.setState({ nextSweepAt: Date.now() + LAUNCH_DELAY });
    void useCleanup.getState().scan();
  }

  let lastScan = Date.now();
  setInterval(() => {
    const now = Date.now();
    useCleanup.setState({ now });
    if (!useSettings.getState().cleanupEnabled) return;
    const { nextSweepAt } = useCleanup.getState();
    if (nextSweepAt != null && now >= nextSweepAt) {
      lastScan = now;
      void useCleanup.getState().sweep();
    } else if (now - lastScan >= RESCAN_EVERY) {
      lastScan = now;
      void useCleanup.getState().scan();
    }
  }, MINUTE);

  let rescanTimer: ReturnType<typeof setTimeout> | null = null;
  const rescanSoon = (delay: number) => {
    if (rescanTimer) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      lastScan = Date.now();
      void useCleanup.getState().scan();
    }, delay);
  };

  useSettings.subscribe((s, prev) => {
    if (s.cleanupEnabled !== prev.cleanupEnabled) {
      if (s.cleanupEnabled) {
        useCleanup.setState({ nextSweepAt: Date.now() + ENABLE_DELAY });
        rescanSoon(0);
      } else {
        scanSeq++;
        useCleanup.setState({
          reports: [],
          items: new Map(),
          folders: new Set(),
          nextSweepAt: null,
        });
      }
      return;
    }
    if (
      s.cleanupEnabled &&
      (s.cleanupRules !== prev.cleanupRules ||
        s.cleanupKept !== prev.cleanupKept ||
        s.cleanupSkipOpenedDays !== prev.cleanupSkipOpenedDays ||
        s.cleanupKeepFolder !== prev.cleanupKeepFolder)
    ) {
      rescanSoon(250);
    }
  });

  // A listing change in a rule folder (a new download landing, a rename)
  // rescans that folder's countdowns shortly after.
  const seen = new Map<string, unknown>();
  usePanes.subscribe((s) => {
    if (!useSettings.getState().cleanupEnabled) return;
    const { folders } = useCleanup.getState();
    let changed = false;
    for (const pane of s.panes) {
      for (const tab of pane.tabs) {
        if (!folders.has(tab.path)) continue;
        if (seen.get(tab.id) !== tab.entries) {
          seen.set(tab.id, tab.entries);
          changed = true;
        }
      }
    }
    if (changed) rescanSoon(1000);
  });
}
