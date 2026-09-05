/*
 * Just enough of the protobuf wire format to read three things Anki stores in
 * it: the package version in a `meta` entry, the media manifest of a v3
 * package, and whether a schema-18 notetype is a cloze.
 *
 * All three are a handful of bytes, and none of them needs a schema: the wire
 * format carries the field number and the shape of every value, and this reads
 * fields positionally the way `text.ts` reads regex groups positionally.
 * Generating stubs, or taking a runtime dependency to decode 89 bytes, would
 * cost more than the format does.
 *
 * Unknown fields are stepped over rather than refused, which is what the wire
 * format is designed for: a newer Anki adding a field must not stop a reader
 * that only ever wanted the two before it.
 */

/** A tag is the field number times this, plus the wire type. */
const WIRE_TYPES = 8;

/** The wire types a message can carry. 3 and 4, the group delimiters, are gone. */
const VARINT = 0;
const FIXED_64 = 1;
const LENGTH_DELIMITED = 2;
const FIXED_32 = 5;

const FIXED_64_BYTES = 8;
const FIXED_32_BYTES = 4;

/** A varint carries seven bits per byte, and the eighth says another follows. */
const CONTINUATION = 0b1000_0000;
const PAYLOAD_MASK = 0b0111_1111;
const PAYLOAD_SCALE = 128;

/** The wire format's ceiling: ten seven-bit groups cover a 64-bit value. */
const VARINT_MAX_BYTES = 10;

const EMPTY = new Uint8Array();
const TEXT_DECODER = new TextDecoder();

/** A varint and the offset just past it. */
interface Varint {
  readonly value: number;
  readonly end: number;
}

/**
 * A base-128 varint, low group first.
 *
 * Accumulated by multiplication rather than by shifting: `<<` truncates to 32
 * bits, and a media entry's `size` is a `uint32` whose top bit is enough to
 * make the difference.
 *
 * Bounded by the wire format's ten bytes rather than by the value: a `uint64`
 * within those ten bytes can still exceed `Number.MAX_SAFE_INTEGER`, and
 * refusing it would be refusing a well-formed message.
 */
const varintFailure = (consumed: number): Error => {
  if (consumed === VARINT_MAX_BYTES) {
    return new Error("Malformed protobuf: a varint is longer than the wire format allows");
  }

  return new Error("Malformed protobuf: a varint runs past the end of the message");
};

const varintAt = (data: Uint8Array, at: number): Varint => {
  let value = 0;
  let scale = 1;
  let index = at;

  /* Iterated rather than indexed: `noUncheckedIndexedAccess` would otherwise
     put a fallback on every byte, for a subscript the loop bound already
     proves is in range. The window is what bounds the length: running out of
     it means either corruption or the end of the message, and which one is
     the byte count. */
  for (const byte of data.subarray(at, at + VARINT_MAX_BYTES)) {
    value += (byte & PAYLOAD_MASK) * scale;

    if ((byte & CONTINUATION) === 0) {
      return { end: index + 1, value };
    }

    scale *= PAYLOAD_SCALE;
    index += 1;
  }

  throw varintFailure(index - at);
};

/** One field: a number, and either its varint value or its bytes. */
export interface WireField {
  readonly bytes: Uint8Array;
  readonly fieldNumber: number;
  readonly varint: number;
}

/** How wide a fixed-width value is, for the wire types that carry one. */
const fixedWidth = (wireType: number): number => {
  if (wireType === FIXED_64) {
    return FIXED_64_BYTES;
  }

  if (wireType === FIXED_32) {
    return FIXED_32_BYTES;
  }

  throw new Error(`Malformed protobuf: wire type ${wireType} is not one this reads`);
};

/** One field, and where the next one starts. */
interface DecodedField {
  readonly end: number;
  readonly field: WireField;
}

/** A field's tag: which field it is, how it is encoded, and where its value is. */
interface Tag {
  readonly fieldNumber: number;
  readonly valueAt: number;
  readonly wireType: number;
}

const tagAt = (data: Uint8Array, at: number): Tag => {
  const tag = varintAt(data, at);

  return {
    fieldNumber: Math.floor(tag.value / WIRE_TYPES),
    valueAt: tag.end,
    wireType: tag.value % WIRE_TYPES,
  };
};

const lengthDelimitedAt = (
  data: Uint8Array,
  fieldNumber: number,
  valueAt: number,
): DecodedField => {
  const length = varintAt(data, valueAt);
  const end = length.end + length.value;

  /* `subarray` clamps, so without this a field declaring more bytes than the
     message holds would hand back a short value as if it were whole. */
  if (end > data.length) {
    throw new Error(
      "Malformed protobuf: a length-delimited field runs past the end of the message",
    );
  }

  return { end, field: { bytes: data.subarray(length.end, end), fieldNumber, varint: 0 } };
};

const fieldAt = (data: Uint8Array, at: number): DecodedField => {
  const { fieldNumber, valueAt, wireType } = tagAt(data, at);

  if (wireType === VARINT) {
    const payload = varintAt(data, valueAt);

    return { end: payload.end, field: { bytes: EMPTY, fieldNumber, varint: payload.value } };
  }

  if (wireType === LENGTH_DELIMITED) {
    return lengthDelimitedAt(data, fieldNumber, valueAt);
  }

  /* A fixed-width value nothing here reads. Reported anyway, since stepping
     over one and hiding it are different things. */
  return { end: valueAt + fixedWidth(wireType), field: { bytes: EMPTY, fieldNumber, varint: 0 } };
};

/** Every field of one message, in the order it was written. */
export const readMessage = function* readMessage(data: Uint8Array): Generator<WireField> {
  let at = 0;

  while (at < data.length) {
    const decoded = fieldAt(data, at);
    at = decoded.end;
    yield decoded.field;
  }
};

/** The first field written for `fieldNumber`, or `null` when there is none. */
const firstField = (data: Uint8Array, fieldNumber: number): WireField | null => {
  for (const field of readMessage(data)) {
    if (field.fieldNumber === fieldNumber) {
      return field;
    }
  }

  return null;
};

/** The first varint written for `fieldNumber`, or `null` when there is none. */
export const varintField = (data: Uint8Array, fieldNumber: number): number | null =>
  firstField(data, fieldNumber)?.varint ?? null;

/** Every length-delimited value written for `fieldNumber`, in order. */
export const repeatedField = (data: Uint8Array, fieldNumber: number): Uint8Array[] => {
  const values: Uint8Array[] = [];

  for (const field of readMessage(data)) {
    if (field.fieldNumber === fieldNumber) {
      values.push(field.bytes);
    }
  }

  return values;
};

/** The first string written for `fieldNumber`, or `""` when there is none. */
export const stringField = (data: Uint8Array, fieldNumber: number): string => {
  const field = firstField(data, fieldNumber);

  if (field === null) {
    return "";
  }

  return TEXT_DECODER.decode(field.bytes);
};
