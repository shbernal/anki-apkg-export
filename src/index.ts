import path from "node:path";
import { fileURLToPath } from "node:url";

import initSqlJs, { type SqlJsStatic } from "sql.js";

import Exporter from "./exporter.js";
import createTemplate, { type TemplateOptions } from "./template.js";

/*
 * Point sql.js at its own `dist/`. It loads the WASM by filename relative to a
 * directory it asks for, so the package has to be found on disk rather than
 * imported, and its `exports` map publishes `./dist/*` for exactly that.
 * `import.meta.resolve` is the ESM way to ask; this previously synthesized a
 * CJS `require` to do the same job, from before that existed.
 */
const locateFile = (file: string): string => {
  const wasmPath = fileURLToPath(import.meta.resolve("sql.js/dist/sql-wasm.wasm"));
  return path.join(path.dirname(wasmPath), file);
};

let sqlModulePromise: Promise<SqlJsStatic> | null = null;
const getSqlModule = (): Promise<SqlJsStatic> => {
  sqlModulePromise ??= initSqlJs({ locateFile });
  return sqlModulePromise;
};

export { default as Exporter } from "./exporter.js";
export type { TemplateOptions } from "./template.js";

export default async function AnkiExport(
  deckName: string,
  template?: Readonly<TemplateOptions>,
): Promise<Exporter> {
  const sqlModule = await getSqlModule();

  return new Exporter(deckName, {
    template: createTemplate(template),
    sql: sqlModule,
  });
}
