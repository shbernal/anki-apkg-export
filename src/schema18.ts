import type { Database } from "sql.js";

import type { AnkiDeck, AnkiNotetype, AnkiTemplate } from "./collection.js";
import { writeMessage } from "./protobuf.js";
import {
  COL_TABLE,
  dayRollover,
  LATEX_POST,
  LATEX_PRE,
  NOTE_INDEXES,
  NOTE_TABLES,
} from "./template.js";

/*
 * A schema-18 collection, which is what a version 3 package carries.
 *
 * Notes and cards are the rows schema 11 has. What moves is everything the
 * `col` row used to hold as JSON: note types, their fields and templates,
 * decks, deck options and collection settings each get a table, and their
 * settings are protobuf messages from Anki's `proto/anki/` rather than JSON.
 *
 * Six of those tables are declared `COLLATE unicase`, a collation only Anki's
 * own Rust registers, and sql.js has no way to register one. They are built
 * under `NOCASE` instead and the declaration is rewritten afterwards, the
 * reverse of what the reader does to open them. The two agree on every ASCII
 * name, so the indexes come out in the order Anki keeps them. A name with a
 * cased letter outside ASCII may sit out of unicase order in its index, which
 * nothing an import does by scanning those tables depends on.
 */

const TABLE_SCHEMA = 18;

/** Anki's own DDL for the tables schema 18 adds, as it writes them. */
const TABLES = `${COL_TABLE}${NOTE_TABLES}${NOTE_INDEXES}
    CREATE TABLE deck_config (
        id integer PRIMARY KEY NOT NULL,
        name text NOT NULL COLLATE unicase,
        mtime_secs integer NOT NULL,
        usn integer NOT NULL,
        config blob NOT NULL
    );
    CREATE TABLE config (
        KEY text NOT NULL PRIMARY KEY,
        usn integer NOT NULL,
        mtime_secs integer NOT NULL,
        val blob NOT NULL
    ) without rowid;
    CREATE TABLE fields (
        ntid integer NOT NULL,
        ord integer NOT NULL,
        name text NOT NULL COLLATE unicase,
        config blob NOT NULL,
        PRIMARY KEY (ntid, ord)
    ) without rowid;
    CREATE UNIQUE INDEX idx_fields_name_ntid ON fields (name, ntid);
    CREATE TABLE templates (
        ntid integer NOT NULL,
        ord integer NOT NULL,
        name text NOT NULL COLLATE unicase,
        mtime_secs integer NOT NULL,
        usn integer NOT NULL,
        config blob NOT NULL,
        PRIMARY KEY (ntid, ord)
    ) without rowid;
    CREATE UNIQUE INDEX idx_templates_name_ntid ON templates (name, ntid);
    CREATE INDEX idx_templates_usn ON templates (usn);
    CREATE TABLE notetypes (
        id integer NOT NULL PRIMARY KEY,
        name text NOT NULL COLLATE unicase,
        mtime_secs integer NOT NULL,
        usn integer NOT NULL,
        config blob NOT NULL
    );
    CREATE UNIQUE INDEX idx_notetypes_name ON notetypes (name);
    CREATE INDEX idx_notetypes_usn ON notetypes (usn);
    CREATE TABLE decks (
        id integer PRIMARY KEY NOT NULL,
        name text NOT NULL COLLATE unicase,
        mtime_secs integer NOT NULL,
        usn integer NOT NULL,
        common blob NOT NULL,
        kind blob NOT NULL
    );
    CREATE UNIQUE INDEX idx_decks_name ON decks (name);
    CREATE INDEX idx_notes_mid ON notes (mid);
    CREATE INDEX idx_cards_odid ON cards (odid) WHERE odid != 0;
    CREATE TABLE tags (
        tag text NOT NULL PRIMARY KEY COLLATE unicase,
        usn integer NOT NULL,
        collapsed boolean NOT NULL,
        config blob NULL
    ) without rowid;
    CREATE TABLE graves (
        oid integer NOT NULL,
        type integer NOT NULL,
        usn integer NOT NULL,
        PRIMARY KEY (oid, type)
    ) WITHOUT ROWID;
    CREATE INDEX idx_graves_pending ON graves (usn);`;

const UNICASE = " COLLATE unicase";
const BUILD_COLLATION = " COLLATE NOCASE";

/** `Notetype.Config`. `kind` is 1 for cloze and 0 for normal, as in schema 11. */
const NOTETYPE_KIND_FIELD = 1;
const NOTETYPE_SORT_FIELD = 2;
const NOTETYPE_CSS_FIELD = 3;
const NOTETYPE_LATEX_PRE_FIELD = 5;
const NOTETYPE_LATEX_POST_FIELD = 6;
const NOTETYPE_LATEX_SVG_FIELD = 7;

/** `Notetype.Field.Config`: the editor font schema 11 writes as `font` and `size`. */
const FIELD_FONT_NAME_FIELD = 3;
const FIELD_FONT_SIZE_FIELD = 4;
const FIELD_FONT_SIZE = 20;

/** `Notetype.Template.Config`. */
const TEMPLATE_QFMT_FIELD = 1;
const TEMPLATE_AFMT_FIELD = 2;

/** `Deck.KindContainer.normal`, and `config_id` and `description` inside it. */
const DECK_NORMAL_FIELD = 1;
const DECK_CONFIG_ID_FIELD = 1;
const DECK_DESCRIPTION_FIELD = 4;

/** Schema 18 joins deck levels with this, where the model says `::`. */
const DECK_LEVEL_SEPARATOR = "\u001F";
const DECK_NAME_SEPARATOR = "::";

