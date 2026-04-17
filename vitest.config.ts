import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.{test,spec}.ts"],
    testTimeout: 20000,
    pool: "threads",
    threads: {
      singleThread: true,
    },
  },
});
