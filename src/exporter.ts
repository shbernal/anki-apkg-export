import { createHash } from "node:crypto";

import type { Database, SqlJsStatic } from "sql.js";

import { type MediaItem, packageDeck, type ZipOptions } from "./archive.js";
import stripHtmlPreservingMediaFilenames from "./text.js";

interface ExporterOptions {
  template: string;
  sql: SqlJsStatic;
  /** Epoch milliseconds to build this deck at; defaults to the current time. */
  now?: number;
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
  /**
   * Buffered media, keyed by filename so a repeated one replaces its bytes
   * instead of shipping a second entry the importer would overwrite. A Map
   * keeps insertion order and leaves an existing key where it is, which is what
   * holds the index-keyed manifest stable across a replacement.
   *
   * Filenames are compared verbatim: Anki treats them as opaque text, so
   * nothing here folds case or touches path separators.
   */
  private readonly media = new Map<string, MediaItem["data"]>();
  public readonly topDeckId: number;
  public readonly topModelId: number;
  public readonly separator: string = FIELD_SEPARATOR;
  public readonly deckName: string;

  /**
   * The one instant this deck is built at, in epoch milliseconds. Every
   * timestamp the exporter writes — the id seeds, each row's `id` and `mod`,
   * and the archive stamp — derives from it, so nothing here reads the clock
   * again after construction. Two readings can straddle a millisecond, which
   * would give a deck built from identical input a different creation date
   * than its own ids, and this package promises byte-identical archives for
   * identical input. Supplying `now` extends that promise across processes:
   * same input plus same clock, same bytes.
   */
  private readonly now: number;

  /** How many distinct note guids have been allocated so far. */
  private noteCount = 0;

  /** The queue position the next new card takes; see `FIRST_NEW_CARD_POSITION`. */
  private get nextPosition(): number {
    return FIRST_NEW_CARD_POSITION + this.noteCount;
  }

  /**
   * Every note handed out so far, keyed by guid — the index schema 11 does not
   * have. `notes.guid` is unindexed in Anki's own schema, so asking sqlite
   * whether a guid is already present is a full table scan, and doing it once
   * per card made `addCard` quadratic in deck size. Adding the index instead
   * would change the emitted bytes and diverge from the schema Anki writes.
   *
   * The map is exactly equivalent to that query because this class is the only
   * writer of `notes` and `cards` — the template seeds neither — and every
   * insert goes through `_getNoteSlot` below. The ids and the queue position it
   * holds are tracked for the same reason: what a `SELECT ... ORDER BY id DESC`
   * would report is already known here.
   *
   * `db` is public, so a caller *can* insert rows this class does not know
   * about. That was true when the guid map landed and is accepted on the same
   * terms: a collection written to from outside is not one this class built.
   */
  private readonly notesByGuid = new Map<string, NoteSlot>();

  /** Whether `close` has released `db`; see the method for why it is tracked. */
  private closed = false;

  constructor(deckName: string, { template, sql, now = Date.now() }: Readonly<ExporterOptions>) {
    this.now = now;

    const db = new sql.Database();
    db.run(template);

    this.db = db;
    this.deckName = deckName;

    /* The template seeds no `cards` and no `notes` rows, so there is nothing to
       step past: the deck and the notetype take the build instant itself, and
       so does the first row of either table. */
    this.topDeckId = now;
    this.topModelId = now;

    this._renameTopDeck();
    this._renameTopModel();
  }

  /**
   * Read and decode one of the collection row's JSON text columns. There is
   * exactly one `col` row and the template seeds all four of these columns, so
   * anything else means the collection is not the one this class built.
   *
   * `CollectionJson` is what makes this the single place those columns are
   * trusted to hold what the template put there: the assertion happens once,
   * and the column name picks the shape rather than the caller naming it
   * independently.
   */
  private _readJsonColumn<TColumn extends keyof CollectionJson>(
    column: TColumn,
  ): CollectionJson[TColumn] {
    const stmt = this.db.prepare(`select ${column} from col`);

    try {
      if (!stmt.step()) {
        throw new Error(`Cannot read col.${column}: the collection has no col row`);
      }

      /* Narrowing, not validation: sqlite types this as any storage class, and
         only text can be JSON. Anything else means the row was rewritten by
         something other than this class. */
      const [value] = stmt.get();
      if (typeof value !== "string") {
        throw new TypeError(`Cannot read col.${column}: the column does not hold text`);
      }

      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return JSON.parse(value) as CollectionJson[TColumn];
    } finally {
      stmt.free();
    }
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
    this.db.run(`update col set ${column}=:value where id=1`, {
      ":value": JSON.stringify(value),
    });
  }

