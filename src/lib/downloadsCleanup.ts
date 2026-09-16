/** Shared cleanup presentation. All surfaces use the backend's deadline. */
export const CLEANUP_DAY = 86_400_000;
export interface CleanupConfig {
  enabled: boolean;
  retentionDays: number;
}
export interface CleanupItem {
  path: string;
  name: string;
  identity: string;
  size: number;
  modified: number;
  added: number;
  deadline: number | null;
  keep: boolean;
}
export interface CleanupHistory {
  id: string;
  original: string;
  trashed: string | null;
  at: number;
  restored: boolean;
  identity: string;
}
export interface CleanupSnapshot {
  config: CleanupConfig;
  root: string;
  items: CleanupItem[];
  history: CleanupHistory[];
  lastRun: number | null;
  error: string | null;
}
export interface CleanupPreview {
  token: string;
  snapshot: CleanupSnapshot;
}
export function cleanupWarningMs(days: number): number {
  return Math.min(days * CLEANUP_DAY * 0.2, 7 * CLEANUP_DAY);
}
export function cleanupLabel(item: CleanupItem, now: number): string {
  if (item.keep) return "Kept";
  if (item.deadline == null) return "Unscheduled";
  const left = item.deadline - now;
  if (left <= 0) return "Pending cleanup";
  if (left < 60_000) return "In <1 minute";
  if (left < 3_600_000) {
    const n = Math.ceil(left / 60_000);
    return `In ${n} minute${n === 1 ? "" : "s"}`;
  }
  if (left < CLEANUP_DAY) {
    const n = Math.ceil(left / 3_600_000);
    return `In ${n} hour${n === 1 ? "" : "s"}`;
  }
  const n = Math.ceil(left / CLEANUP_DAY);
  return `In ${n} day${n === 1 ? "" : "s"}`;
}
export function cleanupNear(
  item: CleanupItem,
  days: number,
  now: number,
): boolean {
  return (
    !item.keep &&
    item.deadline != null &&
    item.deadline - now <= cleanupWarningMs(days)
  );
}
export function cleanupTooltip(item: CleanupItem): string {
  return item.keep
    ? "Kept in Downloads. Exempt from automatic cleanup."
    : item.deadline == null
      ? "Cleanup date unavailable"
      : `Eligible to move to Trash on ${new Date(item.deadline).toLocaleString()}. Cleanup runs daily while Fazi is running. Right-click to Keep or extend retention.`;
}
