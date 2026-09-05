---
doc-schema-version: 1
title: "Architecture"
summary: "The six source modules, what each owns, and the boundaries that should not be rediscovered."
read_when:
  - Changing module boundaries
  - Adding a feature and deciding where it belongs
  - Explaining why the HTML stripper or the template is shaped the way it is
doc_type: "architecture"
---

# Architecture

Ten modules under `src/`, split into a write path and a read path that share
one entry point and one wire constant.

A new module needs a reason better than deduplication. It needs a seam.
`archive.ts` is the sixth because it has one: it knows about ZIP entries, DOS
timestamps, and the media manifest, and nothing at all about sqlite. The
exporter hands it bytes and gets a `.apkg` back.

`MILLISECONDS_PER_SECOND`, by contrast, is declared in `exporter.ts`, in
`template.ts`, and again in `test/exporter.test.ts`, and looks like a module
waiting to happen. It is not. In `template.ts` it belongs to a family with
`MILLISECONDS_PER_HOUR` and `MILLISECONDS_PER_DAY` that the day-rollover maths
needs together; in `exporter.ts` it is one divisor used once; and a test
restating a constant independently is what keeps the assertion from being a
tautology. A module holding `1000` would split the first group to merge the
second. That is the distinction: a shared boundary earns a file, a shared
literal does not.

## Responsibilities

| Module             | Owns                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`         | The public entry point. Resolves and memoizes the sql.js WASM module, reads the clock, then constructs an `Exporter` with a freshly built template. |
| `exporter.ts`      | The deck. Row insertion, id allocation, note identity, and media collection.                                                                        |
| `archive.ts`       | The `.apkg` container: the media manifest, the UTC-pinned ZIP timestamps, and the zipping. Knows nothing about sqlite.                              |
| `template.ts`      | The empty collection: Anki's schema-11 DDL plus its default `conf`, `decks`, `dconf`, and note model, as one SQL script.                            |
| `text.ts`          | A port of Anki's `strip_html_preserving_media_filenames`, which produces the text `sfld` and `csum` derive from.                                    |
| `html-entities.ts` | The 252-name HTML 4 entity table `text.ts` decodes against. Data only.                                                                              |
| `reader.ts`        | The read path's entry point: unpack the container, read the collection, put the media back beside it.                                               |
| `unpack.ts`        | The `.apkg` container, read: package version, the decoy, zstd, and the two media-manifest encodings. Knows nothing about sqlite.                    |
| `collection.ts`    | A collection database, read: schema 11's JSON models and schema 18's tables, and the `unicase` strip that makes the second readable at all.         |
| `protobuf.ts`      | Just enough of the wire format for the three fields Anki keeps in it. Data only, in the sense that it decides nothing.                              |

## Two worldviews, kept apart

The writer holds exactly one assumption about collections and it is strict:
`template.ts` generates the schema, and `_readJsonColumn` treats anything it did
not seed as proof that the collection is not the one this class built.

The reader has the opposite obligation. It must tolerate collections written by
Anki 2.1, by current Anki and by third-party exporters, across three package
versions and two schema versions. That tolerance is why `unpack.ts` is not part
of `archive.ts` and `collection.ts` is not part of `exporter.ts`, even though
each pair is about the same half of the format. The writer's strictness is
correct for the writer and must not leak into the reader, and the reader's
tolerance must not leak back.

The one thing they share is `FIELD_SEPARATOR`, which `exporter.ts` exports and
`collection.ts` splits on. It is a wire constant that the two modules have to
agree about, which is the case the rule below is about.

## Data and control flow

`AnkiExport(name, overrides?, { now }?)` awaits the sql.js module, reads the
clock once if `now` was not supplied, calls `createTemplate(overrides, now)` to
get a SQL script, and hands all three to
`new Exporter(name, { template, sql, now })`.

The constructor runs that script into a fresh in-memory database, which leaves
one seeded deck and one seeded note model in the `col` row's JSON columns. It
then claims a deck id and a model id, and re-keys those two placeholders under
them. `takePlaceholder` takes the placeholder out of the decoded map by the id
`template.ts` seeded it under, so it can be reinserted under the real id rather
than duplicated. `curModel` is pointed at the new model id, because the
template cannot know it.

It used to take whichever entry came last instead, and that worked by accident:
the placeholder ids are above 2^32-1, so they are string keys rather than
integer indices and land after the `Default` deck the template also seeds. A
placeholder deck numbered under that, or one more deck seeded after it, and the
export would rename the wrong one without a word. `PLACEHOLDER_DECK_ID` and
`PLACEHOLDER_MODEL_ID` are exported from `template.ts` so the dependency runs
the way it reads: the template declares its placeholders, the exporter asks for
them.

`addCard(front, back, { tags })` derives a guid, claims a note id, strips the
first field, and inserts one `notes` row and one `cards` row. `addMedia` only
buffers; nothing is written until `save`.

`save(options?)` writes `nextPos` back to `col.conf`, exports the database, and
hands the bytes plus the buffered media to `packageDeck`, which builds the
`media` manifest mapping stringified indices to filenames and zips
`collection.anki2`, `media`, and one numerically named entry per media file. It
does not close the database, because it can be called again.

`close()` does, and is what a caller that keeps building decks in one process
has to reach for; `[Symbol.dispose]` makes `using` do it. Afterwards the
exporter refuses every operation by name rather than faulting inside WASM.

## Boundaries

- **The template is emitted output, not source formatting.** The four default
  objects in `template.ts` are `JSON.stringify`'d into the collection verbatim,
  so their keys and key order are bytes. This is why `sort-keys` and
  `unicorn/no-null` are disabled, and why `no-magic-numbers` is off for that
  file: the numbers are Anki's own schema values.

- **The HTML stripper is a port, not an approximation.** Its order of
  operations is load bearing and matches `rslib/src/text.rs`: media tags first
  on raw HTML, then all remaining tags, then entity decoding. Decoding last is
  why `&lt;img src=x&gt;` survives as literal text. The entity decoder is the
  `htmlescape` crate's, which is all-or-nothing. One bare `&` leaves the whole
  string undecoded. Over 300 cases generated by Anki 26.8.1 itself pin this
  in `test/fixtures/anki-stripped-fields.json`.

- **The stripper has to be linear, not merely equivalent.** rslib's patterns run
  on the Rust `regex` crate, which simulates an automaton and never backtracks,
  so a pattern that is ambiguous there costs nothing. Transcribed into
  JavaScript, the same ambiguity is explored by a backtracking engine: the media
  pattern's attribute run, where `[^>]` matches a quote that a quoted branch
  could also take, ran for forty seconds on a hundred bytes. `src/text.ts` walks
  that run instead, visiting each position once in the order a backtracking
  engine would reach it, which is the order the crate resolves too, since both
  are leftmost-first. Anyone rewriting the module inherits both halves: matching
  Anki's answer, and not hanging on input a caller can craft.

- **The collection is not queried for anything the exporter already knows.**
  `notes.guid` is unindexed in schema 11, so the duplicate check `addCard` does
  per card was a full table scan, and `addCard` was quadratic in deck size:
  24,000 cards took 16s, at 666µs each and climbing. It now consults a map the
  exporter maintains, which is exactly equivalent because this class is the only
  writer of `notes` and `cards` and the template seeds neither. Same work, 102µs
  per card and flat.

  Adding `CREATE INDEX ix_notes_guid` would have fixed the scan too, and is
  wrong: the index would be written into the emitted file, which is meant to
  match what Anki itself writes for the same content.

  The same reasoning retired the rest of the per-card reads. Row ids and queue
  positions are handed out by the exporter, so what a `SELECT ... ORDER BY id
