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

/**
 * The WASM compile is the expensive part of building a deck, so it happens once
 * per process and every later call awaits the same module.
 */
let sqlModulePromise: Promise<SqlJsStatic> | null = null;

const loadSqlModule = async (): Promise<SqlJsStatic> => {
  try {
    return await initSqlJs({ locateFile });
  } catch (error) {
    /* Memoizing the promise memoizes a rejection too, which would make one
       transient failure — an exhausted file handle, a compile that lost a race
       with a teardown — the permanent answer for the rest of the process.
       Clear the memo so the next caller retries, and still reject this one. */
    sqlModulePromise = null;
    throw error;
  }
};

const getSqlModule = (): Promise<SqlJsStatic> => {
  sqlModulePromise ??= loadSqlModule();
  return sqlModulePromise;
};

export type { ZipOptions } from "./archive.js";
export { default as Exporter } from "./exporter.js";
export type { TemplateOptions } from "./template.js";

export interface ExportOptions {
  /**
   * The epoch-millisecond instant to build the deck at, defaulting to now.
   * Every timestamp in the archive derives from this one reading, so passing a
   * fixed value makes a deck byte-reproducible across processes and not just
   * within one.
   */
  now?: number;
}

export default async function AnkiExport(
  deckName: string,
  template?: Readonly<TemplateOptions>,
  { now = Date.now() }: Readonly<ExportOptions> = {},
): Promise<Exporter> {
  const sqlModule = await getSqlModule();

  return new Exporter(deckName, {
    template: createTemplate(template, now),
    sql: sqlModule,
    now,
  });
}
