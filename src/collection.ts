import type { Database, SqlValue } from "sql.js";

import { FIELD_SEPARATOR } from "./exporter.js";
import { varintField } from "./protobuf.js";

/*
 * A collection database, read.
 *
 * Anki has kept two entirely different layouts for note types. Schema 11 keeps
 * them as a JSON blob in `col.models`; schema 18 keeps them in `notetypes`,
 * `fields` and `templates`. These are two readers rather than one reader with a
 * branch, and the only thing they share is the row shape they return.
 *
 * Notes are the same in both, which is the whole reason a mapping on top of
 * this can be simple.
 */

/** `NotetypeConfig.kind`, whose value 1 is `CLOZE`. Schema 18 only. */
const NOTETYPE_KIND_FIELD = 1;
const NOTETYPE_KIND_CLOZE = 1;

/** Schema 11 spells the same thing `models[].type`. */
const LEGACY_SCHEMA = 11;
const LEGACY_MODEL_CLOZE = 1;

/** The first schema that keeps note types in tables of their own. */
const TABLE_SCHEMA = 18;

export interface AnkiNotetype {
  readonly fields: readonly string[];
  readonly id: number;
  /** Cloze note types have no front and back, which is what makes them special. */
  readonly isCloze: boolean;
  readonly name: string;
}

export interface AnkiNote {
  /** The field values, in the order its note type declares them. */
  readonly fields: readonly string[];
  readonly id: number;
  /** The id of the note type this note belongs to. */
  readonly mid: number;
  readonly tags: readonly string[];
}

export interface AnkiCollection {
  readonly notes: readonly AnkiNote[];
  readonly notetypes: readonly AnkiNotetype[];
  readonly schemaVersion: number;
}

/**
 * Schema 18 declares six tables `COLLATE unicase`, a collation only Anki's own
 * Rust registers. Three of them are `WITHOUT ROWID`, so the collation sits in
 * the b-tree key and *every* query against them fails with `no query solution`,
 * not just an `ORDER BY`. Field names live only in `fields`, so schema 18 is
 * unreadable until the clause goes.
 *
 * `RESET` rather than `OFF`: `OFF` leaves the schema SQLite already parsed in
 * memory, and a later query that picks an index still reaches for the collation
 * it remembers. That failure is worse than an error, because a covering-index
 * scan can quietly return fewer rows than the table holds.
 *
 * What survives the strip is ordering. `fields` and `templates` key on
 * `(ntid, ord)`, both integers, so their b-trees are unaffected. `tags` keys on
 * the collated text, so its rows come back in an order that is not the declared
 * one, and nothing here relies on SQL order for anything.
 */
const stripUnicase = (db: Database): void => {
  db.exec("PRAGMA writable_schema=ON");
  db.exec(
    "UPDATE sqlite_master SET sql = replace(sql, ' COLLATE unicase', '') WHERE sql LIKE '%unicase%'",
  );
  db.exec("PRAGMA writable_schema=RESET");
};

type Row = Readonly<Record<string, SqlValue>>;

/** The `QueryExecResult` of sql.js, restated deeply readonly: nothing writes it. */
interface ExecResult {
  readonly columns: readonly string[];
  readonly values: readonly (readonly SqlValue[])[];
}

/**
 * Rows as objects, since sql.js hands back a column list and a grid of values.
 *
 * The keys are the column list written in the query itself, which is why the
 * result is asserted rather than guarded: a guard here would be checking that
 * SQLite returned the columns it was asked for. Every column read below is also
 * `NOT NULL` in Anki's own schema, so the reads coerce with `Number` and
 * `String` rather than defend; a value that really were missing would come back
 * as `NaN` or the string "undefined", which is loud.
 */
const readRows = (db: Database, query: string): Row[] =>
  db.exec(query).flatMap((result: ExecResult) =>
    result.values.map(
      (row: readonly SqlValue[]) =>
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        Object.fromEntries(
          result.columns.map((column: string, index: number) => [column, row[index]]),
        ) as Row,
    ),
  );

/** The one row a query is expected to return, or a collection that has no `col`. */
const readRow = (db: Database, query: string): Row => {
  const [row] = readRows(db, query);

  if (row === undefined) {
    throw new Error(`Malformed collection: "${query}" returned no rows`);
  }

  return row;
};

/** Anki writes a note's tags as one space-delimited string, padded either side. */
const splitTags = (tags: string): string[] => tags.split(/\s+/u).filter((tag) => tag !== "");

const readNotes = (db: Database): AnkiNote[] =>
  readRows(db, "SELECT id, mid, flds, tags FROM notes").map((row: Row) => ({
    fields: String(row.flds).split(FIELD_SEPARATOR),
    id: Number(row.id),
    mid: Number(row.mid),
    tags: splitTags(String(row.tags)),
  }));