  /** Point the collection's last deck at this export's name and id. */
  private _renameTopDeck(): void {
    const decks = this._readJsonColumn("decks");
    const deck = takeLastItem(decks);
    deck.name = this.deckName;
    deck.id = this.topDeckId;
    decks[String(this.topDeckId)] = deck;
    this._writeJsonColumn("decks", decks);
  }

  /** Point the collection's last note model at this export's name, deck and id. */
  private _renameTopModel(): void {
    const models = this._readJsonColumn("models");
    const model = takeLastItem(models);
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

  /**
   * Release the sql.js database. Idempotent, and the exporter is finished
   * afterwards: `addCard`, `addMedia`, and `save` all throw.
   *
   * sql.js holds the collection in a WASM heap that is created once per process
   * and never shrinks, so dropping the last reference to an exporter and even
   * forcing a collection reclaims nothing — only closing the handle does. A
   * one-shot script that exits never notices; a long-lived process building
   * deck after deck keeps every one of them.
   */
  close(): void {
    if (this.closed) {
      return;
    }

    /* Set first: `db.close()` finalizes every statement still registered on the
       handle, and a second close would be operating on a freed pointer. */
    this.closed = true;
    this.db.close();
  }

  /** So `using apkg = ...` releases the database at the end of the block. */
  [Symbol.dispose](): void {
    this.close();
  }

  /**
   * Fail with a sentence rather than a WASM-level fault. Reaching a closed
   * `Database` from JavaScript is an access into memory sqlite has freed, and
   * what comes back from that is not worth debugging.
   */
  private _assertOpen(method: string): void {
    if (this.closed) {
      throw new Error(`Cannot ${method} on a closed exporter: close() released its database`);
    }
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
    this._assertOpen("save");
    this._storeNextPosition();

    /* The archive is stamped with the same instant the rows are, so identical
       input yields an identical file. */
    return packageDeck(
      {
        collection: this.db.export(),
        media: [...this.media].map(([filename, data]: readonly [string, MediaItem["data"]]) => ({
          filename,
          data,
        })),
        createdAt: new Date(this.now),
      },
      options,
    );
  }

  addMedia(filename: string, data: MediaItem["data"]): void {
    this._assertOpen("addMedia");
    this.media.set(filename, data);
  }

  addCard(
    front: string,
    back: string,
    { tags }: Readonly<{ tags?: string | readonly string[] }> = {},
  ): void {
    this._assertOpen("addCard");
    const { now } = this;

    /**
     * Both the sort field and the checksum come from the first field with its
     * HTML stripped — never from the joined field list. The notetype's `sortf`
     * picks which field sorts, and this package pins it to 0; were `sortf` ever
     * made configurable, both of these would follow it rather than `front`.
     */
    const sortField = stripHtmlPreservingMediaFilenames(front);

    /* Before anything is written or any position is claimed: Anki's importer
       reports a note whose first field is empty as `empty_first_field` and
       drops it, so writing one would build a deck that silently loses cards.
       The test is on the stripped field, which is what `sfld` holds — `<br>`
       is empty by this measure, while `<img src="a.png">` keeps its filename. */
    if (sortField.trim() === "") {
      throw new Error(
        `Cannot add a card whose first field is empty once its HTML is stripped: Anki drops those notes on import (front was ${JSON.stringify(front)})`,
      );
    }

    const noteGuid = this._getNoteGuid(front, back);
    const note = this._getNoteSlot(noteGuid);

    this._insertNote({
      back,
      front,
      guid: noteGuid,
      id: note.id,
      now,
      sortField,
      tags: normalizeTags(tags),
    });
    this._insertCard(note, now);
  }

  /*
   * Every write in this class goes through `db.run`, which prepares, binds,
   * steps and frees in one call. Holding these two statements open across cards
   * instead was measured and rejected; see docs/architecture.md.
   */
  private _insertNote({ back, front, guid, id, now, sortField, tags }: Readonly<NoteRow>): void {
    const fields = front + this.separator + back;

    this.db.run(
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

  private _insertCard({ id: noteId, cardId, position }: Readonly<NoteSlot>, now: number): void {
    this.db.run(
      "insert or replace into cards values(:id,:nid,:did,:ord,:mod,:usn,:type,:queue,:due,:ivl,:factor,:reps,:lapses,:left,:odue,:odid,:flags,:data)",
      {
        ":id": cardId,
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
        ":due": position,
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
   * The row ids and queue position for a note guid, allocating all three the
   * first time that guid is seen. A repeat reuses them, so its rows are updated
   * in place rather than added, and it keeps the position it was first given
   * instead of consuming a second one and leaving a hole in the queue.
   */
  private _getNoteSlot(guid: string): NoteSlot {
    const existing = this.notesByGuid.get(guid);
    if (existing !== undefined) {
      return existing;
    }

    /* Row ids are epoch milliseconds and have to be unique, so a deck built
       inside a single millisecond — every deck, in practice — counts up from
       the build instant instead of colliding on it. The note and its card
       share the id because both tables start there and exactly one card is
       written per note; a notetype generating two would need its own counter. */
    const rowId = this.now + this.noteCount;
    const slot: NoteSlot = { id: rowId, cardId: rowId, position: this.nextPosition };

    this.noteCount += 1;
    this.notesByGuid.set(guid, slot);

    return slot;
  }

  /**
   * Anki matches notes on `guid` at import, so this is what decides whether
   * re-exporting a deck updates its notes or duplicates them. It hashes the
   * deck *name* and the two fields, and nothing else: hashing the deck id
   * instead — a timestamp — gave the same card a new guid on every export, so
   * every re-import added a second copy.
   *
   * The name stays in because dropping it would make identical content in two
   * different decks one note as far as Anki is concerned. The cost of keeping
   * it is that renaming a deck orphans its notes, which is the smaller of the
   * two surprises.
   *
   * The three are joined with `FIELD_SEPARATOR` rather than concatenated, so
   * that only one triple can produce a given hash: glued together, deck `"ab"`
   * with front `"c"` hashed the same as deck `"a"` with front `"bc"`, and two
   * notes sharing a guid are one note to Anki. `U+001F` is what makes the
   * encoding unambiguous by construction, since it is the character Anki splits
   * `flds` on and therefore the one no field can legitimately carry.
   */
  private _getNoteGuid(front: string, back: string): string {
    return createHash("sha1")
      .update([this.deckName, front, back].join(FIELD_SEPARATOR))
      .digest("hex");
  }
}

/**
 * What one note guid was allocated: its row `id` and its place in the new-card
 * queue. Both are handed out once and reused by every repeat of that guid.
 */
interface NoteSlot {
  id: number;
  cardId: number;
  position: number;
}

/** The parts of a note row that `addCard` derives before writing it. */
interface NoteRow {
  id: number;
  guid: string;
  tags: string;
  front: string;
  back: string;
  /** `front` with its HTML stripped: what `sfld` holds and `csum` hashes. */
  sortField: string;
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

/**
 * Put `addCard`'s `tags` option into the single space-delimited string Anki
 * stores. A preformatted string passes through untouched; an array is joined
 * with each entry's spaces underscored, since a space would otherwise split one
 * tag into several. A result with tags in it is padded at both ends, which is
 * what lets an Anki search for `" tag "` match the first and last tags too.
 */
const normalizeTags = (tags?: string | readonly string[]): string => {
  if (typeof tags === "string") {
    return tags;
  }

  /* Not `tags === undefined`: this is a published entry point, so a JavaScript
     caller can pass anything, and only an array has tags to write. */
  if (!Array.isArray(tags)) {
    return "";
  }

  /* An entry with no tag in it would contribute only a doubled separator, and
     an array of nothing but those is a note with no tags — which Anki stores
     as the empty string rather than as the pair of pad spaces. */
  const named = tags
    .filter((tag: string) => tag.trim() !== "")
    .map((tag: string) => tag.replaceAll(" ", "_"));
  if (named.length === 0) {
    return "";
  }

  return ` ${named.join(" ")} `;
};

/**
 * Take the last entry off a decoded collection map — the name says `take`
 * because the entry is deleted, not read. Anki's default collection ships one
 * placeholder deck and note model; this removes the placeholder and hands it
 * back so the caller can re-key it under the export's own id.
 *
 * Throws on an empty map rather than returning `undefined` as `TItem`. Both
 * callers are renaming a placeholder the template is required to have seeded,
 * so an empty map means the template is broken — which is worth saying loudly
 * instead of writing `undefined` into the deck.
 */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types
const takeLastItem = <TItem>(obj: Record<string, TItem>): TItem => {
  const lastEntry = Object.entries(obj).at(-1);
  if (lastEntry === undefined) {
    throw new Error("Cannot take the last item of an empty collection map");
  }

  const [lastKey, item] = lastEntry;
  delete obj[lastKey];

  return item;
};
