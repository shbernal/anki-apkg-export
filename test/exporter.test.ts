import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import path from "path";
import { fileURLToPath } from "url";

import Exporter from "../src/exporter.js";
import createTemplate from "../src/template.js";
import { unzipDeckToBuffers } from "./_helpers.js";

const template = createTemplate();
const now = 1700000000000;
const locateFile = (file: string): string =>
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../node_modules/sql.js/dist",
    file,
  );
let sqlModule: SqlJsStatic;

describe("Exporter internals", () => {
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

  afterAll(() => {
    // nothing to clean up; keep hook to mirror beforeAll
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("Exporter.save builds zip with DB and media", async () => {
    const dbExportSpy = vi.spyOn(exporter.db, "export");

    exporter.addMedia("1.jpg", Buffer.from("one"));
    exporter.addMedia("2.bmp", Buffer.from("two"));
    const files = unzipDeckToBuffers(await exporter.save());

    expect(dbExportSpy).toHaveBeenCalled();
    expect([...files.keys()].sort()).toEqual([
      "0",
      "1",
      "collection.anki2",
      "media",
    ]);
    expect(files.get("collection.anki2")?.subarray(0, 15).toString()).toBe(
      "SQLite format 3",
    );
    expect(JSON.parse(files.get("media")!.toString())).toEqual({
      0: "1.jpg",
      1: "2.bmp",
    });
    expect(files.get("0")?.toString()).toBe("one");
    expect(files.get("1")?.toString()).toBe("two");
  });

  it("Exporter.save stamps entries with the creation date in UTC", async () => {
    exporter.addMedia("1.jpg", Buffer.from("one"));
    const archive = await exporter.save();

    // The DOS timestamp lives in the local file header at offset 10; pinning it
    // to the exporter's creation date in UTC is what keeps saves reproducible
    // regardless of the machine's timezone.
    const created = new Date(now);
    const expected =
      (((created.getUTCFullYear() - 1980) << 25) |
        ((created.getUTCMonth() + 1) << 21) |
        (created.getUTCDate() << 16) |
        (created.getUTCHours() << 11) |
        (created.getUTCMinutes() << 5) |
        (created.getUTCSeconds() >> 1)) >>>
      0;

    expect(archive.readUInt32LE(10)).toBe(expected);
  });

  it("Exporter.save accepts fflate zip options", async () => {
    exporter.addMedia("1.jpg", Buffer.from("one".repeat(500)));

    const compressed = await exporter.save();
    const stored = await exporter.save({ level: 0 });

    expect(stored.byteLength).toBeGreaterThan(compressed.byteLength);
    expect(unzipDeckToBuffers(stored).get("0")?.toString()).toBe(
      "one".repeat(500),
    );
  });

  it("Exporter.addCard populates note and card rows", () => {
    const { topDeckId, topModelId, separator } = exporter;
    const [front, back] = ["Test Front", "Test back"];
    const exporterUpdateSpy = vi.spyOn(
      exporter as unknown as { _update: Exporter["_update"] },
      "_update",
    );

    exporter.addCard(front, back);

    expect(exporterUpdateSpy).toHaveBeenCalledTimes(2);

    const [notesCall, cardsCall] = exporterUpdateSpy.mock.calls as [
      string,
      Record<string, string>,
    ][];

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

  it("Exporter.addCard handles tag array", () => {
    const { topModelId, separator } = exporter;
    const [front, back] = ["Test Front", "Test back"];
    const tags = ["tag1", "tag2", "multiple words tag"];
    const exporterUpdateSpy = vi.spyOn(
      exporter as unknown as { _update: Exporter["_update"] },
      "_update",
    );

    exporter.addCard(front, back, { tags });

    expect(exporterUpdateSpy).toHaveBeenCalledTimes(2);

    const [notesCall] = exporterUpdateSpy.mock.calls as [
      string,
      Record<string, string>,
    ][];
    const notesUpdate = notesCall?.[1];
    const notesTags = notesUpdate[":tags"].split(" ");
    expect(notesUpdate[":sfld"]).toBe(front);
    expect(notesUpdate[":flds"]).toBe(front + separator + back);
    expect(notesUpdate[":mid"]).toBe(topModelId);
    expect(notesTags).toEqual([
      "",
      ...tags.map((tag) => tag.replace(/ /g, "_")),
      "",
    ]);
  });

  it("Exporter.addCard handles tag string", () => {
    const { topDeckId, topModelId, separator } = exporter;
    const [front, back, tags] = [
      "Test Front",
      "Test back",
      "Some string with_delimiters",
    ];
    const exporterUpdateSpy = vi.spyOn(
      exporter as unknown as { _update: Exporter["_update"] },
      "_update",
    );

    exporter.addCard(front, back, { tags });

    expect(exporterUpdateSpy).toHaveBeenCalledTimes(2);

    const [notesCall, cardsCall] = exporterUpdateSpy.mock.calls as [
      string,
      Record<string, string>,
    ][];
    const notesUpdate = notesCall?.[1];
    expect(notesUpdate[":sfld"]).toBe(front);
    expect(notesUpdate[":flds"]).toBe(front + separator + back);
    expect(notesUpdate[":mid"]).toBe(topModelId);
    expect(notesUpdate[":tags"]).toBe(tags);

    const cardsUpdate = cardsCall?.[1];
    expect(cardsUpdate[":did"]).toBe(topDeckId);
    expect(cardsUpdate[":nid"]).toBe(notesUpdate[":id"]);
  });

  it("Exporter.addCard updates duplicates in place", () => {
    const { topDeckId, topModelId, separator } = exporter;
    const [front, back] = ["Test Front", "Test back"];
    const exporterUpdateSpy = vi.spyOn(
      exporter as unknown as { _update: Exporter["_update"] },
      "_update",
    );

    exporter.addCard(front, back);
    exporter.addCard(front, back);

    expect(exporterUpdateSpy).toHaveBeenCalledTimes(4);

    const [firstNotesCall, firstCardsCall, secondNotesCall, secondCardsCall] =
      exporterUpdateSpy.mock.calls as [string, Record<string, string>][];
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

  it("Exporter._getId increments values inserted at the same time", () => {
    const numberOfCards = 5;
    const [front, back] = ["Test Front", "Test back"];
    for (let i = 0; i < numberOfCards; i++) {
      exporter.addCard(`${front} ${i}`, `${back} ${i}`);
    }

    const noteIdsResult = exporter.db.exec(
      "SELECT id FROM notes ORDER BY id DESC",
    );
    expect(noteIdsResult).toEqual([
      {
        columns: ["id"],
        values: new Array(numberOfCards)
          .fill(0)
          .map((_, index) => [now + index])
          .sort((a, b) => b[0] - a[0]),
      },
    ]);
  });
});
