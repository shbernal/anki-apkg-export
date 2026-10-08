import type { Database, SqlValue } from "sql.js";

import { bytesField, stringField, varintField } from "./protobuf.js";
import { FIELD_SEPARATOR } from "./wire.js";

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

/** `Notetype.Config`: `kind`, whose value 1 is `CLOZE`, the sort field, the CSS and the LaTeX settings. */
const NOTETYPE_KIND_FIELD = 1;
const NOTETYPE_KIND_CLOZE = 1;
const NOTETYPE_SORT_FIELD = 2;
const NOTETYPE_CSS_FIELD = 3;
const NOTETYPE_LATEX_PRE_FIELD = 5;
const NOTETYPE_LATEX_POST_FIELD = 6;
const NOTETYPE_LATEX_SVG_FIELD = 7;

/** `Notetype.Template.Config`: the question and answer formats. */
const TEMPLATE_QFMT_FIELD = 1;
const TEMPLATE_AFMT_FIELD = 2;

/** `Deck.KindContainer.normal`, and `Deck.Normal.description` inside it. */
const DECK_NORMAL_FIELD = 1;
const DECK_DESCRIPTION_FIELD = 4;

/** Schema 18 joins deck levels with this; schema 11 and Anki's UI use `::`. */
const DECK_LEVEL_SEPARATOR = "\u001F";
const DECK_NAME_SEPARATOR = "::";

/** Schema 11 spells the same thing `models[].type`. */
const LEGACY_SCHEMA = 11;
const LEGACY_MODEL_CLOZE = 1;

/** The first schema that keeps note types in tables of their own. */
const TABLE_SCHEMA = 18;

/** One card template: what Anki renders for one `ord` of a note. */
export interface AnkiTemplate {
  readonly afmt: string;
  readonly name: string;
  readonly qfmt: string;
}

export interface AnkiNotetype {
  readonly css: string;
  readonly fields: readonly string[];
  readonly id: number;
  /** Cloze note types have no front and back, which is what makes them special. */
  readonly isCloze: boolean;
  /**
   * The LaTeX header and footer a `[latex]` field is rendered between. A
   * reader always fills them in; a writer given none uses Anki's defaults.
   */
  readonly latexPost?: string;
  readonly latexPre?: string;
  /**
   * Whether rendered LaTeX is `.svg` rather than `.png`. The extension is part
   * of the file name a note looks for, so dropping this breaks the images.
   */
  readonly latexSvg?: boolean;
  readonly name: string;
  /** The index of the field the browser sorts by. */
  readonly sortField: number;
  /** In `ord` order. A cloze note type has one, whatever its card count. */
  readonly templates: readonly AnkiTemplate[];
}

export interface AnkiNote {
  /** The field values, in the order its note type declares them. */
  readonly fields: readonly string[];
  /** The id that survives export and import, unlike `id`. */
  readonly guid: string;
  readonly id: number;
  /** The id of the note type this note belongs to. */
  readonly mid: number;
  readonly tags: readonly string[];
}

/** A card's row, scheduling values as stored rather than as displayed. */
export interface AnkiCard {
  /** The deck it is in. */
  readonly did: number;
  readonly due: number;
  readonly factor: number;
  readonly id: number;
  readonly ivl: number;
  readonly lapses: number;
  /** The note it belongs to. */
  readonly nid: number;
  /** Which template, or for a cloze which cloze number less one, it shows. */
  readonly ord: number;
  readonly queue: number;
  readonly reps: number;
  readonly type: number;
}

export interface AnkiDeck {
  readonly description: string;
  readonly id: number;
  /** The full name, levels joined by `::` whichever schema stored it. */
  readonly name: string;
}

