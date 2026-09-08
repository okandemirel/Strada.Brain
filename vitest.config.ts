import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    clearMocks: true,
    // Native addons and long-running integration suites are more stable in forked workers.
    pool: "forks",
    // Every worker inherits TMPDIR from here; the run's temp files go in one
    // root that the teardown removes (see vitest.global-setup.ts).
    globalSetup: ["./vitest.global-setup.ts"],
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    benchmark: {
      include: ["benchmarks/**/*.bench.ts"],
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
    },
    testTimeout: 30_000,
    hookTimeout: 15_000,
  },
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
    },
  },
});
