// Merge before/after harness outputs into the report JSON.
//   node scripts/bench/combine.mjs <before.json> <after.json> <out.json>
import { readFileSync, writeFileSync } from "node:fs";

const [beforePath, afterPath, outPath] = process.argv.slice(2);
const before = JSON.parse(readFileSync(beforePath, "utf8"));
const after = JSON.parse(readFileSync(afterPath, "utf8"));
const byName = new Map(before.results.map((r) => [r.name, r]));

const results = after.results
  .filter((r) => byName.has(r.name))
  .map((r) => {
    const b = byName.get(r.name);
    return {
      name: r.name,
      unit: "ms",
      before: Number(b.median.toPrecision(4)),
      after: Number(r.median.toPrecision(4)),
      lowerIsBetter: true,
      note: `${r.note}. Median of ${b.iterations} (before) / ${r.iterations} (after) runs; ${after.engine} via vitest+jsdom, not JavaScriptCore.`,
    };
  });

writeFileSync(outPath, JSON.stringify({ area: "frontend", results }, null, 2));
for (const r of results) {
  const x = r.after > 0 ? (r.before / r.after).toFixed(1) : "∞";
  console.log(`${r.name.padEnd(56)} ${String(r.before).padStart(10)} ${String(r.after).padStart(10)}  ${x}x`);
}
