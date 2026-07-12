/**
 * Pure batch-rename spec engine: regex find/replace (capture groups),
 * prefix/suffix, and sequential numbering — the modal previews exactly what
 * the backend will apply.
 */
import { splitExt } from "./format";

export interface NumberingSpec {
  start: number;
  step: number;
  /** Zero-pad to this many digits. */
  digits: number;
  position: "prefix" | "suffix";
}

export interface BatchRenameSpec {
  /** Regex source; invalid patterns leave names untouched. */
  find?: string;
  /** Replacement, $1-style capture groups supported. */
  replace?: string;
  caseInsensitive?: boolean;
  prefix?: string;
  /** Inserted before the extension. */
  suffix?: string;
  numbering?: NumberingSpec;
}

/** Compile the find pattern, or null when absent/invalid. */
export function compileFind(spec: BatchRenameSpec): RegExp | null {
  if (!spec.find) return null;
  try {
    return new RegExp(spec.find, spec.caseInsensitive ? "gi" : "g");
  } catch {
    return null;
  }
}

function pad(n: number, digits: number): string {
  const s = String(Math.abs(n));
  const padded = s.length >= digits ? s : "0".repeat(digits - s.length) + s;
  return n < 0 ? `-${padded}` : padded;
}

/**
 * Apply the spec to every name (order matters — numbering follows the given
 * order). Pipeline per name: find/replace → prefix/suffix → numbering.
 * Extensions are preserved: suffix and numbering insert before the extension.
 */
export function applyBatchRename(names: string[], spec: BatchRenameSpec): string[] {
  const find = compileFind(spec);
  return names.map((name, i) => {
    let [stem, ext] = splitExt(name);
    if (find && spec.replace != null) {
      find.lastIndex = 0;
      stem = stem.replace(find, spec.replace);
    }
    if (spec.prefix) stem = spec.prefix + stem;
    if (spec.suffix) stem = stem + spec.suffix;
    if (spec.numbering) {
      const { start, step, digits, position } = spec.numbering;
      const n = pad(start + i * step, Math.max(1, digits));
      stem = position === "prefix" ? `${n} ${stem}` : `${stem} ${n}`;
    }
    return stem + ext;
  });
}

/**
 * The one frontend copy of the backend's `validate_name` rule set
 * (src-tauri/src/core/batch_rename.rs): empty, "/", ":" (Finder displays it
 * as "/"), NUL, "." and "..". Returns the user-facing error, or null when
 * the name is legal.
 */
export function nameRuleError(name: string): string | null {
  if (name.length === 0) return "Name can't be empty";
  if (name.includes("/")) return "Name can't contain “/”";
  if (name.includes(":")) return "Name can't contain “:”";
  if (name.includes("\0") || name === "." || name === "..") return "Invalid name";
  return null;
}

/**
 * Collision classes for the preview table: rows whose target duplicates
 * another target (case-insensitive) or collides with a sibling that is not
 * part of the batch.
 */
export function batchCollisions(
  fromNames: string[],
  toNames: string[],
  siblingNames: string[],
): boolean[] {
  const fromLower = new Set(fromNames.map((n) => n.toLowerCase()));
  const counts = new Map<string, number>();
  for (const t of toNames) {
    const k = t.toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const siblingsLower = new Set(
    siblingNames.map((n) => n.toLowerCase()).filter((n) => !fromLower.has(n)),
  );
  return toNames.map((t) => {
    const k = t.toLowerCase();
    if ((counts.get(k) ?? 0) > 1) return true;
    return siblingsLower.has(k);
  });
}
