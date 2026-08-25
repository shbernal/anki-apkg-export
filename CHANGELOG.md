# Changelog

Notable changes per release. Versions before 4.0.4 predate this file; see the
[tags](https://github.com/shbernal/anki-apkg-export/tags) for their history.

## 5.2.0

A quoting defect that made ordinary CSS unusable, three cases where a deck came
out subtly wrong, and a failed sql.js load that used to stick for the life of
the process. The public surface is unchanged and so are the bytes written for
input that was already valid — but `addCard` now rejects one input it used to
accept, and `addMedia` resolves a repeated filename differently.

### Fixed

- **Template overrides containing `'` build a deck.** The four JSON columns in
  the `col` row were interpolated into single-quoted SQL literals with
  `JSON.stringify`, which escapes `"` but not `'`. A quoted font stack —
  `css: ".card { font-family: 'Arial'; }"` — or an apostrophe in a question
  format threw `near "Arial": syntax error` instead. Overrides are now stored
  verbatim, quotes included, and a value that could have closed the literal and
  appended its own statement no longer can.
- **`addCard` refuses a first field that strips to nothing.** `""`, whitespace
  and `<br>` all produced a note Anki's importer buckets as `empty_first_field`
  and drops, so the deck silently came out short. It throws now, before any row
  is written. A front that is only a media reference is still fine:
  `<img src="a.png">` strips to its filename. **If you pass empty fronts today,
  this is an error where it used to be a silently incomplete deck.**
- **A repeated card no longer skips a new-card queue position.** The counter
  advanced per `addCard` call rather than per note, so adding the same card
  twice left position 1 held by nothing and pointed `col.conf.nextPos` past a
  slot no card occupies. Positions are claimed per note guid now, so the queue
  is contiguous and `nextPos` counts cards.
- **A repeated `addMedia` filename replaces the earlier bytes** instead of
  shipping both under the same name. Anki wrote the first entry into its media
  folder and immediately overwrote it with the second, so the archive carried a
  payload no importer would keep. Last write wins, and the file keeps the index
  it was first given. **If you relied on both entries shipping, only the later
  one does now.**
- **A failed sql.js load no longer sticks.** The memoized module was the
  promise, so a rejection was cached alongside a success and every later
  `AnkiExport` call in the process rethrew the first error. A transient failure
  now clears the memo and the next call retries.

### Added

- **`NOTICE` ships with the package.** npm auto-includes `README`, `LICENSE` and
  `package.json` but not `NOTICE`, which is where this fork's attribution to
  ewnd9's `anki-apkg-export` lives.
- **Published source maps carry their sources.** `dist/*.js.map` shipped while
  `src/` did not, so every map pointed at a path no consumer has.

### Internal

- The HTML entity decoder is a single pass over the references rather than a
  ~140-line character-at-a-time state machine. Failure semantics are unchanged
  down to the odd-looking ones, verified against the 318 oracle-generated cases
  and by comparing both implementations over 200,000 generated inputs.
- `addCard` runs no `SELECT` at all. Row ids and queue positions are handed out
  by the exporter, so the per-card lookups asked the collection for values it
  already knew.
- CI runs the built package through the Node example, so a build that emits
  something unimportable no longer passes every gate.

### Downstream

None. `test/fixtures/output.apkg` is byte-identical to 5.1.0's, so no fixture
regeneration is needed in `mdanki` or `pdfanki`.

**Full changelog**: https://github.com/shbernal/anki-apkg-export/compare/v5.1.0...v5.2.0

## 5.1.0

Note identity, an explicit release path for the database, and a fix for
`addCard`'s cost at deck scale. The existing public surface is unchanged; the
bytes written are not.

### Fixed

- **Note `guid` is `sha1(deckName + front + back)`**, where it was derived from
  the deck id — a value that changed on every run. Anki matches notes on `guid`
  at import, so a regenerated deck used to import as a second copy of every
  note. Verified against Anki 26.8.1: two decks of identical content built hours
  apart now report `new=0` on the second import and leave the note count
  unchanged. What this does and does not buy is in
  [`docs/reference/deck-format.md`](docs/reference/deck-format.md#note-identity)
  — editing a card's text still makes a new note, and renaming a deck still
  orphans its notes.
- **`ZipOptions` is exported.** The 5.0.0 notes said it was; it was not reachable
  from the package entry point until now.

### Added

- **`close()`, and `[Symbol.dispose]` alongside it**, so `using apkg = await
AnkiExport(...)` releases the sql.js database at the end of the block. Without
  it the wasm heap for each exporter was held until the process exited: ten
  build-and-discard rounds grew from 30MB to 41MB, and stay flat at 31MB with
  it. Calling `addCard`, `addMedia`, or `save` after `close` throws rather than
  reading freed memory; `close` twice is a no-op.
- **A clock argument**: `AnkiExport(name, templateOverrides?, { now })`. The
  entry point reads `Date.now()` exactly once and hands that instant to the
  collection rows, the deck and notetype stamps, and the archive timestamps, so
  passing `now` makes a build byte-reproducible. Omitting it behaves as before.

### Performance

- **`addCard` no longer scans the notes table for each card.** It was a query
  per card against a `guid` column with no index, so building a deck cost
  O(n²). Duplicate lookups now go through a map: 24,000 cards went from 16.0s to
  2.4s, and per-card cost from 666µs to a flat 102µs.

### Internal

- `.apkg` packaging moved out of the exporter into `src/archive.ts`, which has
  no sqlite knowledge.
- Coverage is at 100% across statements, branches, functions and lines. The
  numeric-entity cases the HTML decoder rejects are now covered by fixtures
  generated from the real Anki wheel rather than by hand.

### Downstream

Fixtures that pin exported bytes need regenerating against this: `mdanki`, and
`pdfanki` through it.

**Full changelog**: https://github.com/shbernal/anki-apkg-export/compare/v5.0.1...v5.1.0

## 5.0.1

Schema-11 conformance fixes. The public API is unchanged; the bytes written are
not.

### Fixed

- **`notes.mod` / `cards.mod` are epoch seconds, not milliseconds.** The one
  defect that survived import into a user's collection — a 13-digit value read
  as seconds dated notes to roughly the year 58,600. `id` columns stay
  milliseconds.
- **`sfld` and `csum` derive from the stripped first field**, using a faithful
  port of Anki's `strip_html_preserving_media_filenames` rather than the joined
  field list. Media filenames survive stripping, so `a <img src="b.png">` sorts
  as `a  b.png `.
- **New cards are numbered from 1** in the new-card queue instead of sharing one
  hardcoded `due` value, and `col.conf.nextPos` is written back on `save` so a
  card added later does not reuse a position.
- **The collection, both decks and the notetype carry the build time** instead of
  frozen 2014/2015 constants.
- **The dead schema-11 key `vers`** was misspelled `veArs`.

### Docs

New `docs/` directory. The field-by-field deck contract, the deliberate
UTC-rollover deviation in `col.crt`, and the known `guid` non-conformance are in
`docs/reference/deck-format.md`.

**Full changelog**: https://github.com/shbernal/anki-apkg-export/compare/v5.0.0...v5.0.1

## 5.0.0

Replaces jszip with fflate.

### Breaking

- The public `Exporter.zip` JSZip instance is gone — the archive is now built
  inside `save()`.
- `save(options?)` takes fflate's `ZipOptions` instead of JSZip's
  `generateAsync` options. `save()` is still async and still resolves to a
  Buffer, so callers that only await it need no change.

fflate has zero dependencies where jszip pulled in 11 transitive packages.
Archives remain byte-reproducible across timezones, and the output is unchanged
entry-for-entry.

**Full changelog**: https://github.com/shbernal/anki-apkg-export/compare/v4.0.6...v5.0.0

## 4.0.6

Dependency maintenance release.

## 4.0.5

- Update pnpm package manager and package dependencies.
- Publish through npm trusted publishing with provenance.

## 4.0.4

Maintenance release. See the
[full changelog](https://github.com/shbernal/anki-apkg-export/compare/v4.0.3...v4.0.4).
