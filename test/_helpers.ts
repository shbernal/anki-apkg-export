import { promises as fs } from "fs";
import path from "path";

import { unzipSync } from "fflate";
import type { Database, SqlValue } from "sql.js";

interface Card {
  front: string;
  back: string;
}

/**
 * Run a query against a live collection and return its rows as objects.
 *
 * Tests assert on the rows the exporter wrote rather than on the calls that
 * wrote them, and sql.js hands back a column list plus a grid of values. Doing
 * that zip once keeps `noUncheckedIndexedAccess` from pushing optional chaining
 * into the assertions themselves, where a silently `undefined` expectation is a
 * test that has quietly stopped testing.
 */
export const readRows = (db: Readonly<Database>, query: string): Record<string, SqlValue>[] => {
  /* `exec` returns one result set per statement, and every query here is a
     single statement — so no result set at all means no matching rows. */
  const [result] = db.exec(query);
  const columns = result?.columns ?? [];

  return (result?.values ?? []).map((row: readonly SqlValue[]) =>
    Object.fromEntries(
      columns.map((column: string, index: number) => [column, row[index] ?? null]),
    ),
  );
};

/** The one row a query is expected to return, or a loud failure. */
export const readRow = (db: Readonly<Database>, query: string): Record<string, SqlValue> => {
  const [row] = readRows(db, query);
  if (row === undefined) {
    throw new Error(`Query returned no rows: ${query}`);
  }

  return row;
};

/**
 * The first element, or a loud failure. Under `noUncheckedIndexedAccess` every
 * `const [x] = xs` is optional, and a test asserting against `undefined` passes
 * for the wrong reason.
 */
export const first = <TItem>(items: readonly TItem[], describeItem: string): TItem => {
  const [item] = items;
  if (item === undefined) {
    throw new Error(`Expected at least one ${describeItem}`);
  }

  return item;
};

export const addCards = (
  apkg: Readonly<{ addCard: (front: string, back: string) => void }>,
  list: readonly Readonly<Card>[],
): void => {
  list.forEach(({ front, back }: Readonly<Card>) => {
    apkg.addCard(front, back);
  });
};

/** Reads a saved deck without touching the filesystem. */
export const unzipDeckToBuffers = (deck: Buffer): Map<string, Buffer> => {
  const entries = Object.entries(unzipSync(deck)).filter(
    ([name]: readonly [string, Uint8Array]) => !name.endsWith("/"),
  );

  return new Map(
    entries.map(([name, data]: readonly [string, Uint8Array]) => [name, Buffer.from(data)]),
  );
};

export const unzipDeckToDir = async (pathToDeck: string, pathToUnzipTo: string): Promise<void> => {
  await fs.mkdir(pathToUnzipTo, { recursive: true });
  const files = unzipDeckToBuffers(await fs.readFile(pathToDeck));

  await Promise.all(
    [...files].map(async ([name, data]: readonly [string, Buffer]) => {
      const filePath = path.join(pathToUnzipTo, name);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, data);
    }),
  );
};
