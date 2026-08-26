import path from "node:path";
import { fileURLToPath } from "node:url";

import initSqlJs, { type SqlJsStatic } from "sql.js";

import Exporter from "./exporter.js";
import { type AnkiPackage, readPackage } from "./reader.js";
import createTemplate, { type TemplateOptions } from "./template.js";

/*
 * Point sql.js at its own `dist/`. It loads the WASM by filename relative to a
 * directory it asks for, so the package has to be found on disk rather than
 * imported, and its `exports` map publishes `./dist/*` for exactly that.
 * `import.meta.resolve` is the ESM way to ask; this previously synthesized a
 * CJS `require` to do the same job, from before that existed.
 */
let sqlJsDist: string | null = null;

const locateFile = (file: string): string => {
  /* Resolved on the first call rather than at import time: the resolution is
     constant for the life of the process, but doing it at module scope would
     turn a missing sql.js install into a failure to import this package at
     all, instead of one at the first `AnkiExport()`. */
  sqlJsDist ??= path.dirname(fileURLToPath(import.meta.resolve("sql.js/dist/sql-wasm.wasm")));

  return path.join(sqlJsDist, file);
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

export type { MediaData, ZipOptions } from "./archive.js";
export type { AnkiCollection, AnkiNote, AnkiNotetype } from "./collection.js";
export { default as Exporter } from "./exporter.js";
export { type AnkiPackage, readPackage } from "./reader.js";
export type { TemplateOptions } from "./template.js";

/**
 * Read an `.apkg` and hand back what is in it: its note types, its notes and
 * its media, as Anki stores them.
 *
 * This is the opposite of `AnkiExport`, and deliberately not its mirror image.
 * The writer emits one layout and is strict about it; the reader has to take
 * three package versions and two schema versions, written by Anki 2.1, by
 * current Anki and by third-party exporters. See `docs/reference/deck-format.md`
 * for what each of those means and which are refused.
 */
export const readApkg = async (apkg: Uint8Array): Promise<AnkiPackage> =>
  readPackage(await getSqlModule(), apkg);

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
