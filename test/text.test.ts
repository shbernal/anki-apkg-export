import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import NAMED_ENTITIES from "../src/html-entities.js";
import stripHtmlPreservingMediaFilenames from "../src/text.js";

interface StrippedFieldCase {
  input: string;
  sfld: string;
  csum: number;
}

interface StrippedFieldFixture {
  ankiVersion: string;
  generator: string;
  cases: StrippedFieldCase[];
}

/** `csum` is the first four bytes of the sha1, read big endian. */
const CHECKSUM_HEX_DIGITS = 8;

/** The HTML 4 set the `htmlescape` crate carries, which is what Anki decodes. */
const NAMED_ENTITY_COUNT = 252;

/** Names that a lookup through `Object.prototype` would answer for. */
const INHERITED_NAMES = ["constructor", "__proto__", "toString", "hasOwnProperty"];

/** Guards against the fixture being silently emptied or truncated. */
const MINIMUM_CASES = 300;

/** Enough segments that the old pattern would not have finished this century. */
const QUOTED_SEGMENTS = 40;
const BACKTRACKING_BUDGET_MS = 1000;

/**
 * Every case is what Anki itself stored: `tools/oracle/gen_stripped_fields.py`
 * writes each `input` into the first field of a note in a real collection and
 * reads the `sfld` / `csum` it computed back out of the resulting
 * collection.anki2. `ankiVersion` records the release that produced the file.
 *
 * Regenerating takes the reference implementation, so read a failure here as
 * this package drifting from Anki rather than as a fixture to refresh:
 *
 *     uv run tools/oracle/gen_stripped_fields.py
 */
const readFixture = (): StrippedFieldFixture => {
  const json: unknown = JSON.parse(
    readFileSync(new URL("fixtures/anki-stripped-fields.json", import.meta.url), "utf8"),
  );

  /* The fixture's shape is fixed by the oracle that writes it. */
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return json as StrippedFieldFixture;
};

const fixture = readFixture();
const { cases } = fixture;

const fieldChecksum = (text: string): number =>
  Number.parseInt(createHash("sha1").update(text).digest("hex").slice(0, CHECKSUM_HEX_DIGITS), 16);

describe("html stripping", () => {
  it("covers the whole reference corpus", () => {
    expect.hasAssertions();
    expect(cases.length).toBeGreaterThanOrEqual(MINIMUM_CASES);
  });

  it("records the anki release that produced the fixture", () => {
    expect.hasAssertions();
    expect(fixture.ankiVersion).toMatch(/^\d+\.\d+/u);
  });

  /**
   * `<img ` followed by quoted segments and no `src` at all is the shape the
   * media pattern used to read exponentially: thirty-two characters of it took
   * forty seconds, because `[^>]` matches a quote too and every segment could
   * be consumed either way. The budget is loose on purpose. The work is now
   * sub-millisecond, and a tight bound would trade a regression test for a
   * flaky one.
   */
  it("strips a run of quoted segments without backtracking", () => {
    expect.hasAssertions();
    const hostile = `<img ${'"a"'.repeat(QUOTED_SEGMENTS)}`;

    const started = performance.now();
    const stripped = stripHtmlPreservingMediaFilenames(hostile);
    const elapsed = performance.now() - started;

    /* No `>` and no media value, so nothing is stripped at all. */
    expect(stripped).toBe(hostile);
    expect(elapsed).toBeLessThan(BACKTRACKING_BUDGET_MS);
  });

  it.each(cases)(
    "matches Anki for $input",
    ({ input, sfld, csum }: Readonly<StrippedFieldCase>) => {
      expect.hasAssertions();
      const stripped = stripHtmlPreservingMediaFilenames(input);

      expect(stripped).toBe(sfld);
      expect(fieldChecksum(stripped)).toBe(csum);
    },
  );
});

describe("the named entity table", () => {
  it("carries the whole HTML 4 set and nothing beyond it", () => {
    expect.hasAssertions();

    /* The count Anki's decoder works from; HTML 5's set is 2231 names. */
    expect(NAMED_ENTITIES.size).toBe(NAMED_ENTITY_COUNT);
  });

  it.each(INHERITED_NAMES)("leaves &%s; undecoded", (name: string) => {
    expect.hasAssertions();

    /* Why the table is a Map: a bare object literal would resolve these
       through `Object.prototype` and decode them into something. Anki has no
       reason to emit them, so the corpus does not cover them. */
    expect(stripHtmlPreservingMediaFilenames(`&${name};`)).toBe(`&${name};`);
  });
});
