import path from "path";

import initSqlJs, { type SqlValue } from "sql.js";
import { describe, expect, it, vi } from "vitest";

import createTemplate from "../src/template.js";

const locateFile = (file: string): string =>
  path.join(import.meta.dirname, "../node_modules/sql.js/dist", file);

/** The parts of the persisted note model these tests assert on. */
interface TemplateModel {
  css: string;
  tmpls: { qfmt: string; afmt: string }[];
  tags: string[];
  vers: unknown[];
  mod: number;
}

/** 2016-12-25T12:00:00Z, well after that day's 04:00 rollover. */
const NOON_UTC = 1_482_667_200_000;

/** `NOON_UTC` in seconds: the width deck and note-model `mod` use. */
const NOON_UTC_SECONDS = 1_482_667_200;

/** 2016-12-25T04:00:00Z in seconds, the boundary `NOON_UTC` falls after. */
const NOON_UTC_ROLLOVER = 1_482_638_400;

/** 2016-12-25T03:00:00Z, an hour before the rollover. */
const EARLY_UTC = 1_482_634_800_000;

/** 2016-12-24T04:00:00Z: before 04:00 the study day is still the previous one. */
const EARLY_UTC_ROLLOVER = 1_482_552_000;

/** This package emits schema 11 / package version Legacy1 only. */
const SCHEMA_VERSION = 11;

/** Read the scalar `col` columns the collection is stamped with. */
const readCol = async (template: string): Promise<Record<string, number>> => {
  const sql = await initSqlJs({ locateFile });
  const db = new sql.Database();
  db.run(template);
  const [result] = db.exec("SELECT crt, mod, scm, ver FROM col");
  db.close();

  const [crt, mod, scm, ver] = result.values[0].map(Number);
  return { crt, mod, scm, ver };
};

/**
 * The template is one big SQL script; the note model lives in a JSON blob in
 * the `col` row. Running it through sql.js is the only honest way to assert on
 * what actually reaches the collection.
 */
const readModel = async (template: string): Promise<TemplateModel> => {
  const sql = await initSqlJs({ locateFile });
  const db = new sql.Database();
  db.run(template);
  const [result] = db.exec("SELECT models FROM col");
  db.close();

  /* `models` is a JSON text column, so its decoded shape is only known here. */
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const models = JSON.parse(String(result.values[0][0])) as Record<string, TemplateModel>;
  const [model] = Object.values(models);
  return model;
};

/** Read the seeded decks, which live in a JSON blob in the `col` row like the models do. */
const readDecks = async (template: string): Promise<{ readonly mod: number }[]> => {
  const sql = await initSqlJs({ locateFile });
  const db = new sql.Database();
  db.run(template);
  const [result] = db.exec("SELECT decks FROM col");
  db.close();

  /* `decks` is a JSON text column, so its decoded shape is only known here. */
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const decks = JSON.parse(String(result.values[0][0])) as Record<string, { readonly mod: number }>;
  return Object.values(decks);
};

describe("the default note template", () => {
  it("applies the default question, answer and css formats", async () => {
    expect.hasAssertions();
    const model = await readModel(createTemplate());
    const [tmpl] = model.tmpls;

    expect(tmpl.qfmt).toBe("{{Front}}");
    expect(tmpl.afmt).toBe('{{FrontSide}}\n\n<hr id="answer">\n\n{{Back}}');
    expect(model.css).toContain("font-family: arial");
  });

  it("treats an empty options object like no options", () => {
    expect.hasAssertions();

    /* The clock has to be pinned: the two calls stamp their own build time, so
       straddling a millisecond boundary would fail this on timing, not options. */
    vi.useFakeTimers({ now: NOON_UTC, toFake: ["Date"] });
    const [empty, absent] = [createTemplate({}), createTemplate()];
    vi.useRealTimers();

    expect(empty).toBe(absent);
  });

  it("applies overrides", async () => {
    expect.hasAssertions();
    const model = await readModel(
      createTemplate({
        questionFormat: "Q: {{Front}}",
        answerFormat: "A: {{Back}}",
        css: ".card { color: red; }",
      }),
    );
    const [tmpl] = model.tmpls;

    expect(tmpl.qfmt).toBe("Q: {{Front}}");
    expect(tmpl.afmt).toBe("A: {{Back}}");
    expect(model.css).toBe(".card { color: red; }");
  });

  it("applies a partial override without dropping the other defaults", async () => {
    expect.hasAssertions();
    const model = await readModel(createTemplate({ css: ".card {}" }));
    const [tmpl] = model.tmpls;

    expect(model.css).toBe(".card {}");
    expect(tmpl.qfmt).toBe("{{Front}}");
    expect(tmpl.afmt).toBe('{{FrontSide}}\n\n<hr id="answer">\n\n{{Back}}');
  });

  it("creates the schema the exporter writes to", async () => {
    expect.hasAssertions();
    const sql = await initSqlJs({ locateFile });
    const db = new sql.Database();
    db.run(createTemplate());

    const [tables] = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const names = tables.values.map(([name]: readonly SqlValue[]) => String(name));

    /* `col` must be seeded with exactly one row; the exporter updates it in place. */
    const [col] = db.exec("SELECT count(*) FROM col");
    db.close();

    expect(names).toStrictEqual(
      expect.arrayContaining(["cards", "col", "graves", "notes", "revlog"]),
    );
    expect(col.values[0][0]).toBe(1);
  });

  it("stamps the collection with the time it was built", async () => {
    expect.hasAssertions();
    vi.useFakeTimers({ now: NOON_UTC, toFake: ["Date"] });
    const col = await readCol(createTemplate());
    vi.useRealTimers();

    /* `crt` is the day rollover in seconds; `mod` and `scm` are the build
       instant in milliseconds. Anki writes those widths, and a stale 2014
       date here would misdate every day number counted from it. */
    expect(col.crt).toBe(NOON_UTC_ROLLOVER);
    expect(col.mod).toBe(NOON_UTC);
    expect(col.scm).toBe(NOON_UTC);

    // Still schema 11; nothing here moves the deck to a later package version.
    expect(col.ver).toBe(SCHEMA_VERSION);
  });

  it("dates a collection built before the rollover to the previous day", async () => {
    expect.hasAssertions();
    vi.useFakeTimers({ now: EARLY_UTC, toFake: ["Date"] });
    const col = await readCol(createTemplate());
    vi.useRealTimers();

    expect(col.crt).toBe(EARLY_UTC_ROLLOVER);
  });

  it("stamps every deck and the note model with the build time as well", async () => {
    expect.hasAssertions();
    vi.useFakeTimers({ now: NOON_UTC, toFake: ["Date"] });
    const decks = await readDecks(createTemplate());
    const model = await readModel(createTemplate());
    vi.useRealTimers();

    /* These are seconds, not the milliseconds `col.mod` uses. They were frozen
       at July 2015, which dated a brand-new deck two years before its notes. */
    expect(decks.map((deck) => deck.mod)).toStrictEqual([NOON_UTC_SECONDS, NOON_UTC_SECONDS]);
    expect(model.mod).toBe(NOON_UTC_SECONDS);
  });

  it("leaves the note model without the placeholder tag or the misspelled key", async () => {
    expect.hasAssertions();
    const model = await readModel(createTemplate());

    /* `vers` is a dead schema-11 key that this template used to spell
       `veArs`, and the sample tag was never anything a caller asked for. */
    expect(model.tags).toStrictEqual([]);
    expect(model.vers).toStrictEqual([]);
    expect(model).not.toHaveProperty("veArs");
  });
});
