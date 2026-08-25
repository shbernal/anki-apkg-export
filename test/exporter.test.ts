import type { SqlValue } from "sql.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Exporter from "../src/exporter.js";
import createTemplate from "../src/template.js";
import { readRow, readRows, unzipDeckToBuffers, useSqlModule } from "./_helpers.js";

const now = 1_700_000_000_000;

/* Stamped with the instant the suite pins its fake timers to, so the collection
   row and the rows written into it agree on when the deck was built. */
const template = createTemplate(undefined, now);

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

/** Row ids are epoch milliseconds; `mod` columns are epoch seconds. */
const MILLISECONDS_PER_SECOND = 1000;

/** A gap large enough that no clock reading could be mistaken for another. */
const MILLISECONDS_PER_DAY = 86_400_000;

/** Enough repetition that deflate beats stored, so `level: 0` is observable. */
const PADDING = 500;

/** Fronts for the queue-position test; only how many there are matters. */
const QUEUED_CARDS = ["front 1", "front 2", "front 3"];

/** A first field that parses as a number, which `sfld`'s column affinity coerces. */
const NUMERIC_FRONT = "42";

/** `sha1("42")` truncated to four bytes, big endian: the checksum of the *string*. */
const NUMERIC_FRONT_CHECKSUM = 0x92_cf_ce_b3;

/** Fronts that strip to nothing, so Anki's importer would drop their notes. */
const EMPTY_FRONTS = ["", "   ", "<br>"];

/** Fronts for the repeat test: the second call repeats the first. */
const REPEATED_CARDS = ["front 1", "front 1", "front 2"];

/** How many cards `REPEATED_CARDS` actually queues, the repeat aside. */
const REPEATED_CARDS_QUEUED = new Set(REPEATED_CARDS).size;

/** Decode the collection's `conf` JSON column straight out of the live db. */
const readCollectionConf = (target: Readonly<Exporter>): unknown =>
  JSON.parse(String(readRow(target.db, "select conf from col").conf));

