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

/** New cards are queued at this position, matching Anki's own default export. */
const INITIAL_DUE_POSITION = 179;

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

  /** Point the collection's last deck at this export's name and id. */
  private _renameTopDeck(): void {
    /* `decks` is a JSON text column, so its decoded shape is only known here. */
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const decks = this._getInitialRowValue("col", "decks") as Record<string, DeckModel>;
    const deck = getLastItem(decks);
    deck.name = this.deckName;
    deck.id = this.topDeckId;
    decks[String(this.topDeckId)] = deck;
    this._update("update col set decks=:decks where id=1", {
      ":decks": JSON.stringify(decks),
    });
  }

  /** Point the collection's last note model at this export's name, deck and id. */
  private _renameTopModel(): void {
    /* `models` is a JSON text column, so its decoded shape is only known here. */
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const models = this._getInitialRowValue("col", "models") as Record<string, NoteModel>;
    const model = getLastItem(models);
    model.name = this.deckName;
    model.did = this.topDeckId;
    model.id = this.topModelId;
    models[String(this.topModelId)] = model;
    this._update("update col set models=:models where id=1", {
      ":models": JSON.stringify(models),
    });
  }

  /*
   * Zipping is synchronous, but `save` stays async so callers keep awaiting it.
   * `options` is fflate's own bag, forwarded to `zipSync` untouched; its nested
   * `extra` record cannot be restated as deeply readonly from here.
   */
  // oxlint-disable-next-line typescript/require-await, typescript/prefer-readonly-parameter-types
  async save(options: Readonly<ZipOptions> = {}): Promise<Buffer> {
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
        ":due": INITIAL_DUE_POSITION,
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

  protected _update(query: string, values: Readonly<Record<string, string | number>>): void {
    this.db.prepare(query).getAsObject(values);
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
   * Claim an unused millisecond timestamp for an identity column, stepping past
   * the highest existing value so two rows created in the same millisecond do
   * not collide. Only for id-like columns: `mod` is a plain modification time
   * where being unique means nothing, so it does not come through here.
   */
  private _getId(table: string, col: string, ts: number): number {
    const query = `SELECT ${col} from ${table} WHERE ${col} >= :ts ORDER BY ${col} DESC LIMIT 1`;
    /* The column is chosen by the caller, so sql.js cannot type the row for us. */
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const rowObj = this.db.prepare(query).getAsObject({ ":ts": ts }) as Record<string, number>;

    const highest = rowObj[col];
    if (highest) {
      return highest + 1;
    }
    return ts;
  }

  private _getNoteId(guid: string, ts: number): number {
    const query = `SELECT id from notes WHERE guid = :guid ORDER BY id DESC LIMIT 1`;
    const rowObj = this.db.prepare(query).getAsObject({ ":guid": guid }) as {
      id?: number;
    };

    return rowObj.id ?? this._getId("notes", "id", ts);
  }

  private _getNoteGuid(topDeckId: number, front: string, back: string): string {
    return createHash("sha1").update(`${topDeckId}${front}${back}`).digest("hex");
  }

  private _getCardId(noteId: number, ts: number): number {
    const query = `SELECT id from cards WHERE nid = :note_id ORDER BY id DESC LIMIT 1`;
    const rowObj = this.db.prepare(query).getAsObject({ ":note_id": noteId }) as { id?: number };

    return rowObj.id ?? this._getId("cards", "id", ts);
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
