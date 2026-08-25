# Changelog

Notable changes per release. Versions before 4.0.4 predate this file; see the
[tags](https://github.com/shbernal/anki-apkg-export/tags) for their history.

## 6.0.0

Note identity changes, which is what makes this a major release: **the first
re-import of a deck built by 5.x adds a duplicate of every note, once.** Beyond
that, two inputs the package used to accept quietly and one it used to discard,
plus a stripper that could be made to hang on a hundred bytes.

### Breaking

- **The note guid separates the parts it hashes.** It was `sha1` over
  `deckName + front + back` glued together, so a deck named `ab` with front `c`
  produced the same guid as a deck named `a` with front `bc` — and two notes
  sharing a guid are one note to Anki, the second silently replacing the first.
  The three are now joined with `U+001F`, the character Anki splits `flds` on
  and therefore the one no field can carry, which makes the encoding
  unambiguous by construction. **Every note emitted by an earlier release gets a
  new guid, so re-importing an existing deck lands each note beside its old copy
  instead of updating it.** One round, the same shape as the 5.1.0 boundary, and
  there is no third boundary to come. A card exported at two different instants
  still gets one guid.
- **`addMedia` refuses an empty or whitespace-only filename.** It used to write
  a manifest entry named `""` that no importer can act on. Nothing else about
  the name is checked, and deliberately so: entries are stored under their index
  precisely so a deck can carry filenames a ZIP or a filesystem would refuse.

### Fixed

- **An empty tag array writes no tags.** The joined array was padded at both
  ends whether or not anything survived the join, so `{ tags: [] }` stored two
  spaces where Anki stores nothing, and an empty entry stored a doubled
  separator. Entries with no tag in them are dropped now, and an array that
  yields none writes `""`. **If you pass `[]` for untagged cards — which is what
  `mdanki` does for every one of them — this changes the bytes of every note you
  export.** A preformatted tag string still passes through untouched.
- **The HTML stripper no longer backtracks exponentially.** rslib's media
  pattern is ambiguous about its attribute run, which costs the Rust `regex`
  crate nothing and cost this transcription forty seconds on a 101-byte field:
  `[^>]` matches a quote that a quoted branch could take too, so a tag carrying
  no `src` explored every combination. The run is walked now, each position
  tried once in the order a backtracking engine reaches it, so the answer is
  identical and the same input strips in under a millisecond. Anki's behaviour
  is unchanged and the oracle corpus is still what adjudicates it — 18 cases
  covering unbalanced quotes and hidden `>` were added to it first.
- **The collection selects the exported deck.** `col.conf.curModel` was
  repointed at this export's notetype because the seeded value names one that is
  in no file at all, but `curDeck` and `activeDecks` were left at the empty
  "Default" deck the template also carries. All three name this export now. An
  importing user sees no difference — Anki resolves both against the collection
  the deck lands in — but a `collection.anki2` opened directly no longer starts
  on a deck holding none of the cards. **The emitted bytes change.**
- **`mtime` passed to `save` reaches the archive.** Every entry was stamped with
  the build instant and the caller's bag was applied at the archive level, where
  fflate lets the per-entry value win, so `save({ mtime })` returned the same
  bytes as `save()` while the reference promised the bag was forwarded
  untouched. The default is still the build instant pinned to UTC, which is what
  keeps archives reproducible across timezones; overriding it takes that on.

### Internal

- The suite covers `src/archive.ts` at its own seam, including byte equality
  across three timezones, and pins what the docs promise but nothing held:
  hostile media filenames, the entity table's prototype guard, and that
  `addCard` issues no `SELECT`. Coverage thresholds are a floor now, at the
  100% the suite already reaches.
- The oracle imports a generated deck twice and requires that Anki report no new
  notes, so the re-import claim is re-checked rather than verified once by hand.
- `exporter.ts` keeps one copy of the state it used to keep twice, and
  `src/index.ts` resolves the sql.js wasm directory once per process.

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

### Changed

- **`package.json` no longer carries `main`.** The package has been ESM-only on
  Node >= 24 since 4.0.4, where `exports` is the only entry point a resolver
  consults, so `main: dist/index.js` was a second answer to a question `exports`
  already answered. Nothing resolves differently.

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
