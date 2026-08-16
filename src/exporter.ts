import { createHash } from "crypto";

import { strToU8, type ZipOptions, type Zippable, zipSync } from "fflate";
import type { Database, SqlJsStatic, SqlValue } from "sql.js";

import stripHtmlPreservingMediaFilenames from "./text.js";

interface MediaItem {
  filename: string;
  data: string | ArrayBuffer | Uint8Array | Buffer;
}

export type { ZipOptions } from "fflate";

interface ExporterOptions {
  template: string;
  sql: SqlJsStatic;
}

/** Anki stores a note's fields as one string joined by this control character. */
const FIELD_SEPARATOR = "\u001F";

/** Anki's field checksum is the first 8 hex digits of the sha1, read as base 16. */
const CHECKSUM_HEX_DIGITS = 8;
const CHECKSUM_RADIX = 16;

/**
 * Anki hands the first new card position 1 and counts up from there. The
 * template seeds `col.conf.nextPos` with the same value, and `save` writes the
 * counter back to it so the two never disagree.
 */
const FIRST_NEW_CARD_POSITION = 1;

const MILLISECONDS_PER_SECOND = 1000;

/**
 * Row `id`s are epoch milliseconds, but `mod` columns are epoch *seconds*.
 * Anki keeps whatever `mod` an imported note or card carries, so a millisecond
 * value read as seconds lands tens of thousands of years in the future and
 * stays there — unlike `sfld` and `csum`, which the importer recomputes.
 */
const toModified = (timestampMs: number): number =>
  Math.floor(timestampMs / MILLISECONDS_PER_SECOND);

export default class Exporter {
  public readonly db: Database;
  private readonly media: MediaItem[] = [];
  public readonly topDeckId: number;
  public readonly topModelId: number;
  public readonly separator: string = FIELD_SEPARATOR;
  public readonly deckName: string;
  private readonly createdAt: Date;

  /** The queue position the next new card takes; see `FIRST_NEW_CARD_POSITION`. */
  private nextPosition: number = FIRST_NEW_CARD_POSITION;

  constructor(deckName: string, { template, sql }: Readonly<ExporterOptions>) {
    this.createdAt = new Date(Date.now());
    const db = new sql.Database();
    db.run(template);

    this.db = db;
    this.deckName = deckName;

    const now = Date.now();
    this.topDeckId = this._getId("cards", "did", now);
    this.topModelId = this._getId("notes", "mid", now);

    this._renameTopDeck();
    this._renameTopModel();
  }

  /**
   * Decode one of the collection row's JSON text columns. `CollectionJson` is
   * what makes this the single place those columns are trusted to hold what the
   * template put there: the assertion happens once, and the column name picks
   * the shape rather than the caller naming it independently.
   */
  private _readJsonColumn<TColumn extends keyof CollectionJson>(
    column: TColumn,
  ): CollectionJson[TColumn] {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return this._getInitialRowValue("col", column) as CollectionJson[TColumn];
  }

  /**
   * Write a decoded JSON column back. Always paired with a fresh
   * `_readJsonColumn` rather than a cached value, so two updates to the same
   * column cannot clobber one another — which is why `conf` is re-parsed once
   * per key set rather than accumulated in memory.
   */
  private _writeJsonColumn<TColumn extends keyof CollectionJson>(
    column: TColumn,
    value: Readonly<CollectionJson[TColumn]>,
  ): void {
    this._update(`update col set ${column}=:value where id=1`, {
      ":value": JSON.stringify(value),
    });
  }

  /** Point the collection's last deck at this export's name and id. */
  private _renameTopDeck(): void {
    const decks = this._readJsonColumn("decks");
    const deck = getLastItem(decks);
    deck.name = this.deckName;
    deck.id = this.topDeckId;
    decks[String(this.topDeckId)] = deck;
    this._writeJsonColumn("decks", decks);
  }

  /** Point the collection's last note model at this export's name, deck and id. */
  private _renameTopModel(): void {
    const models = this._readJsonColumn("models");
    const model = getLastItem(models);
    model.name = this.deckName;
    model.did = this.topDeckId;
    model.id = this.topModelId;
    models[String(this.topModelId)] = model;
    this._writeJsonColumn("models", models);

    /* `curModel` is the notetype Anki preselects when adding a note, so it has
       to name one that exists in this file. The template cannot know the id. */
    this._updateConf("curModel", this.topModelId);
  }

  /**
   * Record where the new-card queue has got to. `nextPos` is what Anki reads to
   * place the next card a user adds, so leaving it at its seeded value would
   * hand that card a position this deck has already used.
   */
  private _storeNextPosition(): void {
    this._updateConf("nextPos", this.nextPosition);
  }

  /** Set one key of the collection's `conf` JSON column. */
  private _updateConf(key: string, value: number): void {
    const conf = this._readJsonColumn("conf");
    conf[key] = value;
    this._writeJsonColumn("conf", conf);
  }

