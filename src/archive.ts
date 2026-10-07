import { createHash } from "node:crypto";
import { zstdCompressSync } from "node:zlib";

import { strToU8, type ZipOptions, type Zippable, zipSync } from "fflate";

import { writeMessage } from "./protobuf.js";

export type { ZipOptions } from "fflate";

/**
 * Everything `addMedia` takes as a file's bytes. A Node `Buffer` is a
 * `Uint8Array`, so it is covered by that member rather than needing one of its
 * own.
 */
export type MediaData = string | ArrayBuffer | Uint8Array;

/** One buffered media file: the name card HTML references it by, and its bytes. */
export interface MediaItem {
  filename: string;
  data: MediaData;
}

/** Accept everything `addMedia` documents, hand fflate the one thing it takes. */
const toBytes = (data: MediaData): Uint8Array => {
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
  /** The collection database, before any compression its layout applies. */
  collection: Uint8Array;
  media: readonly Readonly<MediaItem>[];
  /** The instant the deck was built; every entry is stamped with it, unless
      the caller's own `mtime` says otherwise. */
  createdAt: Date;
  /** The container layout; 1 when left out. See `LAYOUTS`. */
  packageVersion?: WritablePackageVersion;
}

/** The package versions this writes. */
export const PACKAGE_V1 = 1;
export const PACKAGE_V2 = 2;
export const PACKAGE_V3 = 3;
export type WritablePackageVersion = typeof PACKAGE_V1 | typeof PACKAGE_V2 | typeof PACKAGE_V3;

/** `PackageMetadata.version`, and `MediaEntries.entries` with each entry's fields. */
const META_VERSION_FIELD = 1;
const MEDIA_ENTRIES_FIELD = 1;
const MEDIA_NAME_FIELD = 1;
const MEDIA_SIZE_FIELD = 2;
const MEDIA_SHA1_FIELD = 3;

/** Versions 1 and 2 map entry names to filenames in JSON. */
const jsonManifest = (filenames: readonly string[]): Uint8Array => {
  const byEntry = Object.fromEntries(filenames.entries());

  return strToU8(JSON.stringify(byEntry));
};

/** The bytes Node's zstd returns, as the plain `Uint8Array` fflate takes. */
const zstd = (data: Uint8Array): Uint8Array => new Uint8Array(zstdCompressSync(data));

/**
 * Version 3 lists the files in a `MediaEntries` message, positionally, with the
 * size and sha1 of the bytes before compression.
 */
const mediaEntry = (item: Readonly<MediaItem>): readonly [number, Uint8Array] => {
  const data = toBytes(item.data);
  const entry = writeMessage([
    [MEDIA_NAME_FIELD, item.filename],
    [MEDIA_SIZE_FIELD, data.length],
    [MEDIA_SHA1_FIELD, createHash("sha1").update(data).digest()],
  ]);

  return [MEDIA_ENTRIES_FIELD, entry];
};

const protobufManifest = (media: readonly Readonly<MediaItem>[]): Uint8Array =>
  zstd(writeMessage(media.map((item: Readonly<MediaItem>) => mediaEntry(item))));

const asIs = (data: Uint8Array): Uint8Array => data;

interface Layout {
  /** The collection's entry name. */
  readonly entry: string;
  /** The `meta` entry. Version 1 has none; its absence is what says version 1. */
  readonly meta: Uint8Array | null;
  /** Applied to the collection and to each media file. */
  readonly encode: (data: Uint8Array) => Uint8Array;
  readonly manifest: (media: readonly Readonly<MediaItem>[]) => Uint8Array;
}

/** How each version lays its collection and media out. */
const LAYOUTS: Readonly<Record<WritablePackageVersion, Layout>> = {
  [PACKAGE_V1]: {
    entry: "collection.anki2",
    meta: null,
    encode: asIs,
    manifest: (media: readonly Readonly<MediaItem>[]) =>
      jsonManifest(media.map((item: Readonly<MediaItem>) => item.filename)),
  },
  [PACKAGE_V2]: {
    entry: "collection.anki21",
    meta: writeMessage([[META_VERSION_FIELD, PACKAGE_V2]]),
    encode: asIs,
    manifest: (media: readonly Readonly<MediaItem>[]) =>
      jsonManifest(media.map((item: Readonly<MediaItem>) => item.filename)),
  },
  [PACKAGE_V3]: {
    entry: "collection.anki21b",
    meta: writeMessage([[META_VERSION_FIELD, PACKAGE_V3]]),
    encode: zstd,
    manifest: protobufManifest,
  },
};

/** The `meta` entry, for the versions that carry one. */
const metaEntry = (meta: Uint8Array | null, mtime: ZipOptions["mtime"]): Zippable => {
  if (meta === null) {
    return {};
  }

  return { meta: [meta, { mtime }] };
};

/**
 * Zip a collection and its media into the `.apkg` layout: the collection under
 * the entry its package version names, a `meta` entry from version 2 on, a
 * `media` manifest naming each file by its index, and one numerically named
 * entry per file. Version 3 compresses the collection, the manifest and every
 * file with zstd. Media files are stored under their index
 * rather than their name, which is what lets a deck carry filenames a ZIP or a
 * filesystem would not take.
 */
export const packageDeck = (
  { collection, media, createdAt, packageVersion = PACKAGE_V1 }: Readonly<DeckPackage>,
  /* Forwarded to `zipSync` untouched. fflate's nested `extra` record cannot be
     restated as deeply readonly from here. */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
  options: Readonly<ZipOptions> = {},
): Buffer => {
  /* A caller's own `mtime` is forwarded verbatim rather than pinned: fflate
     takes a `Date`, a number or a string, and reinterpreting any of them as UTC
     would be second-guessing an explicit instruction. The pinned build instant
     stays the default, and with it the reproducibility that rests on it. */
  const mtime = options.mtime ?? toArchiveClock(createdAt);
  const entry = (data: Uint8Array): [Uint8Array, ZipOptions] => [data, { mtime }];

  const layout = LAYOUTS[packageVersion];

  /* Each manifest names a file by its position in the list, and the entry is
     named by that same index: that correspondence is the format's actual rule. */
  const entries: Zippable = Object.fromEntries(
    media.map((item: Readonly<MediaItem>, idx: number) => [
      String(idx),
      entry(layout.encode(toBytes(item.data))),
    ]),
  );

  /* Anki writes `meta` first; the importer finds it by name either way. */
  const files: Zippable = {
    ...metaEntry(layout.meta, mtime),
    [layout.entry]: entry(layout.encode(collection)),
    media: entry(layout.manifest(media)),
    ...entries,
  };

  /* Only `options`: every entry carries its own stamp, and fflate applies an
     archive-level one to entries without one. */
  return Buffer.from(zipSync(files, options));
};
