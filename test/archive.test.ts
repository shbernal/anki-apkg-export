import { afterEach, describe, expect, it } from "vitest";

import { type MediaItem, packageDeck } from "../src/archive.js";
import { unzipDeckToBuffers } from "./_helpers.js";

/** Stand-in collection bytes: `packageDeck` stores them and reads nothing. */
const COLLECTION = new TextEncoder().encode("collection bytes");

/** Any fixed instant; only that every build is handed the same one matters. */
const CREATED_AT_MS = 1_700_000_000_000;
const CREATED_AT = new Date(CREATED_AT_MS);

/**
 * Zones chosen to break a naive local-clock stamp loudly: one whole-hour offset
 * at the far end of the day line, and one that is not a whole number of hours.
 */
const AWKWARD_ZONES = ["Pacific/Kiritimati", "Asia/Kathmandu"];

/** A non-ASCII payload, so a string going in as UTF-8 is observable. */
const UNICODE_TEXT = "café 今日";

const build = (media: readonly Readonly<MediaItem>[] = []): Buffer =>
  packageDeck({ collection: COLLECTION, media, createdAt: CREATED_AT });

const manifestOf = (files: ReadonlyMap<string, Buffer>): unknown =>
  JSON.parse(String(files.get("media")));

describe("the deck archive", () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    /* Restored even when an assertion throws: every test file this worker runs
       shares the environment, and the next one would inherit the last zone
       set here. */
    process.env.TZ = originalTz;
  });

  const buildIn = (timezone: string, media: readonly Readonly<MediaItem>[] = []): Buffer => {
    process.env.TZ = timezone;
    return build(media);
  };

  it("writes the same bytes whatever the machine's timezone", () => {
    expect.hasAssertions();
    const media = [{ filename: "a.png", data: "one" }];
    const utc = buildIn("UTC", media);

    /* ZIP entries carry a DOS timestamp written from the local clock, so this
       is the guarantee `toArchiveClock` exists for: identical input compresses
       to identical bytes on any machine, not merely on this one. */
    for (const zone of AWKWARD_ZONES) {
      expect(buildIn(zone, media).equals(utc)).toBe(true);
    }
  });

  it("numbers media entries in insertion order", () => {
    expect.hasAssertions();
    const files = unzipDeckToBuffers(
      build([
        { filename: "first.png", data: "one" },
        { filename: "second.png", data: "two" },
        { filename: "third.png", data: "three" },
      ]),
    );

    /* The manifest's keys are the entry names, stringified indices, and each
       one is a real entry rather than a name the archive does not carry. */
    expect(manifestOf(files)).toStrictEqual({
      0: "first.png",
      1: "second.png",
      2: "third.png",
    });
    expect([...files.keys()].sort()).toStrictEqual(["0", "1", "2", "collection.anki2", "media"]);
    expect(files.get("0")?.toString()).toBe("one");
    expect(files.get("2")?.toString()).toBe("three");
  });

  it("stores every accepted form of media bytes", () => {
    expect.hasAssertions();
    const bytes = new TextEncoder().encode(UNICODE_TEXT);

    /* One entry per accepted type, in the order `toBytes` handles them. */
    const forms: readonly Readonly<MediaItem>[] = [
      { filename: "string.txt", data: UNICODE_TEXT },
      { filename: "buffer.txt", data: Buffer.from(UNICODE_TEXT) },
      { filename: "uint8.txt", data: bytes },
      { filename: "arraybuffer.txt", data: bytes.buffer },
    ];
    const files = unzipDeckToBuffers(build(forms));

    /* A string is encoded as UTF-8, which only a non-ASCII payload shows. */
    expect(
      forms.map((_form: Readonly<MediaItem>, index: number) =>
        files.get(String(index))?.toString(),
      ),
    ).toStrictEqual(forms.map(() => UNICODE_TEXT));
  });

  it("ships an empty manifest for a deck with no media", () => {
    expect.hasAssertions();
    const files = unzipDeckToBuffers(build());

    expect([...files.keys()].sort()).toStrictEqual(["collection.anki2", "media"]);
    expect(manifestOf(files)).toStrictEqual({});
    expect(files.get("collection.anki2")?.toString()).toBe("collection bytes");
  });

  it("carries filenames a zip or a filesystem would refuse", () => {
    expect.hasAssertions();
    const hostile = [
      { filename: "../evil/x.png", data: "traversal" },
      { filename: "with spaces and 今日.png", data: "unicode" },
      { filename: "con:aux*?.png", data: "reserved" },
    ];
    const files = unzipDeckToBuffers(build(hostile));

    /* Entries are named by index, so none of these is ever a path this package
       opens: the name is a JSON string in the manifest and nothing more. Anki
       is what decides where the bytes land when it imports them. */
    expect(manifestOf(files)).toStrictEqual({
      0: "../evil/x.png",
      1: "with spaces and 今日.png",
      2: "con:aux*?.png",
    });
    expect([...files.keys()].sort()).toStrictEqual(["0", "1", "2", "collection.anki2", "media"]);
    expect(files.get("0")?.toString()).toBe("traversal");
  });
});