describe("the exporter internals", () => {
  const sqlModule = useSqlModule();
  let exporter: Exporter;

  beforeEach(() => {
    vi.useFakeTimers({ now, toFake: ["Date"] });
    exporter = new Exporter("testDeckName", {
      template,
      sql: sqlModule(),
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

  it("lets a repeated media filename replace its earlier bytes", async () => {
    expect.hasAssertions();

    exporter.addMedia("a.png", Buffer.from("one"));
    exporter.addMedia("a.png", Buffer.from("two"));
    const files = unzipDeckToBuffers(await exporter.save());

    /* Both entries used to ship. Anki writes entry 0 into its media folder and
       then overwrites it with entry 1, so the first payload was dead weight. */
    expect(JSON.parse(files.get("media")!.toString())).toStrictEqual({ 0: "a.png" });
    expect(files.get("0")?.toString()).toBe("two");
    expect([...files.keys()]).not.toContain("1");
  });

  it("keeps a replaced file at the index it was first given", async () => {
    expect.hasAssertions();

    exporter.addMedia("a.png", Buffer.from("one"));
    exporter.addMedia("b.png", Buffer.from("two"));
    exporter.addMedia("a.png", Buffer.from("three"));
    const files = unzipDeckToBuffers(await exporter.save());

    /* The manifest is index-keyed, so a replacement must not renumber what
       comes after it. */
    expect(JSON.parse(files.get("media")!.toString())).toStrictEqual({ 0: "a.png", 1: "b.png" });
    expect(files.get("0")?.toString()).toBe("three");
    expect(files.get("1")?.toString()).toBe("two");
  });

  it("treats filenames differing only in case as two files", async () => {
    expect.hasAssertions();

    exporter.addMedia("a.png", Buffer.from("one"));
    exporter.addMedia("A.png", Buffer.from("two"));
    const files = unzipDeckToBuffers(await exporter.save());

    /* Anki reads a media filename as opaque text; folding case here would
       silently merge two files a caller asked for separately. */
    expect(JSON.parse(files.get("media")!.toString())).toStrictEqual({ 0: "a.png", 1: "A.png" });
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

  it("keeps building after a save", async () => {
    expect.hasAssertions();

    exporter.addCard("front 1", "back");
    await exporter.save();

    exporter.addCard("front 2", "back");
    const second = await exporter.save();
    const third = await exporter.save();

    /* `db.export()` invalidates any statement left open across it, which is why
       nothing here caches one — see docs/architecture.md. This is the property
       that reasoning rests on. */
    const collection = unzipDeckToBuffers(second).get("collection.anki2")!.toString("latin1");

    expect(collection).toContain("front 1");
    expect(collection).toContain("front 2");

    /* Saving again with nothing added in between changes no byte: the exporter
       reads its clock once, at construction. */
    expect(third.equals(second)).toBe(true);
  });

  it("populates note and card rows when a card is added", () => {
    expect.hasAssertions();
    const { topDeckId, topModelId, separator } = exporter;
    const [front, back] = ["Test Front", "Test back"];

    exporter.addCard(front, back);

    const notes = readRows(exporter.db, "select * from notes");
    const cards = readRows(exporter.db, "select * from cards");

    expect(notes).toHaveLength(1);
    expect(cards).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      sfld: front,
      flds: front + separator + back,
      mid: topModelId,
    });
    expect(cards[0]).toMatchObject({
      did: topDeckId,
      nid: notes[0]?.id,
    });
  });

  it("writes ids in milliseconds and mod times in seconds", () => {
    expect.hasAssertions();

    exporter.addCard("Test Front", "Test back");

    /* Anki keeps an imported row's `mod` as given. Milliseconds in a column
       read as seconds date the row to roughly the year 58,600, and nothing on
       the import path corrects it — unlike `sfld` and `csum`. */
    const expected = { id: now, mod: Math.floor(now / MILLISECONDS_PER_SECOND) };

    expect(readRows(exporter.db, "select id, mod from notes")).toStrictEqual([expected]);
    expect(readRows(exporter.db, "select id, mod from cards")).toStrictEqual([expected]);
  });

  it("gives each new card the next position in the queue", async () => {
    expect.hasAssertions();

    QUEUED_CARDS.forEach((front: string) => {
      exporter.addCard(front, "back");
    });

    /* Ordering by id is insertion order: the clock is frozen, so each card
       claims the previous id plus one. */
    const positions = readRows(exporter.db, "select due from cards order by id").map(
      (row: Readonly<Record<string, SqlValue>>) => row.due,
    );

    /* Anki counts new cards up from 1, rather than giving every card the same
       hardcoded position. */
    expect(positions).toStrictEqual(QUEUED_CARDS.map((_front: string, index: number) => index + 1));

    /* `nextPos` has to end past the last position handed out, or the next card
       a user adds in Anki lands on top of one of these. */
    await exporter.save();

    expect(readCollectionConf(exporter)).toMatchObject({ nextPos: QUEUED_CARDS.length + 1 });
  });

  it("refuses a card whose first field strips to nothing", () => {
    expect.hasAssertions();

    EMPTY_FRONTS.forEach((front: string) => {
      expect(() => {
        exporter.addCard(front, "back");
      }).toThrow(/first field is empty/u);
    });

    /* The refusal happens before anything is written, so a rejected call costs
       neither a row nor a queue position. */
    expect(readRows(exporter.db, "select * from notes")).toStrictEqual([]);
    expect(readRows(exporter.db, "select * from cards")).toStrictEqual([]);

    exporter.addCard("front", "back");

    expect(readRows(exporter.db, "select due from cards")).toStrictEqual([{ due: 1 }]);
  });

  it("accepts a first field that is nothing but a media reference", () => {
    expect.hasAssertions();

    /* `<img>` is stripped down to its filename rather than removed, so the
       sort field is not empty and Anki keeps the note. */
    exporter.addCard('<img src="a.png">', "back");

    expect(readRows(exporter.db, "select sfld from notes")).toStrictEqual([{ sfld: " a.png " }]);
  });

  it("accepts an empty back", () => {
    expect.hasAssertions();
    const { separator } = exporter;

    /* Anki only requires the *first* field, so a card with nothing on the back
       is a note it imports. */
    exporter.addCard("front", "");

    expect(readRows(exporter.db, "select flds from notes")).toStrictEqual([
      { flds: `front${separator}` },
    ]);
  });

  it("stores a numeric first field as an integer and still checksums the string", () => {
    expect.hasAssertions();

    exporter.addCard(NUMERIC_FRONT, "back");

    /* `notes.sfld` is declared `integer`, so SQLite's column affinity converts
       a first field that parses as one. Anki does the same, which is why the
       oracle reads `sfld` back as an int. */
    const row = readRow(exporter.db, "select sfld, typeof(sfld) as sfldType, csum from notes");

    expect(row).toStrictEqual({
      sfld: Number(NUMERIC_FRONT),
      sfldType: "integer",

      /* The checksum is computed in JavaScript from the string, before sqlite
         ever sees it, so the coercion does not follow it. */
      csum: NUMERIC_FRONT_CHECKSUM,
    });
  });

  it("joins a tag array into Anki's space-delimited form", () => {
    expect.hasAssertions();
    const { topModelId, separator } = exporter;
    const [front, back] = ["Test Front", "Test back"];
    const tags = ["tag1", "tag2", "multiple words tag"];

    exporter.addCard(front, back, { tags });

    const notes = readRows(exporter.db, "select * from notes");

    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      sfld: front,
      flds: front + separator + back,
      mid: topModelId,
    });

    /* Anki splits tags on spaces, so a tag containing one is underscored and
       the whole field is space-padded at both ends. */
    expect(String(notes[0]?.tags).split(" ")).toStrictEqual([
      "",
      ...tags.map((tag: string) => tag.replaceAll(" ", "_")),
      "",
    ]);
  });

  it("stores no tags at all for an empty tag array", () => {
    expect.hasAssertions();

    exporter.addCard("Test Front", "Test back", { tags: [] });

    /* What Anki writes for an untagged note, and what `mdanki` asks for on
       every card it exports without tags. */
    expect(readRow(exporter.db, "select tags from notes")).toStrictEqual({ tags: "" });
  });

  it("drops array entries that hold no tag", () => {
    expect.hasAssertions();

    exporter.addCard("Test Front", "Test back", { tags: ["", "  ", "real"] });

    expect(readRow(exporter.db, "select tags from notes")).toStrictEqual({ tags: " real " });
  });

  it("writes the same tags for an empty array as for no options", () => {
    expect.hasAssertions();

    exporter.addCard("Empty array", "back", { tags: [] });
    exporter.addCard("No options", "back");

    const written = readRows(exporter.db, "select tags from notes").map(
      (note: Readonly<Record<string, SqlValue>>) => note.tags,
    );

    expect(written).toStrictEqual(["", ""]);
  });

  it("passes a tag string through untouched", () => {
    expect.hasAssertions();
    const { topDeckId, topModelId, separator } = exporter;
    const [front, back, tags] = ["Test Front", "Test back", "Some string with_delimiters"];

    exporter.addCard(front, back, { tags });

    const notes = readRows(exporter.db, "select * from notes");
    const cards = readRows(exporter.db, "select * from cards");

    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      sfld: front,
      flds: front + separator + back,
      mid: topModelId,
      tags,
    });
    expect(cards[0]).toMatchObject({
      did: topDeckId,
      nid: notes[0]?.id,
    });
  });

  it("updates duplicates in place", () => {
    expect.hasAssertions();
    const { topDeckId, topModelId, separator } = exporter;
    const [front, back] = ["Test Front", "Test back"];

    exporter.addCard(front, back);
    exporter.addCard(front, back);

    const notes = readRows(exporter.db, "select * from notes");
    const cards = readRows(exporter.db, "select * from cards");

    /* The whole claim of "in place": adding the same card twice leaves one note
       and one card behind, not two. */
    expect(notes).toHaveLength(1);
    expect(cards).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      sfld: front,
      flds: front + separator + back,
      mid: topModelId,
    });
    expect(cards[0]).toMatchObject({
      did: topDeckId,
      nid: notes[0]?.id,
    });
  });

  it("keeps the queue contiguous when a card repeats", async () => {
    expect.hasAssertions();

    REPEATED_CARDS.forEach((front: string) => {
      exporter.addCard(front, "back");
    });

    const positions = readRows(exporter.db, "select due from cards order by id").map(
      (row: Readonly<Record<string, SqlValue>>) => row.due,
    );

    /* The repeat replaces the card it duplicates rather than queueing a second
       one, so it keeps its own position and leaves the next free for the card
       that follows. */
    expect(positions).toStrictEqual(
      Array.from({ length: REPEATED_CARDS_QUEUED }, (_unused: unknown, index: number) => index + 1),
    );

    await exporter.save();

    /* `nextPos` counts cards, not calls. Counting the repeat would point it
       past a position nothing holds. */
    expect(readCollectionConf(exporter)).toMatchObject({ nextPos: REPEATED_CARDS_QUEUED + 1 });
  });

  it("increments ids for rows inserted at the same timestamp", () => {
    expect.hasAssertions();
    const numberOfCards = 5;
    const [front, back] = ["Test Front", "Test back"];
    for (let index = 0; index < numberOfCards; index++) {
      exporter.addCard(`${front} ${index}`, `${back} ${index}`);
    }

    const noteIds = readRows(exporter.db, "SELECT id FROM notes ORDER BY id DESC").map(
      (row: Readonly<Record<string, SqlValue>>) => row.id,
    );

    /* The clock is frozen, so every card asks for the same millisecond and each
       one has to step past the id already taken. */
    expect(noteIds).toStrictEqual(
      Array.from({ length: numberOfCards }, (_unused, index) => now + numberOfCards - 1 - index),
    );
  });
});

