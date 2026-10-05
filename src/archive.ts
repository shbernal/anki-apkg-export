import { strToU8, type ZipOptions, type Zippable, zipSync } from "fflate";

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
  /** The exported `collection.anki2` bytes. */
  collection: Uint8Array;
  media: readonly Readonly<MediaItem>[];
  /** The instant the deck was built; every entry is stamped with it, unless
      the caller's own `mtime` says otherwise. */
  createdAt: Date;
  /** The container layout; 1 when left out. See `LAYOUTS`. */
  packageVersion?: WritablePackageVersion;
}

/** The package versions this writes. Version 3 is read, never written. */
export const PACKAGE_V1 = 1;
export const PACKAGE_V2 = 2;
export type WritablePackageVersion = typeof PACKAGE_V1 | typeof PACKAGE_V2;

/** The key byte of `PackageMetadata.version`: field 1, wire type varint. */
const META_VERSION_KEY = 0x08;

/**
 * Where each version keeps its collection, and the `meta` entry it declares
 * itself with. Version 1 has none; its absence is what says version 1.
 */
const LAYOUTS: Readonly<
  Record<WritablePackageVersion, Readonly<{ entry: string; meta: Uint8Array | null }>>
> = {
  [PACKAGE_V1]: { entry: "collection.anki2", meta: null },
  [PACKAGE_V2]: { entry: "collection.anki21", meta: Uint8Array.of(META_VERSION_KEY, PACKAGE_V2) },
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
 * `media` manifest mapping stringified indices to original filenames, and one
 * numerically named entry per file. Media files are stored under their index
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

  /* One pass over the media, because the manifest key and the entry name are
     the same index and that correspondence is the format's actual rule. */
  const manifest: Record<string, string> = {};
  const entries: Zippable = {};

  media.forEach((item: Readonly<MediaItem>, idx: number) => {
    const name = String(idx);
    manifest[name] = item.filename;
    entries[name] = entry(toBytes(item.data));
  });

  /* Anki writes `meta` first; the importer finds it by name either way. */
  const layout = LAYOUTS[packageVersion];
  const files: Zippable = {
    ...metaEntry(layout.meta, mtime),
    [layout.entry]: entry(collection),
    media: entry(strToU8(JSON.stringify(manifest))),
    ...entries,
  };

  /* Only `options`: every entry carries its own stamp, and fflate applies an
     archive-level one to entries without one. */
  return Buffer.from(zipSync(files, options));
};
