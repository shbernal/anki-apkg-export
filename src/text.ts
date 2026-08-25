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

/**
 * An entity reference: everything between `&` and the first `;`. One pattern
 * covers both spellings, because the crate reads them the same way — a
 * `#`-prefixed body whose digits are not digits is not a name either, so
 * `&#41abc;` and `&#X41;` fail as names rather than as numbers. No `i` flag:
 * the named table is case sensitive, so `&Amp;` is not `&amp;`.
 */
const REFERENCE = /&(?<body>[^;]*);/gu;

/**
 * The two numeric spellings, hex first so its `#x` is tried before the bare
 * `#`. Both digit patterns accept the empty string, so `&#;` and `&#x;` reach
 * `numericEntity`'s own rejection rather than being turned away here.
 */
const NUMERIC_FORMS = [
  { prefix: "#x", radix: HEX_RADIX, digits: /^[\da-f]*$/iu },
  { prefix: "#", radix: DECIMAL_RADIX, digits: /^\d*$/u },
] as const;

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

/** One reference's body, or null where the crate reports an error. */
const decodeReference = (body: string): string | null => {
  for (const { prefix, radix, digits } of NUMERIC_FORMS) {
    if (body.startsWith(prefix)) {
      const value = body.slice(prefix.length);
      if (!digits.test(value)) {
        return null;
      }

      return numericEntity(value, radix);
    }
  }

  /* `&;` names nothing, and neither does anything the table does not hold.
     `&#X41;` arrives here too: only a lowercase `x` opens a hex escape, so it
     is looked up as a name and fails as one. */
  return NAMED_ENTITIES.get(body) ?? null;
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
  /* An `&` outside every reference is one that never reached its `;`, which is
     an error rather than literal text. Measured on the input with the
     references removed, since `&amp;` decodes to an `&` that is not one. */
  if (html.replaceAll(REFERENCE, "").includes("&")) {
    return null;
  }

  let malformed = false;
  const decoded = html.replaceAll(REFERENCE, (reference: string, body: string): string => {
    const value = decodeReference(body);
    if (value === null) {
      malformed = true;
      return reference;
    }

    return value;
  });

  if (malformed) {
    return null;
  }

  return decoded;
};

/**
 * Decode entities, but only if the whole string decodes. Anki collapses the
 * non-breaking spaces that produces into ordinary ones — and only here, so a
 * literal U+00A0 that was never written as `&nbsp;` is left alone.
 */
const decodeEntities = (html: string): string => {
  /* Also keeps the decoder's three scans off the path taken by the fields that
     hold no `&` at all, which is nearly all of them. */
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
