import type { Database, SqlJsStatic, SqlValue } from "sql.js";

import { type MediaData, packageDeck, PACKAGE_V2, PACKAGE_V3 } from "./archive.js";
import type { AnkiCard, AnkiDeck, AnkiNote, AnkiNotetype } from "./collection.js";
import { type BuildClock, createTableCollection, declareUnicase } from "./schema18.js";
import {
  buildDeck,
  type CollectionColumns,
  CONF,
  createCollectionScript,
  DCONF,
  DEFAULT_DECK_ID,
  LATEX_POST,
  LATEX_PRE,
} from "./template.js";
import stripHtmlPreservingMediaFilenames, { fieldChecksum } from "./text.js";
import { FIELD_SEPARATOR } from "./wire.js";

/*
 * A whole collection, written: the inverse of `readPackage`.
 *
 * `Exporter` builds one deck of one note type a card at a time and decides
 * every id itself. This takes a collection already described in the reader's
 * own terms, ids included, and writes it as it is. What it adds is only what
 * the collection needs and the description leaves out: the `Default` deck, any
 * parent deck a `::` name implies, and the derived `sfld` and `csum` columns.
 *
 * Package version 2 holds schema 11, where note types, decks and settings are
 * JSON in the `col` row. Version 3 holds schema 18, where they are tables of
 * their own; `schema18.ts` writes those. Notes and cards are the same rows in
 * both.
 *
 * It is strict the way the exporter is. A note naming a note type that is not
 * there, a card naming a note or deck that is not there, or a note with the
 * wrong number of fields is refused rather than written, since Anki would
 * either refuse it at import or quietly repair it into something else.
 */

/** What `writePackage` takes: an `AnkiPackage` minus what a write decides. */
export interface WritableCollection {
  readonly cards: readonly AnkiCard[];
  readonly decks: readonly AnkiDeck[];
  /** Media files by the name card HTML references them by. */
  readonly media?: ReadonlyMap<string, MediaData>;
  readonly notes: readonly AnkiNote[];
  readonly notetypes: readonly AnkiNotetype[];
}

export interface WriteOptions {
  /**
   * The container layout. Version 2 is schema 11 on the v2 scheduler, under
   * `collection.anki21`, which every Anki since 2.1 imports. Version 3 is
   * schema 18, zstd-compressed under `collection.anki21b`, which is what
   * current Anki exports by default and imports from 2.1.50 on.
   */
  readonly packageVersion?: typeof PACKAGE_V2 | typeof PACKAGE_V3;
  /** The epoch-millisecond instant to build at, defaulting to now. */
  readonly now?: number;
}

const MILLISECONDS_PER_SECOND = 1000;
const DECK_NAME_SEPARATOR = "::";
const SCHEDULER_V2 = 2;
/** A new card's `type`, whose `due` is its new-queue position. */
const CARD_TYPE_NEW = 0;

/** Every ancestor of a `::` name, outermost first, then the name itself. */
const deckLineage = (name: string): string[] => {
  const levels = name.split(DECK_NAME_SEPARATOR);

  return levels.map((_level: string, depth: number) =>
    levels.slice(0, depth + 1).join(DECK_NAME_SEPARATOR),
  );
};

/** Schema 11 stores tags space-joined and padded, and no tags as nothing at all. */
const joinTags = (tags: readonly string[]): string => {
  if (tags.length === 0) {
    return "";
  }

  return ` ${tags.join(" ")} `;
};

const buildNotetype = (notetype: Readonly<AnkiNotetype>, mod: number) => ({
  id: notetype.id,
  name: notetype.name,
  /* Schema 11's `type` is 1 for cloze and 0 for everything else. */
  type: Number(notetype.isCloze),
  mod,
  usn: -1,
  sortf: notetype.sortField,
  did: null,
  tmpls: notetype.templates.map(({ name, qfmt, afmt }, ord: number) => ({
    name,
    ord,
    qfmt,
    afmt,
    bqfmt: "",
    bafmt: "",
    did: null,
  })),
  flds: notetype.fields.map((name: string, ord: number) => ({
    name,
    ord,
    sticky: false,
    rtl: false,
    font: "Arial",
    size: 20,
    media: [],
  })),
  css: notetype.css,
  latexPre: notetype.latexPre ?? LATEX_PRE,
  latexPost: notetype.latexPost ?? LATEX_POST,
  latexsvg: notetype.latexSvg ?? false,
  tags: [],
  vers: [],
});

