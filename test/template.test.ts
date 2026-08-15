import path from "path";
import { fileURLToPath } from "url";

import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";

import createTemplate from "../src/template.js";

const locateFile = (file: string): string =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/sql.js/dist", file);

/**
 * The template is one big SQL script; the note model lives in a JSON blob in
 * the `col` row. Running it through sql.js is the only honest way to assert on
 * what actually reaches the collection.
 */
const readModel = async (template: string): Promise<Record<string, unknown>> => {
  const sql = await initSqlJs({ locateFile });
  const db = new sql.Database();
  db.run(template);
  const [result] = db.exec("SELECT models FROM col");
  db.close();

  const models = JSON.parse(String(result.values[0][0])) as Record<string, Record<string, unknown>>;
  const [model] = Object.values(models);
  return model;
};

describe("createTemplate", () => {
  it("applies the default question, answer and css formats", async () => {
    const model = await readModel(createTemplate());
    const [tmpl] = model.tmpls as { qfmt: string; afmt: string }[];

    expect(tmpl.qfmt).toBe("{{Front}}");
    expect(tmpl.afmt).toBe('{{FrontSide}}\n\n<hr id="answer">\n\n{{Back}}');
    expect(model.css).toContain("font-family: arial");
  });

  it("treats an empty options object like no options", () => {
    expect(createTemplate({})).toBe(createTemplate());
  });

  it("applies overrides", async () => {
    const model = await readModel(
      createTemplate({
        questionFormat: "Q: {{Front}}",
        answerFormat: "A: {{Back}}",
        css: ".card { color: red; }",
      }),
    );
    const [tmpl] = model.tmpls as { qfmt: string; afmt: string }[];

    expect(tmpl.qfmt).toBe("Q: {{Front}}");
    expect(tmpl.afmt).toBe("A: {{Back}}");
    expect(model.css).toBe(".card { color: red; }");
  });

  it("applies a partial override without dropping the other defaults", async () => {
    const model = await readModel(createTemplate({ css: ".card {}" }));
    const [tmpl] = model.tmpls as { qfmt: string; afmt: string }[];

    expect(model.css).toBe(".card {}");
    expect(tmpl.qfmt).toBe("{{Front}}");
    expect(tmpl.afmt).toBe('{{FrontSide}}\n\n<hr id="answer">\n\n{{Back}}');
  });

  it("creates the schema the exporter writes to", async () => {
    const sql = await initSqlJs({ locateFile });
    const db = new sql.Database();
    db.run(createTemplate());

    const [tables] = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const names = tables.values.map(([name]) => String(name));

    // `col` must be seeded with exactly one row; the exporter updates it in place.
    const [col] = db.exec("SELECT count(*) FROM col");
    db.close();

    expect(names).toEqual(expect.arrayContaining(["cards", "col", "graves", "notes", "revlog"]));
    expect(col.values[0][0]).toBe(1);
  });
});