/** A field as either schema declares it: a name and the position it sits at. */
interface NamedField {
  readonly name: string;
  readonly ord: number;
}

/**
 * Field names in the order the note type declares them.
 *
 * The two schemas disagree about where fields are kept and agree about this,
 * so it is stated once. Ordered in JS rather than by `ORDER BY`, because
 * schema 18's `fields` is one of the tables whose collation is stripped and
 * nothing here searches a collated column.
 */
const fieldNamesInOrder = (fields: readonly NamedField[]): string[] =>
  [...fields]
    .sort((left: Readonly<NamedField>, right: Readonly<NamedField>) => left.ord - right.ord)
    .map((field: Readonly<NamedField>) => field.name);

/** One model as schema 11 serializes it into `col.models`. */
interface LegacyModel {
  readonly id: number;
  readonly name: string;
  readonly type: number;
  readonly flds: readonly NamedField[];
}

const readLegacyNotetypes = (db: Database): AnkiNotetype[] => {
  const row = readRow(db, "SELECT models FROM col");
  const parsed: unknown = JSON.parse(String(row.models));

  /* Enough to know `Object.values` has something to walk. `null` and a JSON
     scalar both reach it otherwise and throw a `TypeError` naming neither the
     column nor the collection. */
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Malformed collection: col.models does not hold a note type map");
  }

  /* `col.models` is the collection's own JSON. Same boundary as the media
     manifest in unpack.ts: asserted here rather than guarded. */
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const models = parsed as Record<string, LegacyModel>;

  return Object.values(models).map((model: Readonly<LegacyModel>) => ({
    fields: fieldNamesInOrder(model.flds),
    id: model.id,
    isCloze: model.type === LEGACY_MODEL_CLOZE,
    name: model.name,
  }));
};

/** Field names by note type id, gathered a row at a time and then ordered. */
const readFieldNames = (db: Database): Map<number, string[]> => {
  const byNotetype = new Map<number, NamedField[]>();

  for (const row of readRows(db, "SELECT ntid, ord, name FROM fields")) {
    const ntid = Number(row.ntid);
    const found = byNotetype.get(ntid) ?? [];
    found.push({ name: String(row.name), ord: Number(row.ord) });
    byNotetype.set(ntid, found);
  }

  const names = new Map<number, string[]>();

  for (const [ntid, fields] of byNotetype) {
    names.set(ntid, fieldNamesInOrder(fields));
  }

  return names;
};

/** `notetypes.config`, whose column is a blob but whose type from sql.js is not. */
const configOf = (row: Row): Uint8Array => {
  if (row.config instanceof Uint8Array) {
    return row.config;
  }

  return new Uint8Array();
};

const readTableNotetypes = (db: Database): AnkiNotetype[] => {
  const names = readFieldNames(db);

  /*
   * A plain scan. It may well run over the unique index on `name`, which is
   * fine: a full scan of an index visits every entry whatever order it is in.
   * A lookup *by* name would not be, because it would seek with the wrong
   * collation, so nothing here searches a collated column.
   */
  return readRows(db, "SELECT id, name, config FROM notetypes").map((row: Row) => {
    const id = Number(row.id);

    return {
      /* `fields` outlives the note types it belongs to: an export carries rows
         for ids that have no notetype, so this reads from the note type out. A
         note type with no rows at all is a collection missing them, and it
         comes back with no fields rather than with somebody else's. */
      fields: names.get(id) ?? [],
      id,
      isCloze: varintField(configOf(row), NOTETYPE_KIND_FIELD) === NOTETYPE_KIND_CLOZE,
      name: String(row.name),
    };
  });
};

/**
 * Read one open collection.
 *
 * Which layout to expect comes from `col.ver` and never from the filename it
 * was opened under. A user's own profile is a bare `collection.anki2` holding
 * schema 18, so the name implies nothing at all.
 */
export const readCollection = (db: Database): AnkiCollection => {
  const schemaVersion = Number(readRow(db, "SELECT ver FROM col").ver);

  /* `Number.isInteger` first: a `ver` that is not a number makes every
     comparison below false, so the guard would pass a `NaN` through and the
     collection would be read as schema 11. */
  if (
    !Number.isInteger(schemaVersion) ||
    (schemaVersion !== LEGACY_SCHEMA && schemaVersion < TABLE_SCHEMA)
  ) {
    throw new Error(
      `Unsupported collection schema version ${schemaVersion}: this reads 11 and 18 or newer. ` +
        `Open the collection in Anki once, which upgrades it, and export again.`,
    );
  }

  if (schemaVersion >= TABLE_SCHEMA) {
    stripUnicase(db);

    return { notes: readNotes(db), notetypes: readTableNotetypes(db), schemaVersion };
  }

  return { notes: readNotes(db), notetypes: readLegacyNotetypes(db), schemaVersion };
};
