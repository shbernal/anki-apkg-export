import type { SqlJsStatic } from "sql.js";

import { type AnkiCollection, readCollection } from "./collection.js";
import { unpackDeck } from "./unpack.js";

/*
 * The read path's entry point, which is `unpack.ts` handing `collection.ts` a
 * database and putting the media back beside what came out of it.
 *
 * It returns Anki's model and stops there. It does not know what a front is,
 * what a deck of flashcards is for, or that this package can also write one.
 * Anything that maps notes onto some other idea of a card belongs above it.
 */

export interface AnkiPackage extends AnkiCollection {
  /** Media files by the name card HTML references them by. */
  readonly media: ReadonlyMap<string, Uint8Array>;
  /** The container layout: 1, 2 or 3. Says nothing about `schemaVersion`. */
  readonly packageVersion: number;
}

/**
 * Read a package with an already-loaded sql.js.
 *
 * `readApkg` in the entry point is what a caller wants; this is separated the
 * way `Exporter` is, so the WASM lookup stays in one place and a caller holding
 * its own sql.js can skip it.
 */
export const readPackage = (sql: SqlJsStatic, apkg: Uint8Array): AnkiPackage => {
  const { collection, media, packageVersion } = unpackDeck(apkg);
  const db = new sql.Database(collection);

  /* Same contract as `Exporter.close`: the database is WASM memory no garbage
     collector reclaims, and nothing here outlives the call. */
  try {
    return { ...readCollection(db), media, packageVersion };
  } finally {
    db.close();
  }
};
