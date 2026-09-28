/**
 * Auto-cleanup presentation helpers: countdown labels and summary phrases.
 * Pure — unit-tested. Scheduling and state live in stores/cleanup.ts.
 */
import type { CleanupItem } from "../types/ipc";
import { formatBytes, formatDateFull, pluralize } from "./format";

/** "due" = goes in the next sweep, today, or tomorrow (red);
 *  "soon" = within 3 days; "later" = everything else. */
export type ExpiryTone = "due" | "soon" | "later";

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole calendar days from `from` to `to` in local time (DST-safe). */
export function calendarDaysBetween(from: number, to: number): number {
  return Math.round((startOfDay(to) - startOfDay(from)) / 86_400_000);
}

export function expiryLabel(expires: number, now: number): { text: string; tone: ExpiryTone } {
  if (expires <= now) return { text: "Next sweep", tone: "due" };
  const days = calendarDaysBetween(now, expires);
  if (days <= 0) return { text: "Today", tone: "due" };
  if (days === 1) return { text: "Tomorrow", tone: "due" };
  return { text: `in ${days} days`, tone: days <= 3 ? "soon" : "later" };
}

/** Scheduled and gone by the end of tomorrow: what the banner, sidebar badge,
 *  status bar, and hourglass flag count. */
export function leavingSoon(item: CleanupItem, now: number): boolean {
  return (
    item.status === "scheduled" &&
    item.expires != null &&
    expiryLabel(item.expires, now).tone === "due"
  );
}

/** "today" / "tomorrow" / "by tomorrow" for a set of leaving-soon items. */
export function leavingPhrase(items: CleanupItem[], now: number): string {
  const days = items.map((i) => (i.expires == null ? 0 : calendarDaysBetween(now, i.expires)));
  if (days.every((d) => d <= 0)) return "today";
  if (days.every((d) => d === 1)) return "tomorrow";
  return "by tomorrow";
}

/** "4 items (2.7 GB)"; the size is left off when a folder is involved
 *  (folders aren't walked, so any total would undercount). */
export function countWithSize(items: Array<{ size: number | null; isDir: boolean }>): string {
  const count = pluralize(items.length, "item");
  if (items.length === 0 || items.some((i) => i.isDir || i.size == null)) return count;
  const bytes = items.reduce((sum, i) => sum + (i.size ?? 0), 0);
  return `${count} (${formatBytes(bytes)})`;
}

/** Display name for a rule path: the folder's own name. */
export function ruleFolderName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "~" || trimmed === "") return "Home";
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** Multi-line hover text for a row's Cleanup cell. */
export function cleanupTooltip(
  item: CleanupItem,
  rule: { folder: string; days: number },
  now: number,
  /** Display form of the Keep shortcut ("⌥⌘K"); omitted when unbound. */
  keepShortcut?: string,
): string {
  const head =
    item.status === "kept"
      ? "Kept: auto-cleanup leaves this alone"
      : item.status === "excluded"
        ? "Excluded: nothing in this folder is touched"
        : item.status === "inProgress"
          ? "Still downloading: skipped"
          : item.expires != null && item.expires <= now
            ? "Moves to the Trash in the next sweep"
            : `Moves to the Trash ${expiryLabel(item.expires ?? now, now).text.toLowerCase()}`;
  const lines = [
    head,
    `Added: ${formatDateFull(item.added)}`,
    `Rule: ${ruleFolderName(rule.folder)}, ${pluralize(rule.days, "day")}`,
    `Last opened: ${item.lastUsed != null ? formatDateFull(item.lastUsed) : "Never"}`,
  ];
  if (keepShortcut && item.status === "scheduled") lines.push(`Press ${keepShortcut} to keep it.`);
  if (keepShortcut && item.status === "kept") lines.push(`Press ${keepShortcut} to stop keeping it.`);
  return lines.join("\n");
}
