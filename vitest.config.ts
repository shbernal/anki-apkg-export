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
    },
  },
});