  /*
   * Zipping is synchronous, but `save` stays async so callers keep awaiting it.
   * `options` is fflate's own bag, forwarded to `zipSync` untouched; its nested
   * `extra` record cannot be restated as deeply readonly from here.
   */
  // oxlint-disable-next-line typescript/require-await, typescript/prefer-readonly-parameter-types
  async save(options: Readonly<ZipOptions> = {}): Promise<Buffer> {
    this._storeNextPosition();
    const binaryArray = this.db.export();
    const mediaMap = Object.fromEntries(
      this.media.map((item: Readonly<MediaItem>, idx) => [idx, item.filename]),
    );

    /*
     * Every entry carries the exporter's creation date so identical input
     * yields an identical archive.
     */
    const mtime = toArchiveClock(this.createdAt);
    const entry = (data: Uint8Array): [Uint8Array, ZipOptions] => [data, { mtime }];

    const files: Zippable = {
      "collection.anki2": entry(binaryArray),
      media: entry(strToU8(JSON.stringify(mediaMap))),
    };
    this.media.forEach((item: Readonly<MediaItem>, idx) => {
      files[String(idx)] = entry(toBytes(item.data));
    });

    return Buffer.from(zipSync(files, { mtime, ...options }));
  }

  addMedia(filename: string, data: MediaItem["data"]): void {
    this.media.push({ filename, data });
  }

  addCard(
    front: string,
    back: string,
    { tags }: Readonly<{ tags?: string | readonly string[] }> = {},
  ): void {
    const now = Date.now();
    const noteGuid = this._getNoteGuid(this.topDeckId, front, back);
    const noteId = this._getNoteId(noteGuid, now);

    let normalizedTags = "";
    if (typeof tags === "string") {
      normalizedTags = tags;
    } else if (Array.isArray(tags)) {
      normalizedTags = this._tagsToStr(tags);
    }

    this._insertNote({ back, front, guid: noteGuid, id: noteId, now, tags: normalizedTags });
    this._insertCard(noteId, now);
    this.nextPosition += 1;
  }

  private _insertNote({ back, front, guid, id, now, tags }: Readonly<NoteRow>): void {
    const fields = front + this.separator + back;

    /**
     * Both the sort field and the checksum come from the first field with its
     * HTML stripped — never from the joined field list. The notetype's `sortf`
     * picks which field sorts, and this package pins it to 0; were `sortf` ever
     * made configurable, both of these would follow it rather than `front`.
     */
    const sortField = stripHtmlPreservingMediaFilenames(front);

    this._update(
      "insert or replace into notes values(:id,:guid,:mid,:mod,:usn,:tags,:flds,:sfld,:csum,:flags,:data)",
      {
        ":id": id,
        ":guid": guid,
        ":mid": this.topModelId,
        ":mod": toModified(now),
        ":usn": -1,
        ":tags": tags,
        ":flds": fields,
        ":sfld": sortField,
        ":csum": this._fieldChecksum(sortField),
        ":flags": 0,
        ":data": "",
      },
    );
  }

  private _insertCard(noteId: number, now: number): void {
    this._update(
      "insert or replace into cards values(:id,:nid,:did,:ord,:mod,:usn,:type,:queue,:due,:ivl,:factor,:reps,:lapses,:left,:odue,:odid,:flags,:data)",
      {
        ":id": this._getCardId(noteId, now),
        ":nid": noteId,
        ":did": this.topDeckId,
        ":ord": 0,
        ":mod": toModified(now),
        ":usn": -1,
        ":type": 0,
        ":queue": 0,
        /*
         * For a new card `due` is its position in the new-card queue, so each
         * one gets the next free slot instead of all of them sharing a single
         * hardcoded number. This reading only holds because every card written
         * here is new (`type` and `queue` both 0) — for a review card `due` is
         * a day counted from `col.crt`, and for a learning card it is a
         * timestamp.
         */
        ":due": this.nextPosition,
        ":ivl": 0,
        ":factor": 0,
        ":reps": 0,
        ":lapses": 0,
        ":left": 0,
        ":odue": 0,
        ":odid": 0,
        ":flags": 0,
        ":data": "",
      },
    );
  }

  /*
   * `run` prepares, binds, steps and frees in one call. Preparing by hand here
   * would leak: sql.js registers every statement on the Database and finalizes
   * it only on `free()` or `close()`, and this class never closes its handle.
   */
  protected _update(query: string, values: Readonly<Record<string, string | number>>): void {
    this.db.run(query, values);
  }

  private _getInitialRowValue(table: string, column = "id"): unknown {
    const query = `select ${column} from ${table}`;
    return this._getFirstVal(query);
  }

  /**
   * Anki's `field_checksum`: the first four bytes of the sha1, read big endian.
   * Named for what it must be given — the *stripped first field*. The hash
   * itself was always right; passing it the joined field list was the defect.
   */
  private _fieldChecksum(strippedFirstField: string): number {
    const hash = createHash("sha1")
      .update(strippedFirstField)
      .digest("hex")
      .slice(0, CHECKSUM_HEX_DIGITS);

    return Number.parseInt(hash, CHECKSUM_RADIX);
  }