DESC` would report is already in that map; `addCard` now runs no `SELECT` at
  all. This is one mechanism fewer rather than a speed-up. Those queries were
  primary-key paths and cost nothing. `test/exporter.test.ts` watches every
  statement the class can issue and fails on a `select` among them, so a
  duplicate check coming back is reported rather than merely slow.

- **`mod` columns are not identities.** Row `id`s are claimed to be unique;
  uniqueness is meaningless for a modification time, so `mod` is written
  straight from the build instant and never counted up from.

- **Every prepared statement must be freed, by the code that prepared it.**
  sql.js registers each statement on the `Database` and finalizes it only on
  `stmt.free()` or `db.close()`, inside a WASM heap that is created once per
  process and never shrinks. Writes go through `db.run`, which frees internally;
  the one reader that must prepare by hand, `_readJsonColumn`, frees in a
  `finally`. A new `this.db.prepare(...)` outside it is a leak. Note that `db.export()` frees every live statement as a side
  effect, so measuring after `save()` will not show one.

  `close()` now backstops this, but it is a backstop and not the owner: it runs
  when the caller says so, which may be never.

- **No prepared statement outlives the call that made it.** Keeping the two
  insert statements around instead of paying `db.run`'s prepare/bind/free per
  card was measured and rejected: it saves ~6µs of a ~22µs insert, so ~12% of
  `addCard`, and `db.export()` invalidates every live statement, so a cache
  would have to be dropped on each `save()`, and `save()` may be followed by
  more `addCard` calls. Reusing a statement past an export throws with no
  message at all. Not worth it against a per-card cost that is already flat.

- **Reproducibility is a guarantee, not a side effect.** `toArchiveClock`
  rewrites the ZIP entry timestamp so its _local_ components spell the
  original's UTC ones, because fflate writes DOS timestamps from the local
  clock. `col.crt` uses a UTC rollover for the same reason. Anything new that
  reads a local clock breaks byte reproducibility.

- **The clock is read exactly once, in `AnkiExport`.** That reading is threaded
  into `createTemplate(overrides, now)` and stored as the exporter's `now`, so
  the template, the id seeds, every row's `id` and `mod`, and the archive stamp
  cannot disagree about when the deck was built. The other two `Date.now()`
  calls under `src/` are parameter defaults, for callers constructing
  `Exporter` or `createTemplate` directly; nothing below the entry point reads
  the clock on its own. It is one reading rather than one clock because two
  readings can straddle a millisecond. Because it is a parameter and not an
  ambient call, a caller can supply it and get the same bytes in another
  process. A new `Date.now()` anywhere below the entry point reintroduces both
  problems at once.

- **The sort field follows `sortf`, which is pinned to 0.** `sfld` and `csum`
  both come from the stripped _first_ field, never the joined field list. If
  `sortf` ever becomes configurable, both follow it rather than `front`.

## Extension points

- **Template overrides.** `questionFormat`, `answerFormat`, and `css` are the
  supported knobs. New options belong here, and defaults must keep working.
- **`save(options)`.** Forwards fflate's `ZipOptions` untouched, so compression
  level and similar are caller-controlled without new API.
- **`Exporter` is exported as a named export** alongside the default factory,
  for callers that want to construct it with their own sql.js instance.

Changing `AnkiExport`, `addCard`, `addMedia`, or `save` is a published-API
change and needs a deliberate semver decision.
