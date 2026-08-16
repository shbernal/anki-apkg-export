import path from "path";

import initSqlJs, { type SqlJsStatic } from "sql.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import Exporter from "../src/exporter.js";
import createTemplate from "../src/template.js";
import { unzipDeckToBuffers } from "./_helpers.js";

const template = createTemplate();
const now = 1_700_000_000_000;
const locateFile = (file: string): string =>
  path.join(import.meta.dirname, "../node_modules/sql.js/dist", file);
let sqlModule: SqlJsStatic;

/** Every sqlite file opens with this magic string. */
const SQLITE_HEADER = "SQLite format 3";

/** A ZIP local file header stores its DOS timestamp four bytes in at offset 10. */
const MTIME_OFFSET = 10;

/* Field offsets within that packed DOS timestamp. */
const DOS_EPOCH_YEAR = 1980;
const YEAR_SHIFT = 25;
const MONTH_SHIFT = 21;
const DAY_SHIFT = 16;
const HOUR_SHIFT = 11;
const MINUTE_SHIFT = 5;
const SECOND_SHIFT = 1;

/** `addCard` writes one note row and one card row. */
const WRITES_PER_CARD = 2;

/** Row ids are epoch milliseconds; `mod` columns are epoch seconds. */
const MILLISECONDS_PER_SECOND = 1000;

/** How many times the duplicate-handling test adds the same card. */
const DUPLICATE_ADDS = 2;

/** Enough repetition that deflate beats stored, so `level: 0` is observable. */
const PADDING = 500;

/** Fronts for the queue-position test; only how many there are matters. */
const QUEUED_CARDS = ["front 1", "front 2", "front 3"];

/** Decode the collection's `conf` JSON column straight out of the live db. */
const readCollectionConf = (target: Readonly<Exporter>): unknown => {
  const [result] = target.db.exec("select conf from col");
  return JSON.parse(String(result?.values[0]?.[0]));
};

/**
 * `_update` is protected, so spying on it needs one cast at this boundary
 * rather than at every call site.
 */
const spyOnUpdate = (target: Readonly<Exporter>) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  vi.spyOn(target as unknown as { _update: Exporter["_update"] }, "_update");