describe("the injected clock", () => {
  const sqlModule = useSqlModule();

  /* No fake timers here on purpose: these assert that nothing in the exporter
     reads the clock once `now` is given, which a frozen `Date` would hide. */
  const buildAt = (injected: number): Exporter =>
    new Exporter("testDeckName", {
      template: createTemplate(undefined, injected),
      sql: sqlModule(),
      now: injected,
    });

  it("stamps every row it writes with the injected instant", () => {
    expect.hasAssertions();
    const exporter = buildAt(now);

    exporter.addCard("Test Front", "Test back");

    const expected = { id: now, mod: Math.floor(now / MILLISECONDS_PER_SECOND) };

    expect(readRows(exporter.db, "select id, mod from notes")).toStrictEqual([expected]);
    expect(readRows(exporter.db, "select id, mod from cards")).toStrictEqual([expected]);
    expect(readRow(exporter.db, "select mod from col").mod).toBe(now);
  });

  it("builds byte-identical archives from the same input and clock", async () => {
    expect.hasAssertions();
    const save = (): Promise<Buffer> => {
      const exporter = buildAt(now);
      exporter.addCard("Test Front", "Test back");
      exporter.addMedia("1.jpg", Buffer.from("one"));

      return exporter.save();
    };

    /* The whole point of the option: reproducibility survives leaving the
       process, not just leaving the millisecond. */
    const [firstSave, secondSave] = [await save(), await save()];

    expect(firstSave.equals(secondSave)).toBe(true);
  });
});

