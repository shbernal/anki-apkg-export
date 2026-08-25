import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AnkiExport from "../src/index.js";
import { buildFixtureDeck, FIXTURE_CARDS, FIXTURE_NOW } from "./_fixture-deck.js";
import { addCards, unzipDeckToDir } from "./_helpers.js";

const tmpDir = path.join(os.tmpdir(), "anki-apkg-export");
const dest = path.join(tmpDir, "result.apkg");
const destUnpacked = path.join(tmpDir, "unpacked_result");
const destUnpackedDb = path.join(destUnpacked, "collection.anki2");
const fixturePath = path.join(import.meta.dirname, "fixtures/output.apkg");
const SEPARATOR = "\u001F";

interface Card {
  front: string;
  back: string;
}

/**
 * The fixture deck's cards without their tags. This suite adds `TAGGED` below
 * for the `tags` column, so restating the fronts and backs here would give the
 * golden fixture and the test guarding it two definitions that can drift.
 */
const CARDS: readonly Readonly<Card>[] = FIXTURE_CARDS.map(
  ({ front, back }: Readonly<{ front: string; back: string }>) => ({ front, back }),
);

/**
 * One tagged card, so the round trip covers the `tags` column too. How the tag
 * string is built is `test/exporter.test.ts`'s subject; the only question here
 * is whether it survives save, zip, unzip, and a different SQLite build.
 */
const TAGGED = {
  front: "card #4 front",
  back: "card #4 back",
  tags: ["some", "tag", "tags with multiple words"],
} as const;

const EXPECTED_TAGS = " some tag tags_with_multiple_words ";

/**
 * A deck whose name, fields and tag are all non-ASCII. Both the guid and the
 * stored fields are UTF-8 bytes, and Anki hashes the same ones, so an encoding
 * that changed anywhere on the way through would land here.
 */
const UNICODE = {
  deckName: "café — 日本語",
  front: "こんにちは <b>世界</b>",
  back: "Grüße, Ωμέγα",
  tag: "日本語",
} as const;

/**
 * Reads back a deck the exporter just wrote, through a SQLite build other than
 * the one that produced it.
 *
 * `node:sqlite` returns null-prototype rows, and `toStrictEqual` counts those as
 * a different type from an object literal, so the rows are cloned into ordinary
 * objects before they reach an assertion.
 */
const readRows = (dbPath: string, query: string): Record<string, string>[] => {
  const db = new DatabaseSync(dbPath, { readOnly: true });

  try {
    /* The column list is written in the query, so only the caller knows the shape. */
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const rows = db.prepare(query).all() as Record<string, string>[];

    return structuredClone(rows);
  } finally {
    db.close();
  }
};

/**
 * Every field the exporter writes ends up in these bytes, so comparing them is
 * what catches an unintended change to the emitted deck.
 *
 * `pnpm run fixture:regen` adopts an intended change by rerunning this file
 * with UPDATE_FIXTURE set, which writes the deck just built back over the
 * fixture and reports a match. Regenerating through the same definition the
 * assertion uses is what stops the two from drifting apart.
 */
const matchesFixture = async (zip: Readonly<Buffer>): Promise<boolean> => {
  if (process.env.UPDATE_FIXTURE !== undefined) {
    await fsp.writeFile(fixturePath, zip);
    return true;
  }

  return zip.equals(await fsp.readFile(fixturePath));
};

describe("a deck read back through node:sqlite", () => {
  beforeEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
    await fsp.mkdir(tmpDir, { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("is byte-identical to the committed fixture", async () => {
    expect.hasAssertions();
    vi.useFakeTimers({ now: FIXTURE_NOW, toFake: ["Date"] });

    const zip = await buildFixtureDeck(AnkiExport);
    expect(zip).toBeInstanceOf(Buffer);
    await expect(matchesFixture(zip)).resolves.toBe(true);
  });

  it("carries back the fields, sort fields and tags it was given", async () => {
    expect.hasAssertions();
    const apkg = await AnkiExport("deck-name");
    addCards(apkg, CARDS);
    apkg.addCard(TAGGED.front, TAGGED.back, { tags: TAGGED.tags });

    const zip = await apkg.save();
    await fsp.writeFile(dest, zip);

    await unzipDeckToDir(dest, destUnpacked);
    const result = readRows(
      destUnpackedDb,
      `SELECT
        notes.flds as fields,
        notes.sfld as sortField,
        notes.tags as tags
        from cards JOIN notes where cards.nid = notes.id ORDER BY cards.id`,
    );

    /* Both sides of a note live in `flds`; `sfld` is a stripped copy of the
       first one, so the round trip has to be read out of `flds`. */
    const roundTripped = result.map(({ fields }: Readonly<Record<string, string>>) => {
      /* `flds` always holds both sides joined by the separator, so the split
         has exactly two parts; the defaults keep that promise typed rather
         than letting an `undefined` reach an assertion. */
      const [front = "", back = ""] = String(fields).split(SEPARATOR);
      return { front, back };
    });

    expect(roundTripped).toStrictEqual([...CARDS, { front: TAGGED.front, back: TAGGED.back }]);

    /* The sort field drops the img tag and keeps the filename, the way Anki
       would write it: one space either side of the name it recovered. */
    expect(
      result.map(({ sortField }: Readonly<Record<string, string>>) => sortField),
    ).toStrictEqual([
      "card #1 front",
      "card #2 front",
      "card #3 with image  anki.png ",
      TAGGED.front,
    ]);

    /* Untagged cards store the empty string, not null: the column is NOT NULL. */
    expect(result.map(({ tags }: Readonly<Record<string, string>>) => tags)).toStrictEqual([
      "",
      "",
      "",
      EXPECTED_TAGS,
    ]);
  });

  it("carries non-ASCII fields, sort fields and tags through unchanged", async () => {
    expect.hasAssertions();
    const apkg = await AnkiExport(UNICODE.deckName);
    apkg.addCard(UNICODE.front, UNICODE.back, { tags: [UNICODE.tag] });

    await fsp.writeFile(dest, await apkg.save());
    await unzipDeckToDir(dest, destUnpacked);

    /* Read back through node:sqlite — a different SQLite build from the one
       that wrote the file, so a mismatch in how the text was encoded shows up
       here rather than being masked by a symmetric bug. */
    const [row] = readRows(
      destUnpackedDb,
      "SELECT flds as fields, sfld as sortField, tags from notes",
    );

    expect(row).toStrictEqual({
      fields: UNICODE.front + SEPARATOR + UNICODE.back,

      /* `<b>` goes, the text around it stays. */
      sortField: "こんにちは 世界",
      tags: ` ${UNICODE.tag} `,
    });
  });
});
