import { readFileSync } from "node:fs";
import path from "node:path";

import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import AnkiExport, {
  type AnkiNotetype,
  type AnkiPackage,
  readApkg,
  readPackage,
} from "../src/index.js";
import { loadSqlModule, useSqlModule } from "./_helpers.js";

/*
 * The reader, against packages this package did not write.
 *
 * Every fixture in `fixtures/collections/` comes out of real Anki; see
 * `tools/oracle/gen_collections.py` for how, and read that before changing what
 * is asserted here. Ids and timestamps in them come from the clock at the time
 * they were generated, so nothing below may assert on one.
 */

const FIXTURES = path.join(import.meta.dirname, "fixtures/collections");

const readFixture = (name: string): Uint8Array => readFileSync(path.join(FIXTURES, `${name}.apkg`));

/** The one note the decoy collection holds, which no read may ever return. */
const DECOY = "Please update to the latest Anki version";

/** The three notes `gen_collections.py` puts in every fixture. */
const VENATION = "Leaf venation patterns";
const PIGMENT = "Which pigment absorbs red light?";
const CLOZE_TEXT = "The {{c1::mitochondrion}} makes ATP.";

/** The first three bytes after a PNG's high bit, which every fixture image has. */
const PNG_SIGNATURE = new Uint8Array([0x50, 0x4e, 0x47]);

/** `Meta.version`, written by hand: 9 names no container, 2 names the wrong one. */
const META_VERSION_9 = new Uint8Array([0x08, 0x09]);
const META_VERSION_2 = new Uint8Array([0x08, 0x02]);

/** What this package's own writer emits, which the round trip below asserts. */
const OWN_PACKAGE_VERSION = 1;
const OWN_SCHEMA_VERSION = 11;

/** Media bytes for the round trip: short, and recognizable in a diff. */
const OWN_MEDIA = new Uint8Array([1, 2, 3]);

/** A schema Anki upgrades through and never leaves a collection sitting at. */
const UNREADABLE_SCHEMA = 15;

interface Layout {
  readonly name: string;
  readonly packageVersion: number;
  readonly schemaVersion: number;
}

/*
 * Four containers holding the same three notes. Two are Anki exports and two
 * are those exports re-framed, which is what makes this a matrix rather than
 * four separate cases: whatever the container, the answer is the same.
 */
/** A fixture with one archive entry replaced or added. */
const reframe = (name: string, changes: Readonly<Record<string, Uint8Array>>): Uint8Array =>
  zipSync({ ...unzipSync(readFixture(name)), ...changes });

/** A fixture with one archive entry taken out. */
const without = (name: string, entry: string): Uint8Array => {
  const archive = unzipSync(readFixture(name));
  delete archive[entry];

  return zipSync(archive);
};

/** The note type one note belongs to, looked up by the id the note carries. */
const notetypeOf = (pkg: AnkiPackage, index: number): AnkiNotetype | undefined =>
  pkg.notetypes.find((notetype: Readonly<AnkiNotetype>) => notetype.id === pkg.notes[index]?.mid);

const LAYOUTS: readonly Layout[] = [
  { name: "v1-schema11", packageVersion: 1, schemaVersion: 11 },
  { name: "v1-schema18", packageVersion: 1, schemaVersion: 18 },
  { name: "v2-schema11", packageVersion: 2, schemaVersion: 11 },
  { name: "v3-schema18", packageVersion: 3, schemaVersion: 18 },
];