/** The parents a `::` name implies that the collection does not name itself. */
const missingAncestors = (decks: readonly AnkiDeck[]): string[] => {
  const named = new Set(decks.map((deck: Readonly<AnkiDeck>) => deck.name));
  const lineage = new Set(decks.flatMap((deck: Readonly<AnkiDeck>) => deckLineage(deck.name)));

  return [...lineage].filter((name: string) => !named.has(name));
};

/** `Default`, unless the caller already put a deck under its id. */
const defaultDeck = (decks: readonly AnkiDeck[]): AnkiDeck[] => {
  if (decks.some((deck: Readonly<AnkiDeck>) => deck.id === DEFAULT_DECK_ID)) {
    return [];
  }

  return [{ id: DEFAULT_DECK_ID, name: "Default", description: "" }];
};

/**
 * Every deck the cards need: the caller's, each parent a `::` name implies,
 * and `Default`, which both schemas keep under id 1. A missing parent takes
 * the next id above every one the caller used.
 */
const allDecks = (decks: readonly AnkiDeck[]): AnkiDeck[] => {
  const firstFreeId =
    Math.max(DEFAULT_DECK_ID, ...decks.map((deck: Readonly<AnkiDeck>) => deck.id)) + 1;
  const parents = missingAncestors(decks).map((name: string, offset: number) => ({
    id: firstFreeId + offset,
    name,
    description: "",
  }));

  return [...defaultDeck(decks), ...decks, ...parents];
};

const buildDecks = (decks: readonly AnkiDeck[], mod: number) =>
  Object.fromEntries(
    allDecks(decks).map(({ id, name, description }: Readonly<AnkiDeck>) => [
      id,
      buildDeck({ id, name, desc: description, usn: -1, mod }),
    ]),
  );

/**
 * The `col.conf` a fresh collection on the v2 scheduler carries, pointed at
 * the collection's first deck and note type, with `nextPos` past every new
 * card's queue position.
 */
const buildConf = ({ cards, decks, notetypes }: Readonly<WritableCollection>) => {
  const deckId = decks[0]?.id ?? DEFAULT_DECK_ID;
  /* A loop rather than `Math.max(...)`: spreading a large deck's positions
     as arguments overflows the stack. */
  let lastPosition = 0;
  for (const card of cards) {
    if (card.type === CARD_TYPE_NEW) {
      lastPosition = Math.max(lastPosition, card.due);
    }
  }

  return {
    ...CONF,
    nextPos: lastPosition + 1,
    activeDecks: [deckId],
    curDeck: deckId,
    curModel: notetypes[0]?.id ?? 0,
    schedVer: SCHEDULER_V2,
  };
};

const buildColumns = (
  collection: Readonly<WritableCollection>,
  mod: number,
): CollectionColumns => ({
  conf: buildConf(collection),
  models: Object.fromEntries(
    collection.notetypes.map((notetype: Readonly<AnkiNotetype>) => [
      notetype.id,
      buildNotetype(notetype, mod),
    ]),
  ),
  decks: buildDecks(collection.decks, mod),
  dconf: DCONF,
});

/** `sfld` follows the note type's sort field; `csum` is always the first. */
const noteRow = (
  note: Readonly<AnkiNote>,
  notetype: Readonly<AnkiNotetype>,
  mod: number,
): Record<string, SqlValue> => ({
  ":id": note.id,
  ":guid": note.guid,
  ":mid": note.mid,
  ":mod": mod,
  ":usn": -1,
  ":tags": joinTags(note.tags),
  ":flds": note.fields.join(FIELD_SEPARATOR),
  ":sfld": stripHtmlPreservingMediaFilenames(note.fields[notetype.sortField] ?? ""),
  ":csum": fieldChecksum(stripHtmlPreservingMediaFilenames(note.fields[0] ?? "")),
  ":flags": 0,
  ":data": "",
});

const cardRow = (card: Readonly<AnkiCard>, mod: number): Record<string, SqlValue> => ({
  ":id": card.id,
  ":nid": card.nid,
  ":did": card.did,
  ":ord": card.ord,
  ":mod": mod,
  ":usn": -1,
  ":type": card.type,
  ":queue": card.queue,
  ":due": card.due,
  ":ivl": card.ivl,
  ":factor": card.factor,
  ":reps": card.reps,
  ":lapses": card.lapses,
  ":left": 0,
  ":odue": 0,
  ":odid": 0,
  ":flags": 0,
  ":data": "",
});

