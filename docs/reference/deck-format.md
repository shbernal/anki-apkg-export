---
doc-schema-version: 1
title: "Deck format"
summary: "What the generated schema-11 deck contains field by field, where it deliberately deviates from Anki, and what remains non-conformant."
read_when:
  - Changing anything the exporter or template writes into the collection
  - Investigating why an imported deck looks wrong in Anki
  - Deciding whether to move to schema 18 / package version v3
doc_type: "reference"
---

# Deck format

Decks are written at **schema 11**, package version **Legacy1**, which every
current Anki release imports.

The goal is stronger than "the importer accepts it": rows are written the way
Anki writes them for the same content, so an exported deck agrees with the one
the reference implementation would have produced. The values below were
measured against Anki 26.8.1.

## Archive layout

| Entry              | Contents                                                  |
| ------------------ | --------------------------------------------------------- |
| `collection.anki2` | The SQLite collection.                                    |
| `media`            | JSON mapping stringified indices to original filenames.   |
| `0`, `1`, `2`, …   | One entry per media file, named by its index in that map. |

Every entry's timestamp is pinned to UTC, so the same input compresses to the
same bytes on any machine.

## Timestamp widths

Getting these confused is the defect class this format is most prone to, because
Anki keeps whatever an imported row carries. A millisecond value read as seconds
lands tens of thousands of years in the future and stays there.

| Field                         | Unit                                |
| ----------------------------- | ----------------------------------- |
| `notes.id`, `cards.id`        | milliseconds                        |
| `notes.mod`, `cards.mod`      | **seconds**                         |
| `col.mod`, `col.scm`          | milliseconds                        |
| `col.crt`                     | seconds, pinned to the day rollover |
| `decks[].mod`, `models[].mod` | **seconds**                         |

`dconf[1].mod` is `0`. That is Anki's own default, not a stale value.

Unlike `mod`, `sfld` and `csum` are recomputed by the importer, so a wrong value
there is cosmetic in the collection but still means the file disagrees with Anki.

## Notes

- **`flds`** is `front + U+001F + back`, verbatim, including any HTML.
- **`sfld`** is the first field with its HTML stripped by the port in
  `src/text.ts`. Media filenames survive, padded with a space each side, so
  `a <img src="b.png">` sorts as `a  b.png `, two spaces before the filename
  and one after. The result is deliberately not trimmed; Anki trims only in
  `html_to_text_line`, which the note path does not use.
- **`csum`** is the first four bytes of `sha1(sfld)` read big endian, over the
  _stripped first field_, never the joined field list.
- **`guid`** is sha1 hex of `deckName + front + back`, concatenated with no
  separator. See [note identity](#note-identity) for what that buys and costs,
  and [known non-conformance](#known-non-conformance) for its shape.
- **`usn`** is `-1`, and `flags` and `data` are empty.

Which field sorts is chosen by the notetype's `sortf`, pinned to `0` here. If
that ever becomes configurable, `sfld` and `csum` follow it rather than `front`.

## Cards

Every card is new: `type` and `queue` are both `0`, and `ivl`, `factor`, `reps`,
`lapses`, `left`, `odue`, and `odid` are all `0`. No `revlog` rows are written.

**`due`** is therefore the card's position in the new-card queue, numbered from
1 in call order. `col.conf.nextPos` is written back on `save` so it points past
the last position used, and a card the user adds later does not reuse one.

That reading of `due` only holds for new cards. For a review card `due` is a day
counted from `col.crt`; for a learning card it is a timestamp.

## Note identity

Anki matches notes on `guid` at import: a guid it already has updates that note,
a guid it does not have adds one. Everything below follows from that.

The guid is `sha1(deckName + front + back)`, so **the same card exported twice is
the same note to Anki**, and re-importing a regenerated deck leaves the
collection at the same note count rather than doubling it. Verified against Anki
26.8.1: importing two decks of identical content built hours apart reports
`new=0` on the second and leaves the note count unchanged.

Three consequences, all of them structural rather than fixable:

- **Editing a card's text makes a new note.** Content is the identity, so an
  edited card has a different guid and imports alongside the original instead of
  replacing it. Anki's own note ids do not have this problem because they are
  assigned once and stored; this package holds no state between runs and has
  nothing else to derive identity from.
- **Renaming a deck orphans its notes.** The name is in the hash, so every note
  in the renamed deck is new. This is the deliberate trade: dropping the name
  would make identical content in two different decks a single note, and one
  deck's copy would then follow the other's edits.
- **Decks written before 5.1.0 do not match ones written after.** That release
  removed the deck id from the hash. A user re-exporting an existing deck across
  that boundary gets one round of duplicates, once.

## Deliberate deviations

**`col.crt` uses the 04:00 UTC rollover where Anki uses 04:00 local.** Anki's
default rollover hour is 4, applied to the local clock. Deriving `crt` locally
would make the same deck compress to different bytes in different timezones,
which is exactly what the archive's UTC timestamp pinning exists to prevent.
`crt` only converts day numbers for review and learning cards, and this package
emits neither.

## Known non-conformance

**`guid` shape.** Anki uses base91 of a random 64-bit int, roughly 10
characters; this writes 40-char sha1 hex. Anki treats `guid` as opaque text, so
this imports correctly and the shape is the only non-conformance; what the hash
is taken over is covered under [note identity](#note-identity). A random guid
would match Anki's shape but would defeat that entirely, since this package
keeps no state between runs to remember it by.

## Out of scope

- **Schema 18 / package version v3.** Not planned here; Legacy1 is what this
  package targets.
- **More than one notetype or template.** Product scope, not a limitation to fix
  incidentally.

## Changing any of this

The golden test in `test/deck-round-trip.test.ts` asserts byte equality against
`test/fixtures/output.apkg` under a pinned clock, so every change above
invalidates it. Regenerate with `pnpm run fixture:regen` **in the same commit**
as the behavioral change, so the byte diff and its reason land together.

Emitted-byte changes also break fixtures in `mdanki`, and in `pdfanki` through
it. Those packages need a matching update in the same pass.