describe("the exporter internals", () => {
  let exporter: Exporter;

  beforeAll(async () => {
    sqlModule = await initSqlJs({ locateFile });
  });

  beforeEach(() => {
    vi.useFakeTimers({ now, toFake: ["Date"] });
    exporter = new Exporter("testDeckName", {
      template,
      sql: sqlModule,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("builds a zip holding the database and the media", async () => {
    expect.hasAssertions();
    const dbExportSpy = vi.spyOn(exporter.db, "export");

    exporter.addMedia("1.jpg", Buffer.from("one"));
    exporter.addMedia("2.bmp", Buffer.from("two"));
    const files = unzipDeckToBuffers(await exporter.save());

    expect(dbExportSpy).toHaveBeenCalledWith();
    expect([...files.keys()].sort()).toStrictEqual(["0", "1", "collection.anki2", "media"]);
    expect(files.get("collection.anki2")?.subarray(0, SQLITE_HEADER.length).toString()).toBe(
      SQLITE_HEADER,
    );
    expect(JSON.parse(files.get("media")!.toString())).toStrictEqual({
      0: "1.jpg",
      1: "2.bmp",
    });
    expect(files.get("0")?.toString()).toBe("one");
    expect(files.get("1")?.toString()).toBe("two");
  });

  it("stamps entries with the creation date in UTC", async () => {
    expect.hasAssertions();
    exporter.addMedia("1.jpg", Buffer.from("one"));
    const archive = await exporter.save();

    /*
     * Pinning the DOS timestamp to the exporter's creation date in UTC is what
     * keeps saves reproducible regardless of the machine's timezone.
     */
    const created = new Date(now);
    const expected =
      (((created.getUTCFullYear() - DOS_EPOCH_YEAR) << YEAR_SHIFT) |
        ((created.getUTCMonth() + 1) << MONTH_SHIFT) |
        (created.getUTCDate() << DAY_SHIFT) |
        (created.getUTCHours() << HOUR_SHIFT) |
        (created.getUTCMinutes() << MINUTE_SHIFT) |
        (created.getUTCSeconds() >> SECOND_SHIFT)) >>>
      0;

    expect(archive.readUInt32LE(MTIME_OFFSET)).toBe(expected);
  });

  it("accepts fflate zip options", async () => {
    expect.hasAssertions();
    exporter.addMedia("1.jpg", Buffer.from("one".repeat(PADDING)));

    const compressed = await exporter.save();
    const stored = await exporter.save({ level: 0 });

    expect(stored.byteLength).toBeGreaterThan(compressed.byteLength);
    expect(unzipDeckToBuffers(stored).get("0")?.toString()).toBe("one".repeat(PADDING));
  });

  it("populates note and card rows when a card is added", () => {
    expect.hasAssertions();
    const { topDeckId, topModelId, separator } = exporter;
    const [front, back] = ["Test Front", "Test back"];
    const exporterUpdateSpy = spyOnUpdate(exporter);

    exporter.addCard(front, back);

    expect(exporterUpdateSpy).toHaveBeenCalledTimes(WRITES_PER_CARD);

    const [notesCall, cardsCall] = exporterUpdateSpy.mock.calls;

    expect(notesCall?.[0]).toBe(
      "insert or replace into notes values(:id,:guid,:mid,:mod,:usn,:tags,:flds,:sfld,:csum,:flags,:data)",
    );
    const notesUpdate = notesCall?.[1];
    expect(notesUpdate[":sfld"]).toBe(front);
    expect(notesUpdate[":flds"]).toBe(front + separator + back);
    expect(notesUpdate[":mid"]).toBe(topModelId);

    expect(cardsCall?.[0]).toBe(
      "insert or replace into cards values(:id,:nid,:did,:ord,:mod,:usn,:type,:queue,:due,:ivl,:factor,:reps,:lapses,:left,:odue,:odid,:flags,:data)",
    );
    const cardsUpdate = cardsCall?.[1];
    expect(cardsUpdate[":did"]).toBe(topDeckId);
    expect(cardsUpdate[":nid"]).toBe(notesUpdate[":id"]);
  });

  it("writes ids in milliseconds and mod times in seconds", () => {
    expect.hasAssertions();
    const exporterUpdateSpy = spyOnUpdate(exporter);

    exporter.addCard("Test Front", "Test back");

    const [notesCall, cardsCall] = exporterUpdateSpy.mock.calls;

    /* Anki keeps an imported row's `mod` as given. Milliseconds in a column
       read as seconds date the row to roughly the year 58,600, and nothing on
       the import path corrects it — unlike `sfld` and `csum`. */
    expect(notesCall?.[1][":mod"]).toBe(Math.floor(now / MILLISECONDS_PER_SECOND));
    expect(cardsCall?.[1][":mod"]).toBe(Math.floor(now / MILLISECONDS_PER_SECOND));

    expect(notesCall?.[1][":id"]).toBe(now);
    expect(cardsCall?.[1][":id"]).toBe(now);
  });

  it("gives each new card the next position in the queue", async () => {
    expect.hasAssertions();
    const exporterUpdateSpy = spyOnUpdate(exporter);

    QUEUED_CARDS.forEach((front: string) => {
      exporter.addCard(front, "back");
    });

    const positions = exporterUpdateSpy.mock.calls
      .filter(([query]: readonly [string, unknown]) => query.includes("into cards"))
      .map(
        ([, values]: readonly [string, Readonly<Record<string, string | number>>]) =>
          values[":due"],
      );

    /* Anki counts new cards up from 1, rather than giving every card the same
       hardcoded position. */
    expect(positions).toStrictEqual(QUEUED_CARDS.map((_front: string, index: number) => index + 1));

    /* `nextPos` has to end past the last position handed out, or the next card
       a user adds in Anki lands on top of one of these. */
    exporterUpdateSpy.mockRestore();
    await exporter.save();

    expect(readCollectionConf(exporter)).toMatchObject({ nextPos: QUEUED_CARDS.length + 1 });
  });

  it("joins a tag array into Anki's space-delimited form", () => {
    expect.hasAssertions();
    const { topModelId, separator } = exporter;
    const [front, back] = ["Test Front", "Test back"];
    const tags = ["tag1", "tag2", "multiple words tag"];
    const exporterUpdateSpy = spyOnUpdate(exporter);

    exporter.addCard(front, back, { tags });

    expect(exporterUpdateSpy).toHaveBeenCalledTimes(WRITES_PER_CARD);

    const [notesCall] = exporterUpdateSpy.mock.calls;
    const notesUpdate = notesCall?.[1];
    const notesTags = String(notesUpdate[":tags"]).split(" ");
    expect(notesUpdate[":sfld"]).toBe(front);
    expect(notesUpdate[":flds"]).toBe(front + separator + back);
    expect(notesUpdate[":mid"]).toBe(topModelId);
    expect(notesTags).toStrictEqual(["", ...tags.map((tag) => tag.replaceAll(" ", "_")), ""]);
  });

  it("passes a tag string through untouched", () => {
    expect.hasAssertions();
    const { topDeckId, topModelId, separator } = exporter;
    const [front, back, tags] = ["Test Front", "Test back", "Some string with_delimiters"];
    const exporterUpdateSpy = spyOnUpdate(exporter);

    exporter.addCard(front, back, { tags });

    expect(exporterUpdateSpy).toHaveBeenCalledTimes(WRITES_PER_CARD);

    const [notesCall, cardsCall] = exporterUpdateSpy.mock.calls;
    const notesUpdate = notesCall?.[1];
    expect(notesUpdate[":sfld"]).toBe(front);
    expect(notesUpdate[":flds"]).toBe(front + separator + back);
    expect(notesUpdate[":mid"]).toBe(topModelId);
    expect(notesUpdate[":tags"]).toBe(tags);

    const cardsUpdate = cardsCall?.[1];
    expect(cardsUpdate[":did"]).toBe(topDeckId);
    expect(cardsUpdate[":nid"]).toBe(notesUpdate[":id"]);
  });

  it("updates duplicates in place", () => {
    expect.hasAssertions();
    const { topDeckId, topModelId, separator } = exporter;
    const [front, back] = ["Test Front", "Test back"];
    const exporterUpdateSpy = spyOnUpdate(exporter);

    exporter.addCard(front, back);
    exporter.addCard(front, back);

    expect(exporterUpdateSpy).toHaveBeenCalledTimes(WRITES_PER_CARD * DUPLICATE_ADDS);

    const [firstNotesCall, firstCardsCall, secondNotesCall, secondCardsCall] =
      exporterUpdateSpy.mock.calls;
    const notesUpdate = firstNotesCall?.[1];
    const secondNotesUpdate = secondNotesCall?.[1];
    expect(notesUpdate[":id"]).toBe(secondNotesUpdate[":id"]);
    expect(notesUpdate[":guid"]).toBe(secondNotesUpdate[":guid"]);
    expect(notesUpdate[":sfld"]).toBe(front);
    expect(notesUpdate[":flds"]).toBe(front + separator + back);
    expect(notesUpdate[":mid"]).toBe(topModelId);

    const cardsUpdate = firstCardsCall?.[1];
    const secondCardsUpdate = secondCardsCall?.[1];
    expect(cardsUpdate[":id"]).toBe(secondCardsUpdate[":id"]);
    expect(cardsUpdate[":did"]).toBe(topDeckId);
    expect(cardsUpdate[":nid"]).toBe(notesUpdate[":id"]);
  });

  it("increments ids for rows inserted at the same timestamp", () => {
    expect.hasAssertions();
    const numberOfCards = 5;
    const [front, back] = ["Test Front", "Test back"];
    for (let index = 0; index < numberOfCards; index++) {
      exporter.addCard(`${front} ${index}`, `${back} ${index}`);
    }

    const noteIdsResult = exporter.db.exec("SELECT id FROM notes ORDER BY id DESC");
    expect(noteIdsResult).toStrictEqual([
      {
        columns: ["id"],
        values: Array.from({ length: numberOfCards }, (_unused, index) => [now + index]).sort(
          (left: readonly number[], right: readonly number[]) => right[0] - left[0],
        ),
      },
    ]);
  });
});
