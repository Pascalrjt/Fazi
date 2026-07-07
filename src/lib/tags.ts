/** Finder label colors 1–7 (0 = none). */
export const FINDER_TAG_COLORS: Record<number, { name: string; css: string }> = {
  1: { name: "Gray", css: "#8e8e93" },
  2: { name: "Green", css: "#61c554" },
  3: { name: "Purple", css: "#b57bd8" },
  4: { name: "Blue", css: "#3f9bf4" },
  5: { name: "Yellow", css: "#f7ce46" },
  6: { name: "Red", css: "#ec5f5f" },
  7: { name: "Orange", css: "#f2a33c" },
};

export function tagCss(color: number): string {
  return FINDER_TAG_COLORS[color]?.css ?? "transparent";
}
