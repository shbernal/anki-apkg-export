import NAMED_ENTITIES from "./html-entities.js";

/**
 * A port of Anki's `strip_html_preserving_media_filenames`, which produces the
 * text a note's `sfld` and `csum` are derived from.
 *
 * Anki recomputes both on import, so a deck carrying different values still
 * loads — but it loads as a deck that disagrees with the one Anki would have
 * written for the same content. This module exists so it agrees.
 *
 * The order of operations is load bearing, and is the order rslib uses: media
 * tags are replaced first, on the raw HTML, then every remaining tag is
 * removed, and only then are entities decoded. Decoding last is why
 * `&lt;img src=x&gt;` survives as the literal text `<img src=x>` rather than
 * being stripped a second time.
 */

/**
 * The start of an img/audio/video/object/source tag, up to its `src`/`data`
 * attribute, whose filename is captured double quoted, single quoted or bare.
 * Transcribed from `HTML_MEDIA_TAGS` in rslib/src/text.rs, which is written in
 * the regex crate's extended mode with its comments inline.
 */
const HTML_MEDIA_TAGS =
  /<\b(?:img|audio|video|object|source)\b(?:[^>]|"[^"]+?"|'[^']+?')+?\b(?:src|data)\b=(?:"(?<doubleQuoted>[^"]+?)"[^>]*>|'(?<singleQuoted>[^']+?)'[^>]*>|(?<bare>[^ >]+?)(?: [^>]*>|>))/gisu;

/**
 * Comment, style and script blocks together with their contents, then any
 * other tag. Nothing is captured because every match is simply deleted.
 */
const HTML = /(?:<!--.*?-->)|(?:<style.*?>.*?<\/style>)|(?:<script.*?>.*?<\/script>)|(?:<.*?>)/gisu;

const DECIMAL_RADIX = 10;
const HEX_RADIX = 16;

/** `char::from_u32` rejects the surrogate range and anything above the maximum. */
const MAX_CODE_POINT = 0x10_ff_ff;
const FIRST_SURROGATE = 0xd8_00;
const LAST_SURROGATE = 0xdf_ff;

/** `u32::from_str_radix` fails rather than wrapping, so oversized escapes error. */
const MAX_U32 = 0xff_ff_ff_ff;

const NON_BREAKING_SPACE = "\u00A0";

const DIGIT = /^\d$/u;
const HEX_DIGIT = /^[\da-f]$/iu;

/** The two states that accumulate digits, and what each one accepts. */
const NUMERIC_STATES = {
  dec: { radix: DECIMAL_RADIX, digit: DIGIT },
  hex: { radix: HEX_RADIX, digit: HEX_DIGIT },
} as const;

type NumericState = keyof typeof NUMERIC_STATES;
type DecodeState = "entity" | "named" | "normal" | "numeric" | NumericState;

/**
 * One character's worth of progress: the text to append, the partial reference
 * carried forward, and the state to continue in. Handlers return this rather
 * than mutating a shared cursor, so none of them can reach past its own
 * transition.
 */
interface Step {
  readonly emit: string;
  readonly buf: string;
  readonly state: DecodeState;
}

/** `&#41;` / `&#x29;`, with the failure cases `char::from_u32` reports. */
const numericEntity = (digits: string, radix: number): string | null => {
  if (digits === "") {
    return null;
  }

  const value = Number.parseInt(digits, radix);
  if (value > MAX_U32 || value > MAX_CODE_POINT) {
    return null;
  }
  if (value >= FIRST_SURROGATE && value <= LAST_SURROGATE) {
    return null;
  }

  return String.fromCodePoint(value);
};

const stepNormal = (ch: string): Step => {
  if (ch === "&") {
    return { emit: "", buf: "", state: "entity" };
  }

  return { emit: ch, buf: "", state: "normal" };
};

const stepEntity = (ch: string): Step | null => {
  if (ch === "#") {
    return { emit: "", buf: "", state: "numeric" };
  }
  // `&;` names nothing.
  if (ch === ";") {
    return null;
  }

  return { emit: "", buf: ch, state: "named" };
};

