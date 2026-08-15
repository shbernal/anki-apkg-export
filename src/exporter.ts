import { createHash } from "crypto";

import { strToU8, zipSync } from "fflate";
import type { ZipOptions, Zippable } from "fflate";
import type { Database, SqlJsStatic } from "sql.js";

interface MediaItem {
  filename: string;
  data: string | ArrayBuffer | Uint8Array | Buffer;
}

export type { ZipOptions };

interface ExporterOptions {
  template: string;
  sql: SqlJsStatic;
}

export default class Exporter {
  public readonly db: Database;
  private readonly media: MediaItem[];
  public readonly topDeckId: number;
  public readonly topModelId: number;
  public readonly separator: string;
  public readonly deckName: string;
  private readonly createdAt: Date;

  constructor(deckName: string, { template, sql }: ExporterOptions) {
    this.createdAt = new Date(Date.now());
    const db = new sql.Database();
    db.run(template);

    this.db = db;
    this.deckName = deckName;
    this.media = [];
    this.separator = "\u001F";

    const now = Date.now();
    this.topDeckId = this._getId("cards", "did", now);
    this.topModelId = this._getId("notes", "mid", now);

    const decks = this._getInitialRowValue<Record<string, DeckModel>>("col", "decks");
    const deck = getLastItem(decks);
    deck.name = this.deckName;
    deck.id = this.topDeckId;
    decks[String(this.topDeckId)] = deck;
    this._update("update col set decks=:decks where id=1", {
      ":decks": JSON.stringify(decks),
    });

    const models = this._getInitialRowValue<Record<string, NoteModel>>("col", "models");
    const model = getLastItem(models);
    model.name = this.deckName;
    model.did = this.topDeckId;
    model.id = this.topModelId;
    models[String(this.topModelId)] = model;
    this._update("update col set models=:models where id=1", {
      ":models": JSON.stringify(models),
    });
  }

  // Zipping is synchronous, but `save` stays async so callers keep awaiting it.
  // eslint-disable-next-line @typescript-eslint/require-await
  async save(options: ZipOptions = {}): Promise<Buffer> {
    const binaryArray = this.db.export();
    const mediaMap = this.media.reduce<Record<number, string>>((acc, item, idx) => {
      acc[idx] = item.filename;
      return acc;
    }, {});

    // Every entry carries the exporter's creation date so identical input
    // yields an identical archive.
    const mtime = toArchiveClock(this.createdAt);
    const entry = (data: Uint8Array): [Uint8Array, ZipOptions] => [data, { mtime }];

    const files: Zippable = {
      "collection.anki2": entry(binaryArray),
      media: entry(strToU8(JSON.stringify(mediaMap))),
    };
    this.media.forEach((item, idx) => {
      files[String(idx)] = entry(toBytes(item.data));
    });

    return Buffer.from(zipSync(files, { mtime, ...options }));
  }

  addMedia(filename: string, data: MediaItem["data"]): void {
    this.media.push({ filename, data });
  }

  addCard(front: string, back: string, { tags }: { tags?: string | string[] } = {}): void {
    const now = Date.now();
    const noteGuid = this._getNoteGuid(this.topDeckId, front, back);
    const noteId = this._getNoteId(noteGuid, now);

    let normalizedTags = "";
    if (typeof tags === "string") {
      normalizedTags = tags;
    } else if (Array.isArray(tags)) {
      normalizedTags = this._tagsToStr(tags);
    }

    this._update(
      "insert or replace into notes values(:id,:guid,:mid,:mod,:usn,:tags,:flds,:sfld,:csum,:flags,:data)",
      {
        ":id": noteId,
        ":guid": noteGuid,
        ":mid": this.topModelId,
        ":mod": this._getId("notes", "mod", now),
        ":usn": -1,
        ":tags": normalizedTags,
        ":flds": front + this.separator + back,
        ":sfld": front,
        ":csum": this._checksum(front + this.separator + back),
        ":flags": 0,
        ":data": "",
      },
    );

    this._update(
      "insert or replace into cards values(:id,:nid,:did,:ord,:mod,:usn,:type,:queue,:due,:ivl,:factor,:reps,:lapses,:left,:odue,:odid,:flags,:data)",
      {
        ":id": this._getCardId(noteId, now),
        ":nid": noteId,
        ":did": this.topDeckId,
        ":ord": 0,
        ":mod": this._getId("cards", "mod", now),
        ":usn": -1,
        ":type": 0,
        ":queue": 0,
        ":due": 179,
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

  protected _update(query: string, values: Record<string, string | number>): void {
    this.db.prepare(query).getAsObject(values);
  }

  private _getInitialRowValue<T>(table: string, column = "id"): T {
    const query = `select ${column} from ${table}`;
    return this._getFirstVal<T>(query);
  }

  private _checksum(str: string): number {
    const hash = createHash("sha1").update(str).digest("hex").slice(0, 8);
    return parseInt(hash, 16);
  }

  private _getFirstVal<T>(query: string): T {
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

      if (typeof result === "string") {
        return JSON.parse(result) as T;
      }

      return result as T;
    } finally {
      stmt.free();
    }
  }

  private _tagsToStr(tags: string[] = []): string {
    return ` ${tags.map((tag) => tag.replace(/ /g, "_")).join(" ")} `;
  }

  private _getId(table: string, col: string, ts: number): number {
    const query = `SELECT ${col} from ${table} WHERE ${col} >= :ts ORDER BY ${col} DESC LIMIT 1`;
    const rowObj = this.db.prepare(query).getAsObject({ ":ts": ts }) as Record<string, number>;

    return rowObj[col] ? Number(rowObj[col]) + 1 : ts;
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

const toBytes = (data: MediaItem["data"]): Uint8Array => {
  if (typeof data === "string") return strToU8(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
};

/**
 * fflate writes a ZIP entry's DOS timestamp from the *local* clock, so the same
 * deck would compress to different bytes on machines in different timezones.
 * Return a date whose local components spell out the original's UTC ones, which
 * both pins the stamp to UTC and keeps archives byte-reproducible anywhere.
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

export const getLastItem = <T>(obj: Record<string, T>): T => {
  const keys = Object.keys(obj);
  const lastKey = keys[keys.length - 1];

  const item = obj[lastKey];
  delete obj[lastKey];

  return item;
};