export interface AnkiCollection {
  readonly cards: readonly AnkiCard[];
  readonly decks: readonly AnkiDeck[];
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

/** A blob column, whose type from sql.js is every type a cell can have. */
const blobOf = (value: SqlValue | undefined): Uint8Array => {
  if (value instanceof Uint8Array) {
    return value;
  }

  return new Uint8Array();
};

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
    result.values.map((row: readonly SqlValue[]) => {
      const entries = result.columns.map((column: string, index: number) => [column, row[index]]);

      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return Object.fromEntries(entries) as Row;
    }),
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
  readRows(db, "SELECT id, guid, mid, flds, tags FROM notes").map((row: Row) => ({
    fields: String(row.flds).split(FIELD_SEPARATOR),
    guid: String(row.guid),
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
  [...fields].sort(byOrd).map((field: Readonly<NamedField>) => field.name);

const templatesInOrder = (templates: readonly LegacyTemplate[]): AnkiTemplate[] =>
  [...templates]
    .sort(byOrd)
    .map(({ afmt, name, qfmt }: Readonly<LegacyTemplate>) => ({ afmt, name, qfmt }));

const CARD_COLUMNS = "id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses";

const readCards = (db: Database): AnkiCard[] =>
  readRows(db, `SELECT ${CARD_COLUMNS} FROM cards`).map((row: Row) => ({
    did: Number(row.did),
    due: Number(row.due),
    factor: Number(row.factor),
    id: Number(row.id),
    ivl: Number(row.ivl),
    lapses: Number(row.lapses),
    nid: Number(row.nid),
    ord: Number(row.ord),
    queue: Number(row.queue),
    reps: Number(row.reps),
    type: Number(row.type),
  }));

/** Something either schema keeps at a position: a field, or a template. */
interface Ordered {
  readonly ord: number;
}

const byOrd = (left: Readonly<Ordered>, right: Readonly<Ordered>): number => left.ord - right.ord;

/** One template as schema 11 serializes it into a model's `tmpls`. */
interface LegacyTemplate extends Ordered {
  readonly afmt: string;
  readonly name: string;
  readonly qfmt: string;
}

/** One model as schema 11 serializes it into `col.models`. */
interface LegacyModel {
  readonly css: string;
  /** A string of digits from some older tools; Anki reads either. */
  readonly id: number | string;
  readonly latexPost: string;
  readonly latexPre: string;
  /** Absent from collections older than SVG support. */
  readonly latexsvg?: boolean;
  readonly name: string;
  readonly sortf: number;
  readonly tmpls: readonly LegacyTemplate[];
  readonly type: number;
  readonly flds: readonly NamedField[];
}

/** One deck as schema 11 serializes it into `col.decks`. */
interface LegacyDeck {
  readonly desc?: string;
  /** A string of digits from some older tools; Anki reads either. */
  readonly id: number | string;
  readonly name: string;
}

/**
 * A JSON column of `col` holding an object keyed by id, as its values.
 *
 * The JSON is the collection's own. Same boundary as the media manifest in
 * unpack.ts: checked for being an object, then asserted rather than guarded.
 */
const readLegacyMap = <Value>(db: Database, column: string): Value[] => {
  const row = readRow(db, `SELECT ${column} FROM col`);
  const parsed: unknown = JSON.parse(String(row[column]));

  /* Enough to know `Object.values` has something to walk. `null` and a JSON
     scalar both reach it otherwise and throw a `TypeError` naming neither the
     column nor the collection. */
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Malformed collection: col.${column} does not hold a map by id`);
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return Object.values(parsed as Record<string, Value>);
};

const readLegacyNotetypes = (db: Database): AnkiNotetype[] =>
  readLegacyMap<LegacyModel>(db, "models").map((model: Readonly<LegacyModel>) => ({
    css: model.css,
    fields: fieldNamesInOrder(model.flds),
    id: Number(model.id),
    isCloze: model.type === LEGACY_MODEL_CLOZE,
    latexPost: model.latexPost,
    latexPre: model.latexPre,
    latexSvg: model.latexsvg ?? false,
    name: model.name,
    sortField: model.sortf,
    templates: templatesInOrder(model.tmpls),
  }));

const readLegacyDecks = (db: Database): AnkiDeck[] =>
  readLegacyMap<LegacyDeck>(db, "decks").map((deck: Readonly<LegacyDeck>) => ({
    description: deck.desc ?? "",
    id: Number(deck.id),
    name: deck.name,
  }));

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

/** One `templates` row, its formats out of the config blob. */
const templateOf = (row: Row): LegacyTemplate => {
  const config = blobOf(row.config);

  return {
    afmt: stringField(config, TEMPLATE_AFMT_FIELD),
    name: String(row.name),
    ord: Number(row.ord),
    qfmt: stringField(config, TEMPLATE_QFMT_FIELD),
  };
};

/** Templates by note type id, the same way and for the same reason as fields. */
const readTemplates = (db: Database): Map<number, AnkiTemplate[]> => {
  const byNotetype = new Map<number, LegacyTemplate[]>();

  for (const row of readRows(db, "SELECT ntid, ord, name, config FROM templates")) {
    const ntid = Number(row.ntid);
    const found = byNotetype.get(ntid) ?? [];
    found.push(templateOf(row));
    byNotetype.set(ntid, found);
  }

  const templates = new Map<number, AnkiTemplate[]>();

  for (const [ntid, found] of byNotetype) {
    templates.set(ntid, templatesInOrder(found));
  }

  return templates;
};

const readTableNotetypes = (db: Database): AnkiNotetype[] => {
  const names = readFieldNames(db);
  const templates = readTemplates(db);

  /*
   * A plain scan. It may well run over the unique index on `name`, which is
   * fine: a full scan of an index visits every entry whatever order it is in.
   * A lookup *by* name would not be, because it would seek with the wrong
   * collation, so nothing here searches a collated column.
   */
  return readRows(db, "SELECT id, name, config FROM notetypes").map((row: Row) => {
    const id = Number(row.id);
    const config = blobOf(row.config);

    return {
      css: stringField(config, NOTETYPE_CSS_FIELD),
      /* `fields` outlives the note types it belongs to: an export carries rows
         for ids that have no notetype, so this reads from the note type out. A
         note type with no rows at all is a collection missing them, and it
         comes back with no fields rather than with somebody else's. */
      fields: names.get(id) ?? [],
      id,
      isCloze: varintField(config, NOTETYPE_KIND_FIELD) === NOTETYPE_KIND_CLOZE,
      latexPost: stringField(config, NOTETYPE_LATEX_POST_FIELD),
      latexPre: stringField(config, NOTETYPE_LATEX_PRE_FIELD),
      latexSvg: varintField(config, NOTETYPE_LATEX_SVG_FIELD) === 1,
      name: String(row.name),
      sortField: varintField(config, NOTETYPE_SORT_FIELD) ?? 0,
      templates: templates.get(id) ?? [],
    };
  });
};

/**
 * Schema 18's decks. A filtered deck has no description to read: its `kind`
 * holds `filtered` rather than `normal`, and that message has no such field.
 */
const readTableDecks = (db: Database): AnkiDeck[] =>
  readRows(db, "SELECT id, name, kind FROM decks").map((row: Row) => ({
    description: stringField(
      bytesField(blobOf(row.kind), DECK_NORMAL_FIELD),
      DECK_DESCRIPTION_FIELD,
    ),
    id: Number(row.id),
    name: String(row.name).split(DECK_LEVEL_SEPARATOR).join(DECK_NAME_SEPARATOR),
  }));

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

    return {
      cards: readCards(db),
      decks: readTableDecks(db),
      notes: readNotes(db),
      notetypes: readTableNotetypes(db),
      schemaVersion,
    };
  }

  return {
    cards: readCards(db),
    decks: readLegacyDecks(db),
    notes: readNotes(db),
    notetypes: readLegacyNotetypes(db),
    schemaVersion,
  };
};
