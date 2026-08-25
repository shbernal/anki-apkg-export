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
 * `HTML_MEDIA_TAGS` in rslib/src/text.rs, which is written in the regex crate's
 * extended mode with its comments inline, split into the tag opening and the
 * `src`/`data` value that closes it. What rslib writes between them,
 * `(?:[^>]|"[^"]+?"|'[^']+?')+?`, is walked by `findMediaValue` rather than
 * matched, for the reasons given there.
 */
const MEDIA_TAG_START = /<\b(?:img|audio|video|object|source)\b/giu;

/**
 * The `src`/`data` attribute and everything after it, whose filename is
 * captured double quoted, single quoted or bare. Sticky rather than global: it
 * is tried at one position at a time, and which positions those are is what the
 * walk decides.
 */
const MEDIA_TAG_VALUE =
  /\b(?:src|data)\b=(?:"(?<doubleQuoted>[^"]+?)"[^>]*>|'(?<singleQuoted>[^']+?)'[^>]*>|(?<bare>[^ >]+?)(?: [^>]*>|>))/iuy;

/** A media tag's filename, and the offset just past the tag it closes. */
interface MediaValue {
  filename: string;
  end: number;
}

/** One found tag: where it opens, where it ends, and the filename it carries. */
interface MediaTag extends MediaValue {
  start: number;
}

/** A segment is at least `"x"`, so its closing quote is never nearer than this. */
const CLOSING_QUOTE_OFFSET = 2;

/** The value alternation, anchored at `at`. Exactly one group ever matches. */
const mediaValueAt = (html: string, at: number): MediaValue | null => {
  MEDIA_TAG_VALUE.lastIndex = at;
  const match = MEDIA_TAG_VALUE.exec(html);
  if (match === null) {
    return null;
  }

  const groups = match.groups ?? {};
  return {
    filename: `${groups.doubleQuoted ?? ""}${groups.singleQuoted ?? ""}${groups.bare ?? ""}`,
    end: at + match[0].length,
  };
};

/** Just past the `"[^"]+?"` segment opening at `at`, or -1 if none opens there. */
const quotedSegmentEnd = (html: string, at: number, quote: string): number => {
  /* `[^"]+?` needs a character of its own, so `""` opens no segment. */
  if (html[at + 1] === quote) {
    return -1;
  }

  const close = html.indexOf(quote, at + CLOSING_QUOTE_OFFSET);
  if (close === -1) {
    return -1;
  }

  return close + 1;
};

/**
 * The positions one step of the attribute run reaches from `at`, ordered so
 * that popping the last one first takes the branch a lazy quantifier prefers.
 */
const stepsFrom = (html: string, at: number): number[] => {
  const char = html[at];

  /* A `>` no quoted segment spans is where the run has to stop. */
  if (char === undefined || char === ">") {
    return [];
  }

  if (char !== '"' && char !== "'") {
    return [at + 1];
  }

  const segment = quotedSegmentEnd(html, at, char);
  if (segment === -1) {
    return [at + 1];
  }

  /* The quote can be spent either way, and `[^>]` is the earlier branch. */
  return [segment, at + 1];
};

/**
 * Walk the attribute run forward from `from`, and return the first `src`/`data`
 * value it reaches.
 *
 * A backtracking engine reads rslib's `(?:[^>]|"[^"]+?"|'[^']+?')+?`
 * exponentially: `[^>]` matches a quote as well, so every quoted segment can be
 * consumed two ways, and a tag with no value in it explores every combination —
 * forty seconds on a hundred bytes. Anki does not pay that, because the regex
 * crate simulates an automaton rather than backtracking.
 *
 * Every branch of the alternation moves forward, so what it is ambiguous about
 * is the route to a position rather than the set of positions it can reach.
 * Trying each position once, in the order a backtracking engine would reach it,
 * gives that engine's answer while visiting n positions instead of 2^n routes.
 * The order matters as much as the set: it is what decides which of several
 * `src=` a tag reports, and the crate decides that the same way.
 *
 * That order is the lazy quantifier's. End the run as early as possible, and
 * where a quote could be either branch, spend it as a single character before
 * spending it as a segment. It is why `<img alt=" src=fake.png " src="real.png">`
 * reports `fake.png`, the filename inside the unbalanced value, as Anki does.
 */
const findMediaValue = (html: string, from: number): MediaValue | null => {
  /* `from` starts visited because the run has to take a step before the value
     can follow it, and every step moves forward, so nothing returns to it. */
  const visited = new Set([from]);
  const pending = stepsFrom(html, from);

  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (!visited.has(at)) {
      visited.add(at);
      const value = mediaValueAt(html, at);
      if (value !== null) {
        return value;
      }

      pending.push(...stepsFrom(html, at));
    }
  }

  return null;
};

/** Every media tag in `html`, in the order a global replace would match them. */
const mediaTags = (html: string): MediaTag[] => {
  MEDIA_TAG_START.lastIndex = 0;
  const found: MediaTag[] = [];

  for (let tag = MEDIA_TAG_START.exec(html); tag !== null; tag = MEDIA_TAG_START.exec(html)) {
    const value = findMediaValue(html, MEDIA_TAG_START.lastIndex);
    if (value === null) {
      /* Nothing in this one, but the next tag may still open inside it. */
      MEDIA_TAG_START.lastIndex = tag.index + 1;
    } else {
      found.push({ start: tag.index, ...value });
      MEDIA_TAG_START.lastIndex = value.end;
    }
  }

  return found;
};

/** Each media tag replaced by its filename, padded with a space on each side. */
const replaceMediaTags = (html: string): string => {
  let out = "";
  let copied = 0;

  for (const { start, end, filename } of mediaTags(html)) {
    out += `${html.slice(copied, start)} ${filename} `;
    copied = end;
  }

  return out + html.slice(copied);
};

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

  /* The crate reads the digits with `u32::from_str_radix`, which errors rather
     than wrapping on anything wider than a u32. Nothing that large survives
     `char::from_u32` either, so the code point bound is the only one that
     ever decides. */
  const value = Number.parseInt(digits, radix);
  if (value > MAX_CODE_POINT) {
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
  return stripHtml(replaceMediaTags(html));
}