/** The one deck options preset, which every deck here uses. */
const DEFAULT_DECK_CONFIG_ID = 1;

/**
 * `DeckConfig.Config` for the `Default` preset, byte for byte as Anki 25
 * writes it into a new collection: 20 new cards and 200 reviews a day, learning
 * steps of 1 and 10 minutes, a starting ease of 2.5. Schema 11's `DCONF` is the
 * same preset in that schema's terms.
 */
const DEFAULT_DECK_CONFIG = Uint8Array.from(
  Buffer.from(
    "0a080000803f00002041120400002041221c0000803f0000803f0000803f0000803f0000803f0000803f" +
      "0000803f481450c8015d00002040656666a63f6d9a99993f7d0000803f8001949d02880101900101980104" +
      "a80101b00108c0013cad026666663fc5026666663fe00201",
    "hex",
  ),
);

/** What a schema-18 collection holds outside `notes` and `cards`. */
export interface TableCollection {
  /** Collection settings, one `config` row per key, each value as JSON. */
  readonly conf: Readonly<Record<string, unknown>>;
  /** Every deck written, `Default` and implied parents included. */
  readonly decks: readonly AnkiDeck[];
  readonly notetypes: readonly AnkiNotetype[];
}

const notetypeConfig = (notetype: Readonly<AnkiNotetype>): Uint8Array =>
  writeMessage([
    [NOTETYPE_KIND_FIELD, notetype.isCloze],
    [NOTETYPE_SORT_FIELD, notetype.sortField],
    [NOTETYPE_CSS_FIELD, notetype.css],
    [NOTETYPE_LATEX_PRE_FIELD, notetype.latexPre ?? LATEX_PRE],
    [NOTETYPE_LATEX_POST_FIELD, notetype.latexPost ?? LATEX_POST],
    [NOTETYPE_LATEX_SVG_FIELD, notetype.latexSvg ?? false],
  ]);

const FIELD_CONFIG = writeMessage([
  [FIELD_FONT_NAME_FIELD, "Arial"],
  [FIELD_FONT_SIZE_FIELD, FIELD_FONT_SIZE],
]);

const insertNotetype = (db: Database, notetype: Readonly<AnkiNotetype>, mod: number): void => {
  db.run("INSERT INTO notetypes VALUES (?, ?, ?, -1, ?)", [
    notetype.id,
    notetype.name,
    mod,
    notetypeConfig(notetype),
  ]);
  notetype.fields.forEach((name: string, ord: number) => {
    db.run("INSERT INTO fields VALUES (?, ?, ?, ?)", [notetype.id, ord, name, FIELD_CONFIG]);
  });
  notetype.templates.forEach(({ afmt, name, qfmt }: Readonly<AnkiTemplate>, ord: number) => {
    db.run("INSERT INTO templates VALUES (?, ?, ?, ?, -1, ?)", [
      notetype.id,
      ord,
      name,
      mod,
      writeMessage([
        [TEMPLATE_QFMT_FIELD, qfmt],
        [TEMPLATE_AFMT_FIELD, afmt],
      ]),
    ]);
  });
};

const insertDeck = (db: Database, deck: Readonly<AnkiDeck>, mod: number): void => {
  const kind = writeMessage([
    [
      DECK_NORMAL_FIELD,
      writeMessage([
        [DECK_CONFIG_ID_FIELD, DEFAULT_DECK_CONFIG_ID],
        [DECK_DESCRIPTION_FIELD, deck.description],
      ]),
    ],
  ]);

  db.run("INSERT INTO decks VALUES (?, ?, ?, -1, ?, ?)", [
    deck.id,
    deck.name.split(DECK_NAME_SEPARATOR).join(DECK_LEVEL_SEPARATOR),
    mod,
    new Uint8Array(),
    kind,
  ]);
};

/** The instant a collection is built at: `mod` in seconds, `now` in milliseconds. */
export interface BuildClock {
  readonly mod: number;
  readonly now: number;
}

/**
 * Create the schema and fill in everything but notes and cards, which share
 * schema 11's tables and rows.
 */
export const createTableCollection = (
  db: Database,
  { conf, decks, notetypes }: Readonly<TableCollection>,
  { mod, now }: Readonly<BuildClock>,
): void => {
  db.run(TABLES.replaceAll(UNICASE, BUILD_COLLATION));
  db.run("INSERT INTO col VALUES (1, ?, ?, ?, ?, 0, 0, 0, '', '', '', '', '')", [
    dayRollover(now),
    now,
    now,
    TABLE_SCHEMA,
  ]);
  for (const [key, value] of Object.entries(conf)) {
    db.run("INSERT INTO config VALUES (?, 0, 0, ?)", [
      key,
      new TextEncoder().encode(JSON.stringify(value)),
    ]);
  }
  db.run("INSERT INTO deck_config VALUES (?, 'Default', 0, 0, ?)", [
    DEFAULT_DECK_CONFIG_ID,
    DEFAULT_DECK_CONFIG,
  ]);
  for (const notetype of notetypes) {
    insertNotetype(db, notetype, mod);
  }
  for (const deck of decks) {
    insertDeck(db, deck, mod);
  }
};

/**
 * Put back the collation Anki declares. Last, because from here on SQLite
 * cannot touch those tables without it.
 */
export const declareUnicase = (db: Database): void => {
  db.exec("PRAGMA writable_schema=ON");
  db.run("UPDATE sqlite_master SET sql = replace(sql, ?, ?) WHERE sql LIKE ?", [
    BUILD_COLLATION,
    UNICASE,
    `%${BUILD_COLLATION}%`,
  ]);
  db.exec("PRAGMA writable_schema=RESET");
};
