---
doc-schema-version: 1
title: "Reference"
summary: "The exported API surface: the factory, the exporter methods, and the template override fields."
read_when:
  - Looking up an exported signature or option
  - Checking what counts as a breaking change
  - Verifying docs against the exported contract
doc_type: "reference"
---

# Reference

Everything on this page is published API. Changing it needs a deliberate semver
decision, not incidental cleanup.

## Exports

`@shbernal/anki-apkg-export` is ESM-only and requires Node.js >= 24.

| Export                   | Kind           | Notes                                            |
| ------------------------ | -------------- | ------------------------------------------------ |
| `default` — `AnkiExport` | async function | The factory. Resolves to an `Exporter`.          |
| `Exporter`               | class          | For callers supplying their own sql.js instance. |
| `TemplateOptions`        | type           | The override bag accepted by the factory.        |
| `ExportOptions`          | type           | The second bag: `now`.                           |
| `ZipOptions`             | type           | Re-exported from fflate, for `save`.             |

## `AnkiExport(deckName, template?, options?)`

```ts
function AnkiExport(
  deckName: string,
  template?: TemplateOptions,
  options?: ExportOptions,
): Promise<Exporter>;
```

Async because sql.js loads a WASM module. That module is initialized once per
process and memoized, so repeated calls do not repay the cost.

`deckName` names both the deck and its notetype in the generated collection.

## `ExportOptions`

| Field | Type     | Default      |
| ----- | -------- | ------------ |
| `now` | `number` | `Date.now()` |

The epoch-millisecond instant to build the deck at. It is the **only** clock the
deck reads: the collection's `crt`, `mod`, and `scm`, every row's `id` and
`mod`, and the archive's entry timestamps all derive from this one value.

Without it, saving the same input twice in one process still produces identical
bytes, because the reading is taken once per exporter. Passing it extends that
across processes and machines — same input plus same clock, same bytes — which
is what a build that diffs or caches its decks needs.

```ts
const apkg = await AnkiExport("reproducible", undefined, { now: 1_700_000_000_000 });
```

## `TemplateOptions`

All three are optional; each falls back to Anki's own default.

| Field            | Type     | Default                                         |
| ---------------- | -------- | ----------------------------------------------- |
| `questionFormat` | `string` | `{{Front}}`                                     |
| `answerFormat`   | `string` | `{{FrontSide}}\n\n<hr id="answer">\n\n{{Back}}` |
| `css`            | `string` | Arial, 20px, centered, black on white           |

```ts
const apkg = await AnkiExport("customized", {
  questionFormat: "{{Front}}",
  answerFormat: '{{FrontSide}}<hr id="answer">{{Back}}',
  css: ".card { font-family: Arial; font-size: 20px; }",
});
```

Passing `{}` is equivalent to passing nothing.

## `addCard(front, back, options?)`

```ts
addCard(front: string, back: string, options?: { tags?: string | readonly string[] }): void;
```

Writes one note and one card. Both fields are HTML; whatever is passed is
stored verbatim in `flds`, and the first field additionally drives `sfld` and
`csum` after stripping — see [deck format](deck-format.md).

`tags` accepts either a preformatted string or an array. Array entries have
their spaces replaced with underscores, since Anki separates tags by spaces.

Cards are numbered in the new-card queue in call order, starting at 1.

Adding the same front and back twice writes one note, and re-exporting a deck
produces the same note identities as last time, so re-importing it updates
rather than duplicates. Editing a card's text is a new note — see
[note identity](deck-format.md#note-identity).

## `addMedia(filename, data)`

```ts
addMedia(filename: string, data: Buffer | Uint8Array | ArrayBuffer | string): void;
```

Buffers a media file. `filename` is what card HTML references, e.g.
`<img src="anki.png">`. Nothing is written until `save`, and no check is made
that any card actually references the file.

## `save(options?)`

```ts
save(options?: ZipOptions): Promise<Buffer>;
```

Returns the `.apkg` as a Node `Buffer`. `options` is fflate's own bag, forwarded
to `zipSync` untouched — `{ level: 0 }` stores uncompressed, for example.

Async for call-site compatibility; the zipping itself is synchronous.

Saving the same input twice produces byte-identical archives, so callers can
compare or cache on the result. Across processes that also needs the same
[`now`](#exportoptions).

## `Exporter`

```ts
new Exporter(
  deckName: string,
  options: { template: string; sql: SqlJsStatic; now?: number },
);
```

The class behind the factory, exported for callers that already have a sql.js
instance. `template` is the SQL script `createTemplate` produces, and `now` is
the same clock value that built it — pass one to both or neither. Public
readonly properties: `db`, `topDeckId`, `topModelId`, `separator`, `deckName`.

### There is no disposal method

An exporter holds an open sql.js `Database` for its whole life and nothing
closes it. sql.js allocates that collection inside a WASM heap that is created
once per process and never shrinks, so a process that builds many decks in
sequence keeps the memory of every one of them — dropping the reference and
forcing GC reclaims nothing.

A caller that needs the memory back can call `db.close()` on the public `db`
property, after which the exporter is unusable. Adding a real `close()` to this
class is deliberately deferred: it is an additive API change, and the leak that
made it urgent — one prepared statement per row, never freed — is fixed.

`save` deliberately does **not** close the database, because it is callable more
than once.
