import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

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
import { readRows, useSqlModule } from "./_helpers.js";

/*
 * The whole-collection writer. Whether Anki itself reads what it writes back
 * the same is apkg-spec's eval; this is what the package can say on its own.
 */

const FIXTURES = path.join(import.meta.dirname, "fixtures/collections");
const LAYOUTS = ["v1-schema11", "v1-schema18", "v2-schema11", "v3-schema18"];
const NOW = 1_700_000_000_000;

/** Everything a read returns that a write is asked to carry. */
const content = ({ cards, decks, media, notes, notetypes }: AnkiPackage) => ({
  cards,
  decks,
  media,
  notes,
  notetypes,
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

  it.each(LAYOUTS)("writes back what it read from %s", async (layout: string) => {
    expect.assertions(2);

    const read = await readApkg(readFileSync(path.join(FIXTURES, `${layout}.apkg`)));
    const reread = await readApkg(await writeApkg(read, { now: NOW }));

    expect(content(reread)).toStrictEqual(content(read));
    expect([reread.packageVersion, reread.schemaVersion]).toStrictEqual([2, 11]);
  });

  it("declares package version 2 the way Anki does", () => {
    expect.assertions(2);

    const entries = unzipSync(writePackage(sql(), VOCABULARY, { now: NOW }));

    expect(Object.keys(entries)).toStrictEqual(["meta", "collection.anki21", "media"]);
    expect(entries.meta).toStrictEqual(new Uint8Array([0x08, 0x02]));
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

  it("carries media by name", async () => {
    expect.assertions(1);

    const bytes = new Uint8Array([1, 2, 3]);
    const { media } = await readApkg(
      writePackage(sql(), { ...VOCABULARY, media: new Map([["a b.png", bytes]]) }, { now: NOW }),
    );

    expect(media).toStrictEqual(new Map([["a b.png", bytes]]));
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
    const options = { packageVersion: 3 } as unknown as { packageVersion: 2 };

    expect(() => writePackage(sql(), VOCABULARY, options)).toThrow("package version 3");
  });
});
