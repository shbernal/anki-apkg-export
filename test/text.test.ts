import { createHash } from "crypto";
import { readFileSync } from "fs";

import { describe, expect, it } from "vitest";

import stripHtmlPreservingMediaFilenames from "../src/text.js";

interface StrippedFieldCase {
  input: string;
  sfld: string;
  csum: number;
}

/** `csum` is the first four bytes of the sha1, read big endian. */
const CHECKSUM_HEX_DIGITS = 8;

/** Guards against the fixture being silently emptied or truncated. */
const MINIMUM_CASES = 300;

/**
 * Every case is what Anki 26.8.1 itself stored: each `input` was written to the
 * first field of a note in a real collection, and the `sfld` / `csum` it
 * computed were read back out of the resulting collection.anki2. Regenerating
 * the fixture takes the reference implementation, so read a failure here as
 * this package drifting from Anki rather than as a fixture to refresh.
 */
const readCases = (): StrippedFieldCase[] => {
  const json: unknown = JSON.parse(
    readFileSync(new URL("fixtures/anki-stripped-fields.json", import.meta.url), "utf8"),
  );

  /* The fixture's shape is fixed by the oracle that writes it. */
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return json as StrippedFieldCase[];
};

const cases = readCases();

const fieldChecksum = (text: string): number =>
  Number.parseInt(createHash("sha1").update(text).digest("hex").slice(0, CHECKSUM_HEX_DIGITS), 16);

describe("html stripping", () => {
  it("covers the whole reference corpus", () => {
    expect.hasAssertions();
    expect(cases.length).toBeGreaterThanOrEqual(MINIMUM_CASES);
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