const stepNamed = (buf: string, ch: string): Step | null => {
  if (ch !== ";") {
    return { emit: "", buf: buf + ch, state: "named" };
  }

  const named = NAMED_ENTITIES.get(buf);
  if (named === undefined) {
    return null;
  }

  return { emit: named, buf: "", state: "normal" };
};

const stepNumeric = (ch: string): Step | null => {
  if (DIGIT.test(ch)) {
    return { emit: "", buf: ch, state: "dec" };
  }
  // Only a lowercase `x` opens a hex escape, so `&#X41;` is malformed.
  if (ch === "x") {
    return { emit: "", buf: "", state: "hex" };
  }

  return null;
};

const stepDigits = (state: NumericState, buf: string, ch: string): Step | null => {
  const { radix, digit } = NUMERIC_STATES[state];

  if (ch === ";") {
    const decoded = numericEntity(buf, radix);
    if (decoded === null) {
      return null;
    }

    return { emit: decoded, buf: "", state: "normal" };
  }
  if (digit.test(ch)) {
    return { emit: "", buf: buf + ch, state };
  }

  return null;
};

const advance = (state: DecodeState, buf: string, ch: string): Step | null => {
  if (state === "normal") {
    return stepNormal(ch);
  }
  if (state === "entity") {
    return stepEntity(ch);
  }
  if (state === "named") {
    return stepNamed(buf, ch);
  }
  if (state === "numeric") {
    return stepNumeric(ch);
  }

  return stepDigits(state, buf, ch);
};

/** Where the decoder ended up: the text it built, and the state it stopped in. */
interface DecodeResult {
  readonly text: string;
  readonly state: DecodeState;
}

/** Drive the machine over every character, or give up at the first bad one. */
const run = (html: string): DecodeResult | null => {
  let text = "";
  let buf = "";
  let state: DecodeState = "normal";

  for (const ch of html) {
    const step = advance(state, buf, ch);
    if (step === null) {
      return null;
    }

    text += step.emit;
    ({ buf, state } = step);
  }

  return { text, state };
};

/**
 * The `htmlescape` crate's decoder, which is all or nothing: one malformed
 * reference anywhere aborts the whole string and the caller keeps the
 * original. That is why `"a & b"` and `"&amp; & foo"` are left undecoded —
 * their bare `&` runs to the end of the input without ever reaching a `;`.
 *
 * Returns null wherever the crate returns an error.
 */
const decodeHtml = (html: string): string | null => {
  const result = run(html);

  // Stopping mid-reference is an error too, not literal text.
  if (result === null || result.state !== "normal") {
    return null;
  }

  return result.text;
};

/**
 * Decode entities, but only if the whole string decodes. Anki collapses the
 * non-breaking spaces that produces into ordinary ones — and only here, so a
 * literal U+00A0 that was never written as `&nbsp;` is left alone.
 */
const decodeEntities = (html: string): string => {
  /* Also keeps the per-character decoder off the path taken by the fields
     that hold no `&` at all, which is nearly all of them. */
  if (!html.includes("&")) {
    return html;
  }

  const decoded = decodeHtml(html);
  if (decoded === null) {
    return html;
  }

  return decoded.replaceAll(NON_BREAKING_SPACE, " ");
};

const stripHtml = (html: string): string => decodeEntities(html.replaceAll(HTML, ""));

/**
 * Reduce a field to the text Anki stores in `sfld` and hashes into `csum`.
 *
 * Media filenames survive, padded with a space on each side, which is why a
 * field like `a <img src="b.png">` strips to `a  b.png ` — two spaces before
 * the filename and one after. The result is deliberately not trimmed: Anki
 * trims only in `html_to_text_line`, which the note path does not use.
 */
export default function stripHtmlPreservingMediaFilenames(html: string): string {
  return stripHtml(html.replaceAll(HTML_MEDIA_TAGS, " $<doubleQuoted>$<singleQuoted>$<bare> "));
}
