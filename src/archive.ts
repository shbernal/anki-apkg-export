import { strToU8, type ZipOptions, type Zippable, zipSync } from "fflate";

export type { ZipOptions } from "fflate";

/** One buffered media file: the name card HTML references it by, and its bytes. */
export interface MediaItem {
  filename: string;
  data: string | ArrayBuffer | Uint8Array | Buffer;
}

/** Accept everything `addMedia` documents, hand fflate the one thing it takes. */
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

interface DeckPackage {
  /** The exported `collection.anki2` bytes. */
  collection: Uint8Array;
  media: readonly Readonly<MediaItem>[];
  /** The instant the deck was built; every entry is stamped with it, unless
      the caller's own `mtime` says otherwise. */
  createdAt: Date;
}

/**
 * Zip a collection and its media into the `.apkg` layout: `collection.anki2`,
 * a `media` manifest mapping stringified indices to original filenames, and one
 * numerically named entry per file. Media files are stored under their index
 * rather than their name, which is what lets a deck carry filenames a ZIP or a
 * filesystem would not take.
 */
export const packageDeck = (
  { collection, media, createdAt }: Readonly<DeckPackage>,
  /* Forwarded to `zipSync` untouched. fflate's nested `extra` record cannot be
     restated as deeply readonly from here. */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  options: Readonly<ZipOptions> = {},
): Buffer => {
  const mediaMap = Object.fromEntries(
    media.map((item: Readonly<MediaItem>, idx) => [idx, item.filename]),
  );

  /* A caller's own `mtime` is forwarded verbatim rather than pinned: fflate
     takes a `Date`, a number or a string, and reinterpreting any of them as UTC
     would be second-guessing an explicit instruction. The pinned build instant
     stays the default, and with it the reproducibility that rests on it. */
  const mtime = options.mtime ?? toArchiveClock(createdAt);
  const entry = (data: Uint8Array): [Uint8Array, ZipOptions] => [data, { mtime }];

  const files: Zippable = {
    "collection.anki2": entry(collection),
    media: entry(strToU8(JSON.stringify(mediaMap))),
  };
  media.forEach((item: Readonly<MediaItem>, idx) => {
    files[String(idx)] = entry(toBytes(item.data));
  });

  return Buffer.from(zipSync(files, { mtime, ...options }));
};
