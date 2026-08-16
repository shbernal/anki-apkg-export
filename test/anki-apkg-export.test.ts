import { promises as fsp } from "fs";
import { DatabaseSync } from "node:sqlite";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AnkiExport from "../src/index.js";
import { buildFixtureDeck, FIXTURE_NOW } from "./_fixture-deck.js";
import { addCards, unzipDeckToDir } from "./_helpers.js";

const tmpDir = path.join(os.tmpdir(), "anki-apkg-export");
const dest = path.join(tmpDir, "result.apkg");
const destUnpacked = path.join(tmpDir, "unpacked_result");
const destUnpackedDb = path.join(destUnpacked, "collection.anki2");
const fixturePath = path.join(import.meta.dirname, "fixtures/output.apkg");
const SEPARATOR = "\u001F";

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

describe("anki-apkg-export", () => {
  beforeEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
    await fsp.mkdir(tmpDir, { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("equals to sample", async () => {
    expect.hasAssertions();
    vi.useFakeTimers({ now: FIXTURE_NOW, toFake: ["Date"] });

    const zip = await buildFixtureDeck(AnkiExport);
    expect(zip).toBeInstanceOf(Buffer);
    await expect(matchesFixture(zip)).resolves.toBe(true);
  });

  it("check internal structure", async () => {
    expect.hasAssertions();
    const apkg = await AnkiExport("deck-name");
    const cards = [
      { front: "card #1 front", back: "card #1 back" },
      { front: "card #2 front", back: "card #2 back" },
      {
        front: 'card #3 with image <img src="anki.png" />',
        back: "card #3 back",
      },
    ];
    addCards(apkg, cards);
    const zip = await apkg.save();
    await fsp.writeFile(dest, zip);

    await unzipDeckToDir(dest, destUnpacked);
    const result = readRows(
      destUnpackedDb,
      `SELECT
        notes.flds as fields,
        notes.sfld as sortField
        from cards JOIN notes where cards.nid = notes.id ORDER BY cards.id`,
    );

    /* Both sides of a note live in `flds`; `sfld` is a stripped copy of the
       first one, so the round trip has to be read out of `flds`. */
    const normalizedResult = result
      .map(({ fields }: Readonly<Record<string, string>>) => {
        /* `flds` always holds both sides joined by the separator, so the split
           has exactly two parts; the defaults keep that promise typed rather
           than letting an `undefined` reach an assertion. */
        const [front = "", back = ""] = String(fields).split(SEPARATOR);
        return { front, back };
      })
      .sort((left: Readonly<{ front: string }>, right: Readonly<{ front: string }>) =>
        left.front.localeCompare(right.front),
      );

    expect(normalizedResult).toStrictEqual(cards);

    /* The sort field drops the img tag and keeps the filename, the way Anki
       would write it: one space either side of the name it recovered. */
    expect(
      result.map(({ sortField }: Readonly<Record<string, string>>) => sortField),
    ).toStrictEqual(["card #1 front", "card #2 front", "card #3 with image  anki.png "]);
  });

  it("check internal structure on adding card with tags", async () => {
    expect.hasAssertions();
    const decFile = `${dest}_with_tags.apkg`;
    const unzippedDeck = `${destUnpacked}_with_tags`;
    const apkg = await AnkiExport("deck-name");
    const [front1, back1, tags1] = [
      "Card front side 1",
      "Card back side 1",
      ["some", "tag", "tags with multiple words"],
    ];
    const [front2, back2, tags2] = ["Card front side 2", "Card back side 2", "some strin_tags"];
    const [front3, back3] = ["Card front side 3", "Card back side 3"];
    apkg.addCard(front1, back1, { tags: tags1 });
    apkg.addCard(front2, back2, { tags: tags2 });
    apkg.addCard(front3, back3);

    const zip = await apkg.save();
    await fsp.writeFile(decFile, zip);

    await unzipDeckToDir(decFile, unzippedDeck);
    const results = readRows(
      `${unzippedDeck}/collection.anki2`,
      `SELECT
        notes.sfld as front,
        notes.flds as back,
        notes.tags as tags
        from cards JOIN notes where cards.nid = notes.id ORDER BY front`,
    );

    expect(results).toStrictEqual([
      {
        front: front1,
        back: `${front1}${SEPARATOR}${back1}`,
        tags: ` ${tags1.map((tag) => tag.replaceAll(" ", "_")).join(" ")} `,
      },
      { front: front2, back: `${front2}${SEPARATOR}${back2}`, tags: tags2 },
      { front: front3, back: `${front3}${SEPARATOR}${back3}`, tags: "" },
    ]);
  });
});