  /**
   * Read the first column of the first row. JSON text columns are decoded here,
   * so the result is `unknown` and each caller states the shape it expects.
   */
  private _getFirstVal(query: string): unknown {
    const stmt = this.db.prepare(query);

    try {
      const hasRow = stmt.step();
      if (!hasRow) {
        throw new Error(`Query returned no results: ${query}`);
      }

      const [result] = stmt.get();
      if (result === undefined) {
        throw new Error(`Query returned no results: ${query}`);
      }

      return decodeCell(result);
    } finally {
      stmt.free();
    }
  }

  private _tagsToStr(tags: readonly string[] = []): string {
    return ` ${tags.map((tag) => tag.replaceAll(" ", "_")).join(" ")} `;
  }

  /**
   * Read one numeric column out of the first row a `ORDER BY ... DESC LIMIT 1`
   * query returns, or `undefined` when it matches nothing. Every id lookup
   * below is that shape, so this is the one place a statement is prepared and
   * freed for them.
   */
  private _getHighestValue(
    query: string,
    column: string,
    params: Readonly<Record<string, string | number>>,
  ): number | undefined {
    const stmt = this.db.prepare(query);

    try {
      /* The column is chosen by the caller, so sql.js cannot type the row for us. */
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const rowObj = stmt.getAsObject(params) as Record<string, number | undefined>;

      return rowObj[column];
    } finally {
      stmt.free();
    }
  }

  /**
   * Claim an unused millisecond timestamp for an identity column, stepping past
   * the highest existing value so two rows created in the same millisecond do
   * not collide. Only for id-like columns: `mod` is a plain modification time
   * where being unique means nothing, so it does not come through here.
   */
  private _getId(table: string, col: string, ts: number): number {
    const highest = this._getHighestValue(
      `SELECT ${col} from ${table} WHERE ${col} >= :ts ORDER BY ${col} DESC LIMIT 1`,
      col,
      { ":ts": ts },
    );

    /* Explicitly against `undefined`: these columns hold timestamps, but 0 is a
       value the query can return and truthiness would read it as "no row". */
    if (highest === undefined) {
      return ts;
    }
    return highest + 1;
  }

  /** Reuse a duplicate note's id so it is updated in place rather than added. */
  private _getNoteId(guid: string, ts: number): number {
    const existing = this._getHighestValue(
      `SELECT id from notes WHERE guid = :guid ORDER BY id DESC LIMIT 1`,
      "id",
      { ":guid": guid },
    );

    return existing ?? this._getId("notes", "id", ts);
  }

  private _getNoteGuid(topDeckId: number, front: string, back: string): string {
    return createHash("sha1").update(`${topDeckId}${front}${back}`).digest("hex");
  }

  /** Reuse the card already attached to this note, for the same reason. */
  private _getCardId(noteId: number, ts: number): number {
    const existing = this._getHighestValue(
      `SELECT id from cards WHERE nid = :note_id ORDER BY id DESC LIMIT 1`,
      "id",
      { ":note_id": noteId },
    );

    return existing ?? this._getId("cards", "id", ts);
  }
}

/** The parts of a note row that `addCard` derives before writing it. */
interface NoteRow {
  id: number;
  guid: string;
  tags: string;
  front: string;
  back: string;
  now: number;
}

interface DeckModel {
  id: number;
  name: string;
  [key: string]: unknown;
}

interface NoteModel {
  id: number;
  did: number;
  name: string;
  [key: string]: unknown;
}

/**
 * The `col` row's JSON text columns, keyed by column name. Anki stores each of
 * these as a text blob, so sqlite has nothing to say about their contents and
 * this map is the only statement of what a decoded column holds.
 */
interface CollectionJson {
  decks: Record<string, DeckModel>;
  models: Record<string, NoteModel>;
  conf: Record<string, unknown>;
}

/** JSON columns come back as text, everything else as the value sqlite stored. */
const decodeCell = (value: SqlValue): unknown => {
  if (typeof value === "string") {
    return JSON.parse(value);
  }
  return value;
};

const toBytes = (data: MediaItem["data"]): Uint8Array => {
  if (typeof data === "string") {
    return strToU8(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  return new Uint8Array(data);
};

/**
 * ZIP entries carry a DOS timestamp, which fflate writes from the *local*
 * clock, so the same deck would compress to different bytes on machines in
 * different timezones. Return a date whose local components spell out the
 * original's UTC ones, which both pins the stamp to UTC and keeps archives
 * byte-reproducible anywhere.
 */
const toArchiveClock = (date: Date): Date =>
  new Date(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  );

/**
 * Pop the last entry off a decoded collection map. Anki's default collection
 * ships one placeholder deck and note model; this removes the placeholder and
 * hands it back so the caller can re-key it under the export's own id.
 */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types
export const getLastItem = <TItem>(obj: Record<string, TItem>): TItem => {
  const keys = Object.keys(obj);
  const lastKey = keys.at(-1) ?? "";

  const item = obj[lastKey];
  delete obj[lastKey];

  return item;
};
