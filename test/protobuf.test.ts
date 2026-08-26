import { describe, expect, it } from "vitest";

import { readMessage, repeatedField, stringField, varintField } from "../src/protobuf.js";

/*
 * The wire reader, against messages written by hand.
 *
 * `test/reader.test.ts` covers what Anki actually writes; this covers what the
 * format permits and Anki happens not to use, which is where a reader breaks
 * one release later.
 */

const bytes = (...values: readonly number[]): Uint8Array => new Uint8Array(values);

/** The field number and wire type in one byte, which is every tag used below. */
const tag = (fieldNumber: number, wireType: number): number => fieldNumber * 8 + wireType;

/** A byte with its continuation bit set and no payload, so a varint never ends. */
const CONTINUES = 0x80;

/** Wire types 3 and 4 are the removed group delimiters; nothing skips past one. */
const REMOVED_WIRE_TYPE = 3;

/** Any value that is neither 0 nor 1, so a wrong read cannot pass by accident. */
const SENTINEL = 42;

const VARINT = 0;
const FIXED_64 = 1;
const LENGTH_DELIMITED = 2;
const FIXED_32 = 5;

describe("reading a protobuf message", () => {
  it("returns the varint written for a field", () => {
    expect.hasAssertions();

    const message = bytes(tag(1, VARINT), 3);

    expect(varintField(message, 1)).toBe(3);
  });

  it("returns null for a field the message does not carry", () => {
    expect.hasAssertions();

    const message = bytes(tag(1, VARINT), 3);

    expect(varintField(message, 2)).toBeNull();
  });

  /* `MediaEntry.size` is a uint32, so its top bit is inside the range a shift
     would truncate. Accumulating by multiplication is what keeps it. */
  it("reads a varint past 32 bits", () => {
    expect.hasAssertions();
    const message = bytes(tag(1, VARINT), 0xff, 0xff, 0xff, 0xff, 0x0f);

    expect(varintField(message, 1)).toBe(4_294_967_295);
  });

  it("reads a string, decoded as UTF-8", () => {
    expect.hasAssertions();

    const value = new TextEncoder().encode("Grüße");
    const message = bytes(tag(1, LENGTH_DELIMITED), value.length, ...value);

    expect(stringField(message, 1)).toBe("Grüße");
    expect(stringField(message, 2)).toBe("");
  });

  it("returns every value repeated on one field, in order", () => {
    expect.hasAssertions();

    const message = bytes(
      tag(1, LENGTH_DELIMITED),
      1,
      0x61,
      tag(1, LENGTH_DELIMITED),
      1,
      0x62,
      tag(2, LENGTH_DELIMITED),
      1,
      0x63,
    );

    expect(repeatedField(message, 1)).toStrictEqual([bytes(0x61), bytes(0x62)]);
  });

  /*
   * The point of the wire format. A newer Anki adding a field must not stop a
   * reader that only ever wanted the one before it, so unknown fields are
   * stepped over by their wire type rather than refused.
   */
  it("steps over fields it was not looking for", () => {
    expect.hasAssertions();

    const message = bytes(
      tag(5, FIXED_64),
      ...Array.from({ length: 8 }, () => 0xff),
      tag(6, FIXED_32),
      ...Array.from({ length: 4 }, () => 0xff),
      tag(7, LENGTH_DELIMITED),
      2,
      0x00,
      0x00,
      tag(1, VARINT),
      SENTINEL,
    );

    expect(varintField(message, 1)).toBe(SENTINEL);
  });

  it("refuses a wire type that carries no length", () => {
    expect.hasAssertions();
    /* 3 and 4 are the removed group delimiters; nothing can be skipped past. */
    const message = bytes(tag(1, REMOVED_WIRE_TYPE));

    expect(() => [...readMessage(message)]).toThrow(/wire type 3/u);
  });

  it("refuses a varint with no end to it", () => {
    expect.hasAssertions();
    const message = bytes(tag(1, VARINT), CONTINUES, CONTINUES);

    expect(() => [...readMessage(message)]).toThrow(/runs past the end/u);
  });

  it("reads an empty message as no fields at all", () => {
    expect.hasAssertions();
    expect([...readMessage(bytes())]).toStrictEqual([]);
  });
});
