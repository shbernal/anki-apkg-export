import fs, { promises as fsp } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";

import sqlite3 from "sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AnkiExport from "../src/index.js";
import { addCards, unzipDeckToDir } from "./_helpers.js";

interface SqliteDb {
  all: (query: string, callback: (error: Error | null, rows: readonly unknown[]) => void) => void;
  close: (callback: (error: Error | null) => void) => void;
}

const tmpDir = path.join(os.tmpdir(), "anki-apkg-export");
const dest = path.join(tmpDir, "result.apkg");
const destUnpacked = path.join(tmpDir, "unpacked_result");
const destUnpackedDb = path.join(destUnpacked, "collection.anki2");
const SEPARATOR = "\u001F";
type SqliteDatabaseConstructor = new (
  filename: string,
  mode?: number,
  callback?: (err?: Error | null) => void,
) => SqliteDb;
const SQLiteDatabase: SqliteDatabaseConstructor = sqlite3.Database;

const queryAll = async (
  db: Readonly<SqliteDb>,
  query: string,
): Promise<Record<string, string>[]> => {
  const rows = await promisify<string, readonly unknown[]>(db.all.bind(db))(query);

  /* The column list is written in the query, so only the caller knows the shape. */
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return rows as Record<string, string>[];
};

/**
 * Closing happens on the libuv threadpool, and sqlite3's completion callback
 * throws through N-API. Left unawaited, that callback can land after vitest has
 * torn the worker down, aborting the process with a fatal napi_throw.
 */
const closeDb = async (db: Readonly<SqliteDb>): Promise<void> => {
  await promisify(db.close.bind(db))();
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
    const now = 1_482_680_798_652;
    vi.useFakeTimers({ now, toFake: ["Date"] });

    const apkg = await AnkiExport("deck-name");

    apkg.addMedia("anki.png", fs.readFileSync(path.join(import.meta.dirname, "fixtures/anki.png")));

    apkg.addCard("card #1 front", "card #1 back", { tags: ["food", "fruit"] });
    apkg.addCard("card #2 front", "card #2 back");
    apkg.addCard('card #3 with image <img src="anki.png" />', "card #3 back");

    const zip = await apkg.save();
    await fsp.writeFile(dest, zip);

    expect(zip).toBeInstanceOf(Buffer);

    const sampleZip = await fsp.readFile(path.join(import.meta.dirname, "fixtures/output.apkg"));
    const destZip = await fsp.readFile(dest);
    expect(destZip.equals(sampleZip)).toBe(true);
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
    const db = new SQLiteDatabase(destUnpackedDb);
    const result = await queryAll(
      db,
      `SELECT
        notes.sfld as front,
        notes.flds as back
        from cards JOIN notes where cards.nid = notes.id ORDER BY cards.id`,
    );
    await closeDb(db);

    const normalizedResult = result
      .map(({ front, back }: Readonly<Record<string, string>>) => ({
        front,
        back: back.split(SEPARATOR).pop()!,
      }))
      .sort((left: Readonly<{ front: string }>, right: Readonly<{ front: string }>) =>
        left.front.localeCompare(right.front),
      );

    expect(normalizedResult).toStrictEqual(cards);
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
    const db = new SQLiteDatabase(`${unzippedDeck}/collection.anki2`);
    const results = await queryAll(
      db,
      `SELECT
        notes.sfld as front,
        notes.flds as back,
        notes.tags as tags
        from cards JOIN notes where cards.nid = notes.id ORDER BY front`,
    );
    await closeDb(db);

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
