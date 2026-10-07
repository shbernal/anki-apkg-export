import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  type AnkiCard,
  type AnkiNote,
  type AnkiPackage,
  readApkg,
  type WritableCollection,
  writeApkg,
  writePackage,
} from "../src/index.js";
import { readRows, unzipDeckToBuffers, useSqlModule } from "./_helpers.js";

/*
 * The whole-collection writer. Whether Anki itself reads what it writes back
 * the same is apkg-spec's eval; this is what the package can say on its own.
 */

const FIXTURES = path.join(import.meta.dirname, "fixtures/collections");
const LAYOUTS = ["v1-schema11", "v1-schema18", "v2-schema11", "v3-schema18"];
const NOW = 1_700_000_000_000;
/** Each package version the writer takes, and the schema it holds. */
const VERSIONS = [
  [2, 11],
  [3, 18],
] as const;

const byId = (left: Readonly<{ id: number }>, right: Readonly<{ id: number }>) =>
  left.id - right.id;

/** One archive entry, failing by name rather than handing on `undefined`. */
const entryOf = (entries: ReadonlyMap<string, Buffer>, name: string): Buffer => {
  const data = entries.get(name);
  if (data === undefined) {
    throw new Error(`Expected a ${name} entry`);
  }

  return data;
};

/**
 * Everything a read returns that a write is asked to carry. Note types and
 * decks by id: schema 11 keeps them in a JSON object and schema 18 in tables,
 * and a read promises neither order.
 */
const content = ({ cards, decks, media, notes, notetypes }: AnkiPackage) => ({
  cards,
  decks: [...decks].sort(byId),
  media,
  notes,
  notetypes: [...notetypes].sort(byId),
});

const NOTE: AnkiNote = {
  id: 20,
  guid: "g1",
  mid: 10,
  fields: ["<b>laconic</b>", "terse"],
  tags: ["en", "adj"],
};

const CARD: AnkiCard = {
  id: 30,
  nid: 20,
  did: 40,
  ord: 0,
  type: 2,
  queue: 2,
  due: 12,
  ivl: 5,
  factor: 2500,
  reps: 3,
  lapses: 1,
};

const VOCABULARY: WritableCollection = {
  notetypes: [
    {
      id: 10,
      name: "Vocabulary",
      isCloze: false,
      fields: ["Word", "Meaning"],
      templates: [{ name: "Recall", qfmt: "{{Meaning}}", afmt: "{{Word}}" }],
      css: ".card {}",
      sortField: 1,
    },
  ],
  notes: [NOTE],
  cards: [CARD],
  decks: [{ id: 40, name: "Words::English::Adjectives", description: "<i>short</i>" }],
};

