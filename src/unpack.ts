import { zstdDecompressSync } from "node:zlib";

import { unzipSync } from "fflate";

import { repeatedField, stringField, varintField } from "./protobuf.js";

/*
 * The `.apkg` container, read.
 *
 * This is the mirror of `archive.ts`, and it is deliberately not in that file.
 * The writer knows one layout and writes it; the reader has to survive three,
 * written by Anki 2.1, by Anki 25 and by third-party exporters. Keeping the
 * tolerance out of the strict module is the point of the split.
 *
 * Nothing here opens a database. It hands back bytes.
 */

/** The package layouts this reads. `meta` names one; its absence means v1. */
const PACKAGE_V1 = 1;
const PACKAGE_V2 = 2;
const PACKAGE_V3 = 3;

/** `Meta.version`, field 1 of the two-byte `meta` entry v2 and v3 carry. */
const META_VERSION_FIELD = 1;

/** `MediaEntries.entries`, and `MediaEntry.name` inside each one. */
const MEDIA_ENTRIES_FIELD = 1;
const MEDIA_NAME_FIELD = 1;

/**
 * Decompress, and hand back the type the rest of this file speaks.
 *
 * `node:zlib` returns a `Buffer` where everything else here is a plain
 * `Uint8Array`. A view rather than a copy, so the only cost is that the
 * published interface promises one type whichever branch produced the bytes.
 */
const unzstd = (data: Uint8Array): Uint8Array => {
  const decompressed = zstdDecompressSync(data);

  return new Uint8Array(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);
};

/**
 * One archive entry's bytes, decompressed when the container compressed them.
 *
 * Package v3 compresses the collection, the manifest and every media file;
 * v1 and v2 store all three as they are.
 */
const entryBytes = (data: Uint8Array, packageVersion: number): Uint8Array => {
  if (packageVersion === PACKAGE_V3) {
    return unzstd(data);
  }

  return data;
};

/** `Meta.version` is an enum whose zero value means the writer said nothing. */
const PACKAGE_UNKNOWN = 0;

const COLLECTION_ENTRY: Readonly<Record<number, string>> = {
  [PACKAGE_V1]: "collection.anki2",
  [PACKAGE_V2]: "collection.anki21",
  [PACKAGE_V3]: "collection.anki21b",
};

export interface UnpackedPackage {
  /** The collection database, decompressed if it needed to be. */
  readonly collection: Uint8Array;
  /** Media files by the name card HTML references them by. */
  readonly media: ReadonlyMap<string, Uint8Array>;
  readonly packageVersion: number;
}

/** The container this package declares, and the entry its collection is under. */
interface Container {
  readonly entry: string;
  readonly packageVersion: number;
}

/**
 * No `meta` at all is the v1 layout, which predates the entry. A `meta` that is
 * there and names no version is not v1: `Meta.version` is an enum, and its zero
 * value is the one that says the writer did not know either.
 */
const declaredVersion = (meta: Uint8Array | undefined): number => {
  if (meta === undefined) {
    return PACKAGE_V1;
  }

  return varintField(meta, META_VERSION_FIELD) ?? PACKAGE_UNKNOWN;
};

const readContainer = (meta: Uint8Array | undefined): Container => {
  const packageVersion = declaredVersion(meta);
  const entry = COLLECTION_ENTRY[packageVersion];

  if (entry === undefined) {
    throw new Error(
      `Unsupported .apkg package version ${packageVersion}: this reads versions 1, 2 and 3`,
    );
  }

  return { entry, packageVersion };
};

/**
 * The manifest, mapping the name cards use to the archive entry holding it.
 *
 * v1 and v2 write JSON keyed by the entry name; v3 writes a zstd-compressed
 * `MediaEntries` message whose entries are positional, so an entry's index in
 * the list is the name of the archive entry.
 */
const readManifest = (
  media: Uint8Array | undefined,
  packageVersion: number,
): Map<string, string> => {
  if (media === undefined || media.length === 0) {
    return new Map();
  }

  if (packageVersion === PACKAGE_V3) {
    const entries = repeatedField(unzstd(media), MEDIA_ENTRIES_FIELD);

    return new Map(
      entries.map((entry: Uint8Array, index: number) => [
        stringField(entry, MEDIA_NAME_FIELD),
        String(index),
      ]),
    );
  }

  /* The manifest is the package's own JSON, so its shape is asserted at this
     boundary rather than guarded: a guard would be a hand-written copy of a
     schema that is one level deep. */
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const names = JSON.parse(new TextDecoder().decode(media)) as Record<string, string>;

  return new Map(
    Object.entries(names).map(([entry, filename]: readonly [string, string]) => [filename, entry]),
  );
};

const readMedia = (
  archive: Readonly<Record<string, Uint8Array>>,
  packageVersion: number,
): Map<string, Uint8Array> => {
  const media = new Map<string, Uint8Array>();

  for (const [filename, entry] of readManifest(archive.media, packageVersion)) {
    const data = archive[entry];
    if (data === undefined) {
      throw new Error(
        `Malformed .apkg: the manifest names "${filename}" as entry ${entry}, ` +
          `which is not in the package`,
      );
    }

    media.set(filename, entryBytes(data, packageVersion));
  }

  return media;
};

/**
 * Open a package and take out the collection and the media it ships.
 *
 * The collection is chosen by version, never by looking for a familiar name. A
 * v2 or v3 package *also* carries a `collection.anki2`, and it is a decoy: a
 * valid schema-11 database holding one note that reads "Please update to the
 * latest Anki version, then import the .colpkg/.apkg file again." A reader that
 * opens the name it recognizes gets that note and no error at all.
 */
export const unpackDeck = (apkg: Uint8Array): UnpackedPackage => {
  const archive = unzipSync(apkg);
  const { entry, packageVersion } = readContainer(archive.meta);
  const collection = archive[entry];

  if (collection === undefined) {
    throw new Error(
      `Malformed .apkg: package version ${packageVersion} declares "${entry}", which is not in it`,
    );
  }

  return {
    collection: entryBytes(collection, packageVersion),
    media: readMedia(archive, packageVersion),
    packageVersion,
  };
};
