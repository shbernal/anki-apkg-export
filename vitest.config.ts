import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.{test,spec}.ts"],
    testTimeout: 20_000,
    /*
     * Not the Vitest 4 default, which is `forks`. Threads are cheaper to start
     * and nothing here needs process isolation: the only shared resource is one
     * `os.tmpdir()` directory, and a single test file touches it.
     */
    pool: "threads",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "lcov"],
      reportsDirectory: "coverage",
      /*
       * A floor, not a target: the suite is at 100% on all four counters, and
       * this is what keeps a new branch from quietly landing uncovered. It
       * binds `test:coverage` rather than `pnpm test`, so the gate CI runs
       * stays the fast one.
       */
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