describe("reading the collection row", () => {
  const sqlModule = useSqlModule();
  let exporter: Exporter;

  beforeEach(() => {
    exporter = new Exporter("testDeckName", {
      template: createTemplate(undefined, now),
      sql: sqlModule(),
      now,
    });
  });

  /* Both paths are reached through the public `db`, which is the only way to
     get a collection into either state — and the reason the checks exist. */

  it("says which column it could not read when the col row is gone", async () => {
    expect.hasAssertions();
    exporter.db.run("delete from col");

    /* `save` writes `nextPos` back, so it reads `conf` first. */
    await expect(exporter.save()).rejects.toThrow(
      "Cannot read col.conf: the collection has no col row",
    );
  });

  it("says so when the column does not hold text", async () => {
    expect.hasAssertions();

    /* A blob, because the column's TEXT affinity coerces a number to '5' and
       that would parse. Only a blob actually arrives as a non-string. */
    exporter.db.run("update col set conf = x'0102'");

    await expect(exporter.save()).rejects.toThrow(
      new TypeError("Cannot read col.conf: the column does not hold text"),
    );
  });
});

describe("a template missing its placeholders", () => {
  const sqlModule = useSqlModule();

  it("refuses to build rather than writing undefined into the deck", () => {
    expect.hasAssertions();

    /* The constructor re-keys the seeded deck and note model under this
       export's own ids, so a template that seeds none leaves it nothing to
       rename. Appending the UPDATE is how the collection reaches that state:
       the constructor runs the whole script before it reads anything back. */
    const emptied = `${createTemplate(undefined, now)}\nUPDATE col SET decks='{}';`;

    expect(
      () => new Exporter("testDeckName", { template: emptied, sql: sqlModule(), now }),
    ).toThrow("Cannot take the last item of an empty collection map");
  });
});

