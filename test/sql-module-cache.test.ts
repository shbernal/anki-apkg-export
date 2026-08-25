import type { InitSqlJsStatic, SqlJsStatic } from "sql.js";
import { describe, expect, it, vi } from "vitest";

import AnkiExport from "../src/index.js";

/*
 * The only test in this package that mocks sql.js, and the reason it has a
 * file of its own: the memoized module lives at `src/index.ts`'s module scope,
 * so reaching a failed load means failing `initSqlJs` itself. Kept apart from
 * `test/index.test.ts` so the mock cannot leak into the cases that assert
 * against the real WASM module — including the one pinning that a successful
 * load is shared across calls.
 */
vi.mock(import("sql.js"), () => {
  /* The mock never reads the config it is handed, so it does not restate it. */
  const init = vi.fn<() => Promise<SqlJsStatic>>();

  /* The package publishes the CJS interop shape, where the initializer also
     carries itself as `default`. That type is recursive, so no mock literal
     spells it and the built shape is asserted instead. */
  const module = { default: Object.assign(init, { default: init }) };

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return module as unknown as { default: InitSqlJsStatic };
});

const { default: initSqlJs } = await import("sql.js");

/** How many loads a failure followed by a retry should have attempted. */
const ATTEMPTS_AFTER_ONE_RETRY = 2;

describe("the sql.js module cache", () => {
  it("retries the load after a failed initialization", async () => {
    expect.hasAssertions();
    const init = vi.mocked(initSqlJs);

    init.mockRejectedValueOnce(new Error("first failure"));
    init.mockRejectedValueOnce(new Error("second failure"));

    await expect(AnkiExport("deck-name")).rejects.toThrow("first failure");

    /* Reaching the second error at all is the claim: a rejected promise left
       in the memo would answer this call with the first one's error and never
       call `initSqlJs` again. */
    await expect(AnkiExport("deck-name")).rejects.toThrow("second failure");
    expect(init).toHaveBeenCalledTimes(ATTEMPTS_AFTER_ONE_RETRY);
  });
});