/** The note type each note names, refusing a note that does not fit one. */
const notetypeOf = (
  notetypes: ReadonlyMap<number, AnkiNotetype>,
  note: Readonly<AnkiNote>,
): AnkiNotetype => {
  const notetype = notetypes.get(note.mid);
  if (notetype === undefined) {
    throw new Error(`Cannot write note ${note.guid}: its note type ${note.mid} is not written`);
  }
  if (note.fields.length !== notetype.fields.length) {
    throw new Error(
      `Cannot write note ${note.guid}: it has ${note.fields.length} fields and note type ${JSON.stringify(notetype.name)} has ${notetype.fields.length}`,
    );
  }

  return notetype;
};

/** Refuse a card whose note or deck is not written alongside it. */
const checkCards = ({ cards, decks, notes }: Readonly<WritableCollection>): void => {
  const noteIds = new Set(notes.map((note: Readonly<AnkiNote>) => note.id));
  const deckIds = new Set(decks.map((deck: Readonly<AnkiDeck>) => deck.id));
  for (const card of cards) {
    if (!noteIds.has(card.nid)) {
      throw new Error(`Cannot write card ${card.id}: its note ${card.nid} is not written`);
    }
    if (!deckIds.has(card.did)) {
      throw new Error(`Cannot write card ${card.id}: its deck ${card.did} is not written`);
    }
  }
};

const insertRows = (db: Database, collection: Readonly<WritableCollection>, mod: number): void => {
  const notetypes = new Map(
    collection.notetypes.map((notetype: Readonly<AnkiNotetype>) => [notetype.id, notetype]),
  );
  for (const note of collection.notes) {
    db.run(
      "insert into notes values(:id,:guid,:mid,:mod,:usn,:tags,:flds,:sfld,:csum,:flags,:data)",
      noteRow(note, notetypeOf(notetypes, note), mod),
    );
  }
  for (const card of collection.cards) {
    db.run(
      "insert into cards values(:id,:nid,:did,:ord,:mod,:usn,:type,:queue,:due,:ivl,:factor,:reps,:lapses,:left,:odue,:odid,:flags,:data)",
      cardRow(card, mod),
    );
  }
};

interface Build extends BuildClock {
  readonly packageVersion: number;
}

/** Schema 18 for package version 3, schema 11 otherwise. */
const fillCollection = (
  db: Database,
  collection: Readonly<WritableCollection>,
  { mod, now, packageVersion }: Readonly<Build>,
): void => {
  if (packageVersion !== PACKAGE_V3) {
    db.run(createCollectionScript(buildColumns(collection, mod), now));
    insertRows(db, collection, mod);

    return;
  }

  createTableCollection(
    db,
    {
      conf: buildConf(collection),
      decks: allDecks(collection.decks),
      notetypes: collection.notetypes,
    },
    { mod, now },
  );
  insertRows(db, collection, mod);
  declareUnicase(db);
};

/** The collection database's bytes. The database lives only for this call. */
const writeCollection = (
  sql: SqlJsStatic,
  collection: Readonly<WritableCollection>,
  { now, packageVersion }: Readonly<Omit<Build, "mod">>,
): Uint8Array => {
  const db = new sql.Database();
  try {
    fillCollection(db, collection, {
      mod: Math.floor(now / MILLISECONDS_PER_SECOND),
      now,
      packageVersion,
    });

    return db.export();
  } finally {
    db.close();
  }
};

/**
 * Write a collection as an `.apkg`, with an already-loaded sql.js.
 *
 * `writeApkg` in the entry point is what a caller wants; this is separated the
 * way `readPackage` is, so the WASM lookup stays in one place.
 */
export const writePackage = (
  sql: SqlJsStatic,
  collection: Readonly<WritableCollection>,
  { packageVersion = PACKAGE_V2, now = Date.now() }: Readonly<WriteOptions> = {},
): Buffer => {
  /* The type says 2 or 3, but a JavaScript caller can pass anything. */
  if (packageVersion !== PACKAGE_V2 && packageVersion !== PACKAGE_V3) {
    throw new Error(
      `Cannot write package version ${String(packageVersion)}: only 2 and 3 are written`,
    );
  }
  checkCards(collection);
  const media = [...(collection.media ?? [])].map(
    ([filename, data]: readonly [string, MediaData]) => ({ filename, data }),
  );

  return packageDeck({
    collection: writeCollection(sql, collection, { now, packageVersion }),
    media,
    createdAt: new Date(now),
    packageVersion,
  });
};