describe("closing an exporter", () => {
  const sqlModule = useSqlModule();
  let exporter: Exporter;

  beforeEach(() => {
    exporter = new Exporter("testDeckName", {
      template: createTemplate(undefined, now),
      sql: sqlModule(),
      now,
    });
  });

  it("closes the database once, however many times it is called", () => {
    expect.hasAssertions();
    const closeSpy = vi.spyOn(exporter.db, "close");

    exporter.close();
    exporter.close();

    /* Not just tidiness: `db.close()` frees the handle, so a second one would
       be sqlite operating on a pointer it has already released. */
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("disposes at the end of a `using` block", async () => {
    expect.hasAssertions();
    const closeSpy = vi.spyOn(exporter.db, "close");

    {
      using disposable = exporter;
      disposable.addCard("Test Front", "Test back");
    }

    expect(closeSpy).toHaveBeenCalledTimes(1);
    await expect(exporter.save()).rejects.toThrow(/closed exporter/u);
  });

  it("refuses every operation afterwards, by name", async () => {
    expect.hasAssertions();
    exporter.close();

    /* A sentence, rather than whatever a WASM read of freed memory produces. */
    expect(() => {
      exporter.addCard("Test Front", "Test back");
    }).toThrow("Cannot addCard on a closed exporter: close() released its database");
    expect(() => {
      exporter.addMedia("1.jpg", Buffer.from("one"));
    }).toThrow("Cannot addMedia on a closed exporter: close() released its database");
    await expect(exporter.save()).rejects.toThrow(
      "Cannot save on a closed exporter: close() released its database",
    );
  });

  it("leaves a saved deck usable after the database is gone", async () => {
    expect.hasAssertions();
    exporter.addCard("Test Front", "Test back");
    const deck = await exporter.save();
    exporter.close();

    /* `save` returns bytes, not a view into the WASM heap. */
    expect(unzipDeckToBuffers(deck).get("collection.anki2")?.byteLength).toBeGreaterThan(0);
  });
});

describe("note guids", () => {
  const sqlModule = useSqlModule();

  /** The guid of one card, exported alone into a deck built at `injected`. */
  const guidOf = (deckName: string, card: readonly [string, string], injected: number): string => {
    const exporter = new Exporter(deckName, {
      template: createTemplate(undefined, injected),
      sql: sqlModule(),
      now: injected,
    });
    exporter.addCard(...card);

    return String(readRow(exporter.db, "select guid from notes").guid);
  };

  const CARD: readonly [string, string] = ["Test Front", "Test back"];

  /** Any later instant; it only has to differ from `now`. */
  const LATER = now + MILLISECONDS_PER_DAY;

  it("gives a card the same guid however long after the first export", () => {
    expect.hasAssertions();

    /* Anki matches notes on guid at import. A guid derived from the deck id —
       a timestamp — changed on every export, so re-importing a deck added a
       second copy of every note instead of updating the ones already there. */
    expect(guidOf("testDeckName", CARD, now)).toBe(guidOf("testDeckName", CARD, LATER));
  });

  it("keeps the same content in a differently named deck distinct", () => {
    expect.hasAssertions();

    /* The deck name is in the hash so that two decks sharing a card are two
       notes to Anki, not one that follows whichever deck imported last. */
    expect(guidOf("one", CARD, now)).not.toBe(guidOf("another", CARD, now));
  });

  it("gives an edited card a new guid", () => {
    expect.hasAssertions();

    /* Follows from deriving the guid from content, and is the price of it:
       editing a card's text imports as a new note rather than an update. */
    expect(guidOf("testDeckName", CARD, now)).not.toBe(
      guidOf("testDeckName", ["Test Front", "Edited back"], now),
    );
  });
});