describe("the collection writer", () => {
  const sql = useSqlModule();

  it.each(LAYOUTS.flatMap((layout) => VERSIONS.map((version) => [layout, ...version] as const)))(
    "writes back what it read from %s as version %i",
    async (layout: string, packageVersion: 2 | 3, schemaVersion: number) => {
      expect.assertions(2);

      const read = await readApkg(readFileSync(path.join(FIXTURES, `${layout}.apkg`)));
      const reread = await readApkg(await writeApkg(read, { now: NOW, packageVersion }));

      expect(content(reread)).toStrictEqual(content(read));
      expect([reread.packageVersion, reread.schemaVersion]).toStrictEqual([
        packageVersion,
        schemaVersion,
      ]);
    },
  );

  it("declares package version 2 the way Anki does", () => {
    expect.assertions(2);

    const entries = unzipSync(writePackage(sql(), VOCABULARY, { now: NOW }));

    expect(Object.keys(entries)).toStrictEqual(["meta", "collection.anki21", "media"]);
    expect(entries.meta).toStrictEqual(new Uint8Array([0x08, 0x02]));
  });

  it("declares package version 3 the way Anki does, with schema 18 under unicase", () => {
    expect.assertions(4);

    const entries = unzipDeckToBuffers(
      writePackage(sql(), VOCABULARY, { now: NOW, packageVersion: 3 }),
    );
    const collection = zstdDecompressSync(entryOf(entries, "collection.anki21b"));
    const db = new (sql().Database)(collection);
    try {
      const collated = readRows(
        db,
        "select name from sqlite_master where sql like '%COLLATE unicase%' order by name",
      );

      expect([...entries.keys()]).toStrictEqual(["meta", "collection.anki21b", "media"]);
      expect(entries.get("meta")).toStrictEqual(Buffer.from([0x08, 0x03]));
      expect(readRows(db, "select ver from col")).toStrictEqual([{ ver: 18 }]);
      expect(collated).toStrictEqual(
        ["deck_config", "decks", "fields", "notetypes", "tags", "templates"].map((name) => ({
          name,
        })),
      );
    } finally {
      db.close();
    }
  });

  it("adds Default and every parent deck a name implies", async () => {
    expect.assertions(2);

    const { decks } = await readApkg(writePackage(sql(), VOCABULARY, { now: NOW }));

    expect(decks.map(({ name }) => name).sort()).toStrictEqual([
      "Default",
      "Words",
      "Words::English",
      "Words::English::Adjectives",
    ]);
    expect(decks.find(({ id }) => id === 40)?.description).toBe("<i>short</i>");
  });

  it("keeps scheduling as given and derives sfld and csum like Anki", () => {
    expect.assertions(3);

    const entries = unzipSync(writePackage(sql(), VOCABULARY, { now: NOW }));
    const db = new (sql().Database)(entries["collection.anki21"]);
    try {
      const [note] = readRows(db, "select sfld, csum, tags from notes");
      const [card] = readRows(db, "select type, queue, due, ivl, factor, reps, lapses from cards");
      const [col] = readRows(db, "select conf from col");
      const checksum = createHash("sha1").update("laconic").digest("hex").slice(0, 8);

      expect(note).toStrictEqual({
        sfld: "terse",
        csum: Number.parseInt(checksum, 16),
        tags: " en adj ",
      });
      expect(card).toStrictEqual({
        type: 2,
        queue: 2,
        due: 12,
        ivl: 5,
        factor: 2500,
        reps: 3,
        lapses: 1,
      });
      expect(JSON.parse(String(col?.conf))).toMatchObject({ schedVer: 2, curModel: 10 });
    } finally {
      db.close();
    }
  });

  it.each(VERSIONS)("carries media by name in version %i", async (packageVersion: 2 | 3) => {
    expect.assertions(1);

    const bytes = new Uint8Array([1, 2, 3]);
    const { media } = await readApkg(
      writePackage(
        sql(),
        { ...VOCABULARY, media: new Map([["a b.png", bytes]]) },
        { now: NOW, packageVersion },
      ),
    );

    expect(media).toStrictEqual(new Map([["a b.png", bytes]]));
  });

  it("keeps LaTeX settings, and gives Anki's defaults when there are none", async () => {
    expect.assertions(2);

    const latex = {
      latexPre: String.raw`\begin{document}`,
      latexPost: String.raw`\end{document}`,
      latexSvg: true,
    };
    const notetypes = VOCABULARY.notetypes.map((notetype) => ({ ...notetype, ...latex }));
    const kept = await readApkg(writePackage(sql(), { ...VOCABULARY, notetypes }, { now: NOW }));
    const defaulted = await readApkg(writePackage(sql(), VOCABULARY, { now: NOW }));

    expect(kept.notetypes).toMatchObject([latex]);
    expect(defaulted.notetypes).toMatchObject([
      { latexPost: String.raw`\end{document}`, latexSvg: false },
    ]);
  });

  it.each([
    ["an unknown note type", { notes: [{ ...NOTE, mid: 11 }] }, "note type 11"],
    ["a short note", { notes: [{ ...NOTE, fields: ["x"] }] }, "1 fields"],
    ["an unknown note", { cards: [{ ...CARD, nid: 21 }] }, "note 21"],
    ["an unknown deck", { cards: [{ ...CARD, did: 41 }] }, "deck 41"],
  ] as const)("refuses %s", (_case, change, message) => {
    expect.assertions(1);

    expect(() => writePackage(sql(), { ...VOCABULARY, ...change }, { now: NOW })).toThrow(message);
  });

  it("refuses a package version it does not write", () => {
    expect.assertions(1);

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const options = { packageVersion: 4 } as unknown as { packageVersion: 2 };

    expect(() => writePackage(sql(), VOCABULARY, options)).toThrow("package version 4");
  });
});
