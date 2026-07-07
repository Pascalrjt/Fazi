/** Small pure formatting helpers used across the UI. */

const UNITS = ["bytes", "KB", "MB", "GB", "TB", "PB"];

/** Finder-style byte formatting (base 1000, one decimal above KB). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes === 0) return "Zero bytes";
  if (bytes === 1) return "1 byte";
  if (bytes < 1000) return `${bytes} bytes`;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** Compact rate for op cards: "312 MB/s". */
export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(Math.round(bytesPerSec))}/s`;
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 5) return "a few seconds left";
  if (seconds < 60) return `about ${Math.round(seconds)} seconds left`;
  const min = Math.round(seconds / 60);
  if (min < 60) return `about ${min} minute${min === 1 ? "" : "s"} left`;
  const h = Math.floor(min / 60);
  return `about ${h} hour${h === 1 ? "" : "s"} left`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});
const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

/** Finder-style modified date: "Today at 3:14 PM", "Yesterday at …", else "Jan 4, 2026". */
export function formatDate(epochMs: number | null | undefined): string {
  if (epochMs == null) return "—";
  const d = new Date(epochMs);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  if (epochMs >= startOfToday) return `Today at ${timeFmt.format(d)}`;
  if (epochMs >= startOfYesterday) return `Yesterday at ${timeFmt.format(d)}`;
  return dateFmt.format(d);
}

export function formatDateFull(epochMs: number | null | undefined): string {
  if (epochMs == null) return "—";
  const d = new Date(epochMs);
  return `${dateFmt.format(d)} at ${timeFmt.format(d)}`;
}

/** Last path component ("" for "/"). */
export function basename(path: string): string {
  if (path === "/") return "/";
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** Parent directory path (null at root). */
export function dirname(path: string): string | null {
  if (path === "/" || path === "") return null;
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

export function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

/** Split a filename into [stem, extension-with-dot]. Dirs/dotfiles keep whole name as stem. */
export function splitExt(name: string): [string, string] {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return [name, ""];
  return [name.slice(0, idx), name.slice(idx)];
}

/** Breadcrumb segments for a path: [{ name, path }, …] starting at "/". */
export function pathSegments(path: string): { name: string; path: string }[] {
  if (path === "/") return [{ name: "Macintosh HD", path: "/" }];
  const parts = path.split("/").filter(Boolean);
  const segs: { name: string; path: string }[] = [];
  let acc = "";
  for (const part of parts) {
    acc += `/${part}`;
    segs.push({ name: part, path: acc });
  }
  return segs;
}

export function pluralize(n: number, singular: string, plural?: string): string {
  return n === 1 ? `1 ${singular}` : `${n} ${plural ?? `${singular}s`}`;
}

/** Home-relative display for subtitles: "~/Documents/Projects". */
export function displayPath(path: string, home: string | null): string {
  if (home && path.startsWith(home)) {
    const rest = path.slice(home.length);
    return rest === "" ? "~" : `~${rest}`;
  }
  return path;
}
