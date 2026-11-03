/**
 * Frontend perf harness (Node/V8 — not the app's JavaScriptCore).
 *
 *   npx vitest run --config scripts/bench/vitest.bench.config.ts
 *
 * Env: BENCH_IMPL=after|before (adapter for code paths that moved out of
 * components; default after), BENCH_OUT=<json path>.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["scripts/bench/**/*.bench-run.ts"],
    testTimeout: 30 * 60 * 1000,
    hookTimeout: 10 * 60 * 1000,
    pool: "forks",
  },
});
