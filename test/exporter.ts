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
    vi.useFakeTimers({ now });
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
    const zipFileSpy = vi.spyOn(exporter.zip, "file");
    const zipGenerateAsyncSpy = vi.spyOn(exporter.zip, "generateAsync");

    exporter.addMedia("1.jpg", Buffer.from("one"));
    exporter.addMedia("2.bmp", Buffer.from("two"));
    await exporter.save();

    expect(dbExportSpy).toHaveBeenCalled();
    expect(zipFileSpy).toHaveBeenCalledWith(
      "collection.anki2",
      expect.any(Buffer),
    );
    expect(zipFileSpy).toHaveBeenCalledWith("media", expect.any(String));
    expect(zipFileSpy).toHaveBeenCalledWith("0", expect.anything());
    expect(zipFileSpy).toHaveBeenCalledWith("1", expect.anything());
    expect(zipGenerateAsyncSpy).toHaveBeenCalled();
    expect(zipGenerateAsyncSpy.mock.calls[0][0]?.type).toBe("nodebuffer");
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

    const [notesCall, cardsCall] = exporterUpdateSpy.mock.calls as Array<
      [string, Record<string, string>]
    >;

    expect(notesCall?.[0]).toBe(
      "insert or replace into notes values(:id,:guid,:mid,:mod,:usn,:tags,:flds,:sfld,:csum,:flags,:data)",
    );
    const notesUpdate = notesCall?.[1] as Record<string, string>;
    expect(notesUpdate[":sfld"]).toBe(front);
    expect(notesUpdate[":flds"]).toBe(front + separator + back);
    expect(notesUpdate[":mid"]).toBe(topModelId);

    expect(cardsCall?.[0]).toBe(
      "insert or replace into cards values(:id,:nid,:did,:ord,:mod,:usn,:type,:queue,:due,:ivl,:factor,:reps,:lapses,:left,:odue,:odid,:flags,:data)",
    );
    const cardsUpdate = cardsCall?.[1] as Record<string, string>;
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

    const [notesCall] = exporterUpdateSpy.mock.calls as Array<
      [string, Record<string, string>]
    >;
    const notesUpdate = notesCall?.[1] as Record<string, string>;
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

    const [notesCall, cardsCall] = exporterUpdateSpy.mock.calls as Array<
      [string, Record<string, string>]
    >;
    const notesUpdate = notesCall?.[1] as Record<string, string>;
    expect(notesUpdate[":sfld"]).toBe(front);
    expect(notesUpdate[":flds"]).toBe(front + separator + back);
    expect(notesUpdate[":mid"]).toBe(topModelId);
    expect(notesUpdate[":tags"]).toBe(tags);

    const cardsUpdate = cardsCall?.[1] as Record<string, string>;
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
      exporterUpdateSpy.mock.calls as Array<[string, Record<string, string>]>;
    const notesUpdate = firstNotesCall?.[1] as Record<string, string>;
    const secondNotesUpdate = secondNotesCall?.[1] as Record<string, string>;
    expect(notesUpdate[":id"]).toBe(secondNotesUpdate[":id"]);
    expect(notesUpdate[":guid"]).toBe(secondNotesUpdate[":guid"]);
    expect(notesUpdate[":sfld"]).toBe(front);
    expect(notesUpdate[":flds"]).toBe(front + separator + back);
    expect(notesUpdate[":mid"]).toBe(topModelId);

    const cardsUpdate = firstCardsCall?.[1] as Record<string, string>;
    const secondCardsUpdate = secondCardsCall?.[1] as Record<string, string>;
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