describe("every package layout Anki writes", () => {
  it.each(LAYOUTS)(
    "$name is read as package $packageVersion, schema $schemaVersion",
    async ({ name, packageVersion, schemaVersion }) => {
      expect.hasAssertions();

      const pkg = await readApkg(readFixture(name));

      expect(pkg.packageVersion).toBe(packageVersion);
      expect(pkg.schemaVersion).toBe(schemaVersion);
    },
  );

  it.each(LAYOUTS)("$name carries the same three notes", async ({ name }) => {
    expect.hasAssertions();

    const { notes } = await readApkg(readFixture(name));

    expect(notes.map((note) => note.fields[0])).toStrictEqual([VENATION, PIGMENT, CLOZE_TEXT]);
    expect(notes[0]?.fields[1]).toContain("Parallel venation is typical of monocots");
  });

  it.each(LAYOUTS)("$name carries the tags Anki stored", async ({ name }) => {
    expect.hasAssertions();

    const { notes } = await readApkg(readFixture(name));

    /* Anki writes them space-delimited and padded either side, and nests with
       `::`, which is left exactly as it was stored. */
    expect(notes.map((note) => note.tags)).toStrictEqual([
      ["botany", "plants::leaves"],
      [],
      ["biology"],
    ]);
  });

  it.each(LAYOUTS)("$name names the fields of each note type", async ({ name }) => {
    expect.hasAssertions();

    const pkg = await readApkg(readFixture(name));

    expect(notetypeOf(pkg, 0)?.fields).toStrictEqual(["Front", "Back"]);
    expect(notetypeOf(pkg, 2)?.fields).toStrictEqual(["Text", "Back Extra"]);
  });

  /*
   * Cloze-ness is `models[].type` at schema 11 and a protobuf varint in
   * `notetypes.config` at 18, which is two unrelated encodings of one fact.
   */
  it.each(LAYOUTS)("$name reports which note types are cloze", async ({ name }) => {
    expect.hasAssertions();

    const pkg = await readApkg(readFixture(name));

    expect(notetypeOf(pkg, 0)?.isCloze).toBe(false);
    expect(notetypeOf(pkg, 2)?.isCloze).toBe(true);
  });

  it.each(LAYOUTS)("$name gives back the image under the name cards use", async ({ name }) => {
    expect.hasAssertions();

    const { media, notes } = await readApkg(readFixture(name));

    expect([...media.keys()]).toStrictEqual(["venation.png"]);
    expect(media.get("venation.png")?.slice(1, 1 + PNG_SIGNATURE.length)).toStrictEqual(
      PNG_SIGNATURE,
    );
    expect(notes[1]?.fields[1]).toContain('<img src="venation.png">');
  });

  /*
   * A v2 or v3 package also ships a `collection.anki2`, and it is a decoy: a
   * valid schema-11 database holding one note telling the reader to upgrade.
   * It is a well-formed two-field note, so a reader that opens the familiar
   * name gets no error at all, just the wrong deck.
   */
  it.each(LAYOUTS.filter((layout) => layout.packageVersion > 1))(
    "$name does not come back as the decoy collection",
    async ({ name }) => {
      expect.hasAssertions();

      const archive = unzipSync(readFixture(name));
      const { notes } = await readApkg(readFixture(name));

      expect(archive["collection.anki2"]).toBeDefined();
      expect(notes.map((note) => note.fields.join(""))).not.toContainEqual(
        expect.stringContaining(DECOY),
      );
    },
  );
});

describe("a deck this package wrote, read back", () => {
  const sqlModule = useSqlModule();

  it("carries back the fields, tags and media it was given", async () => {
    expect.hasAssertions();

    const apkg = await AnkiExport("deck-name");
    apkg.addCard("front", "back", { tags: ["one", "two"] });
    apkg.addMedia("anki.png", OWN_MEDIA);
    const zip = await apkg.save();
    apkg.close();

    const pkg = readPackage(sqlModule(), zip);

    /* This package writes package v1 at schema 11, which is one cell of the
       matrix above; it is here because a codec should round trip its own
       output, not because it covers anything the fixtures do not. */
    expect(pkg.packageVersion).toBe(OWN_PACKAGE_VERSION);
    expect(pkg.schemaVersion).toBe(OWN_SCHEMA_VERSION);
    expect(pkg.notes).toStrictEqual([
      expect.objectContaining({ fields: ["front", "back"], tags: ["one", "two"] }),
    ]);
    expect(pkg.notetypes[0]?.fields).toStrictEqual(["Front", "Back"]);
    expect(pkg.media.get("anki.png")).toStrictEqual(OWN_MEDIA);
  });
});

