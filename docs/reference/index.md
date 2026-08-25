---
doc-schema-version: 1
title: "Reference"
summary: "The exported API: the factory, the exporter methods, and the template override fields."
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

| Export            | Kind           | Notes                                                       |
| ----------------- | -------------- | ----------------------------------------------------------- |
| `AnkiExport`      | async function | The default export. The factory; resolves to an `Exporter`. |
| `Exporter`        | class          | For callers supplying their own sql.js instance.            |
| `TemplateOptions` | type           | The override bag accepted by the factory.                   |
| `ExportOptions`   | type           | The second bag, holding `now`.                              |
| `ZipOptions`      | type           | Re-exported from fflate, for `save`.                        |

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
across processes and machines: same input plus same clock, same bytes. That is
what a build that diffs or caches its decks needs.

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

Overrides are stored verbatim, quotes included; nothing needs escaping caller-side.

## `addCard(front, back, options?)`

```ts
addCard(front: string, back: string, options?: { tags?: string | readonly string[] }): void;
```

Writes one note and one card. Both fields are HTML; whatever is passed is
stored verbatim in `flds`, and the first field also drives `sfld` and `csum`
after stripping. See [deck format](deck-format.md).

Throws if `front` strips to nothing — `""`, whitespace and `<br>` all qualify.
Anki's importer reports such notes as `empty_first_field` and drops them, so the
alternative is a deck that quietly loses cards. A front that is only a media
reference is fine: `<img src="a.png">` strips to its filename. `back` may be
empty; Anki only requires the first field.

`tags` accepts either a preformatted string or an array. Array entries have
their spaces replaced with underscores, since Anki separates tags by spaces.

Cards are numbered in the new-card queue in call order, starting at 1. A
repeated card keeps the position it was first given rather than taking a
second one, so the numbering has no holes in it.

Adding the same front and back twice writes one note, and re-exporting a deck
produces the same note identities as last time, so re-importing it updates
rather than duplicates. Editing a card's text is a new note. See
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
to `zipSync` untouched. `{ level: 0 }` stores uncompressed, for example.

Async for call-site compatibility; the zipping itself is synchronous.

Saving the same input twice produces byte-identical archives, so callers can
compare or cache on the result. Across processes that also needs the same
[`now`](#exportoptions).

## `close()`

```ts
close(): void;
[Symbol.dispose](): void;
```

Releases the sql.js database. Idempotent, so calling it twice is a no-op rather
than a double free. It is also final: `addCard`, `addMedia`, and `save` all
throw afterwards, naming the method rather than faulting inside WASM. A deck
already returned by `save` is unaffected; those are plain bytes.

sql.js allocates the collection inside a WASM heap that is created once per
process and never shrinks, so dropping the last reference to an exporter and
forcing a collection reclaims nothing. Only closing the handle does. Measured
over ten rounds of building 2,000 cards and discarding the exporter,
`process.memoryUsage().external` climbs 30 → 41 MB without `close()` and holds
flat at 31 MB with it.

A one-shot script that exits does not need this. A server or a watch loop that
builds deck after deck does.

`Symbol.dispose` means `using` handles it:

```ts
{
  using apkg = await AnkiExport("deck-name");
  apkg.addCard("front", "back");
  await fs.writeFile("out.apkg", await apkg.save());
} // closed here, including on an early return or a throw
```

`save` deliberately does **not** close the database, because it is callable more
than once.

## `Exporter`

```ts
new Exporter(
  deckName: string,
  options: { template: string; sql: SqlJsStatic; now?: number },
);
```

The class behind the factory, exported for callers that already have a sql.js
instance. `template` is the SQL script `createTemplate` produces, and `now` is
the same clock value that built it. Pass one to both or neither. Public
readonly properties: `db`, `topDeckId`, `topModelId`, `separator`, `deckName`.