describe("packages this reader refuses", () => {
  const sqlModule = useSqlModule();

  it("names the package version it cannot read", () => {
    expect.hasAssertions();

    /* `Meta.version = 9`, a container that does not exist. */
    const future = reframe("v1-schema11", { meta: META_VERSION_9 });

    expect(() => readPackage(sqlModule(), future)).toThrow(/package version 9/u);
  });

  it("says which entry the declared version wanted", () => {
    expect.hasAssertions();

    /* Package v2 names `collection.anki21`, which the v1 fixture does not have. */
    const mislabelled = reframe("v1-schema11", { meta: META_VERSION_2 });

    expect(() => readPackage(sqlModule(), mislabelled)).toThrow(/collection\.anki21/u);
  });

  it("refuses a manifest naming an entry that is not in the package", () => {
    expect.hasAssertions();

    const lying = reframe("v1-schema11", {
      media: new TextEncoder().encode('{"7":"missing.png"}'),
    });

    expect(() => readPackage(sqlModule(), lying)).toThrow(/missing\.png/u);
  });

  it("says so when the package declares no version at all", () => {
    expect.hasAssertions();

    /* `Meta.version` is an enum, and its zero value is the one that says the
       writer did not know either. An empty `meta` is not a v1 package. */
    const silent = reframe("v1-schema11", { meta: new Uint8Array() });

    expect(() => readPackage(sqlModule(), silent)).toThrow(/package version 0/u);
  });

  it("says so when the collection has no `col` row", async () => {
    expect.hasAssertions();

    const sql = await loadSqlModule();
    const archive = unzipSync(readFixture("v1-schema11"));
    const db = new sql.Database(archive["collection.anki2"]);
    db.exec("DELETE FROM col");
    const emptied = zipSync({ ...archive, "collection.anki2": db.export() });
    db.close();

    expect(() => readPackage(sql, emptied)).toThrow(/returned no rows/u);
  });

  it("names the schema versions it reads", async () => {
    expect.hasAssertions();

    const sql = await loadSqlModule();
    const archive = unzipSync(readFixture("v1-schema11"));
    const db = new sql.Database(archive["collection.anki2"]);
    db.exec(`UPDATE col SET ver = ${UNREADABLE_SCHEMA}`);
    const downgraded = zipSync({ ...archive, "collection.anki2": db.export() });
    db.close();

    expect(() => readPackage(sql, downgraded)).toThrow(
      new RegExp(`schema version ${UNREADABLE_SCHEMA}`, "u"),
    );
  });
});

describe("packages this reader takes as they come", () => {
  const sqlModule = useSqlModule();

  /* A deck with no images ships no manifest at all in some exporters and an
     empty one in others. Neither is a failure, and the notes still load. */
  it("reads a package with no media manifest", () => {
    expect.hasAssertions();

    const pkg = readPackage(sqlModule(), without("v1-schema11", "media"));

    expect(pkg.media.size).toBe(0);
    expect(pkg.notes).toHaveLength(3);
  });

  it("reads a package whose media manifest is empty", () => {
    expect.hasAssertions();

    const pkg = readPackage(sqlModule(), reframe("v1-schema11", { media: new Uint8Array() }));

    expect(pkg.media.size).toBe(0);
  });

  /*
   * `fields` outlives the note types it belongs to, and an Anki export ships
   * rows for ids no note type has. The other direction is possible too, and a
   * note type whose rows are gone has no fields rather than somebody else's.
   */
  it("reads a note type whose fields rows are missing", async () => {
    expect.hasAssertions();

    const sql = await loadSqlModule();
    const archive = unzipSync(readFixture("v1-schema18"));
    const db = new sql.Database(archive["collection.anki2"]);
    /* `fields` is `WITHOUT ROWID` and collated, so it cannot be touched until
       the collation is out of the way; the reader does the same thing. */
    db.exec("PRAGMA writable_schema=ON");
    db.exec(
      "UPDATE sqlite_master SET sql = replace(sql, ' COLLATE unicase', '') WHERE sql LIKE '%unicase%'",
    );
    db.exec("PRAGMA writable_schema=RESET");
    db.exec("DELETE FROM fields");
    const stripped = zipSync({ ...archive, "collection.anki2": db.export() });
    db.close();

    expect(readPackage(sql, stripped).notetypes.map((notetype) => notetype.fields)).toStrictEqual([
      [],
      [],
    ]);
  });

  /*
   * `notetypes.config` is a blob holding a protobuf, and SQLite's typing does
   * not hold anything to that. A collection written by something other than
   * Anki can put text there, and the answer to "is this a cloze" is then no,
   * rather than a crash halfway through a deck.
   */
  it("reads a note type whose config is not a protobuf blob", async () => {
    expect.hasAssertions();

    const sql = await loadSqlModule();
    const archive = unzipSync(readFixture("v1-schema18"));
    const db = new sql.Database(archive["collection.anki2"]);
    db.exec("UPDATE notetypes SET config = 'not a protobuf'");
    const rewritten = zipSync({ ...archive, "collection.anki2": db.export() });
    db.close();

    expect(readPackage(sql, rewritten).notetypes.map((notetype) => notetype.isCloze)).toStrictEqual(
      [false, false],
    );
  });
});
