# anki-apkg-export

[![weekly downloads](https://img.shields.io/npm/dw/%40shbernal%2Fanki-apkg-export.svg?label=npm%20downloads&logo=npm)](https://www.npmjs.com/package/@shbernal/anki-apkg-export)
[![total downloads](https://img.shields.io/npm/dt/%40shbernal%2Fanki-apkg-export.svg?label=npm%20total%20downloads&logo=npm)](https://www.npmjs.com/package/@shbernal/anki-apkg-export)

Read and write Anki `.apkg` decks from Node.js. Hand it a deck name, cards as
HTML, and whatever images or audio those cards reference, and it hands back the
bytes of a file Anki imports. Hand it a package and it hands back the note
types, notes and media inside it.

It is the piece you want when the cards already exist somewhere else, or when
they are already in Anki and you want them out: a database, a set of notes, a
scraped corpus, the output of another tool. Nothing has to go through the Anki
desktop app.

## Requirements

- Node.js >= 24
- ESM

## Install

```sh
pnpm add @shbernal/anki-apkg-export
```

## Usage

```ts
import fs from "node:fs";
import AnkiExport from "@shbernal/anki-apkg-export";

const apkg = await AnkiExport("deck-name");

apkg.addMedia("anki.png", fs.readFileSync("anki.png"));

apkg.addCard("card #1 front", "card #1 back");
apkg.addCard("card #2 front", "card #2 back", {
  tags: ["nice", "better card"],
});
apkg.addCard('card #3 with image <img src="anki.png" />', "card #3 back");

fs.writeFileSync("./output.apkg", await apkg.save());
```

### API

| Call                                    | What it does                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| `AnkiExport(name, template?, options?)` | Opens a deck. `template` overrides the card layout, `options.now` pins the clock. |
| `addCard(front, back, { tags })`        | Writes one note and one card. Both fields are HTML.                               |
| `addMedia(filename, data)`              | Buffers a file that card HTML references by that name.                            |
| `save(zipOptions?)`                     | Returns the `.apkg` as a `Buffer`. Callable more than once.                       |
| `close()`                               | Frees the sql.js database. `using apkg = await AnkiExport(…)` does it for you.    |

Only a process that builds deck after deck needs `close()`; a one-shot script
can ignore it. Full signatures and defaults are in
[docs/reference](docs/reference/index.md).

### Reading a package

```ts
import fs from "node:fs";
import { readApkg } from "@shbernal/anki-apkg-export";

const { notes, notetypes, media } = await readApkg(fs.readFileSync("deck.apkg"));

const byId = new Map(notetypes.map((notetype) => [notetype.id, notetype]));

for (const note of notes) {
  const { fields, isCloze } = byId.get(note.mid) ?? { fields: [], isCloze: false };
  console.log(fields.join(" / "), note.fields, note.tags, isCloze);
}
```

What comes back is Anki's own model, not a flashcard: a note is field values and
tags, and its note type says what those fields are called. `media` maps the name
card HTML references a file by to its bytes.

| Call                  | What it does                                                     |
| --------------------- | ---------------------------------------------------------------- |
| `readApkg(bytes)`     | Reads a package and returns `{ notetypes, notes, media, ... }`.  |
| `readPackage(sql, …)` | The same, for a caller that already holds its own sql.js module. |

The reader takes package versions 1, 2 and 3 and collection schemas 11 and 18
or newer, which covers every `.apkg` Anki has written since 2.1 as well as the
ones third-party tools produce. Anything else is refused by name rather than
half-read. What each of those means is in
[docs/reference/deck-format](docs/reference/deck-format.md).

### Template customization

The second argument overrides the note template, one field at a time. Anything
left out keeps Anki's own default.

```ts
const apkg = await AnkiExport("customized", {
  questionFormat: "{{Front}}",
  answerFormat: '{{FrontSide}}<hr id="answer">{{Back}}',
  css: ".card { font-family: Arial; font-size: 20px; }",
});
```

### Reproducible builds

The deck reads the clock exactly once, so saving the same input twice in one
process already gives identical bytes. Pin that reading to get the same bytes
from any process, on any machine:

```ts
const apkg = await AnkiExport("deck-name", undefined, { now: 1_700_000_000_000 });
```

A build that caches or diffs its decks wants this.

## Generated decks

Decks are **written** at schema 11, package version 1, which every current Anki
release imports. Reading is not the mirror of that: see above for what it takes. Rows are written the way Anki writes them for the same
content, so a deck from here agrees with one Anki would have produced. Notes are
matched on content, so re-importing a regenerated deck updates the collection
instead of doubling it.

The field-by-field contract, the deliberate deviations, and the known
non-conformances are in
[docs/reference/deck-format](docs/reference/deck-format.md).

## Documentation

- [Overview](docs/index.md)
- [Architecture](docs/architecture.md)
- [Reference](docs/reference/index.md) and [deck format](docs/reference/deck-format.md)
- [Tooling](docs/tooling.md) and [troubleshooting](docs/troubleshooting.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)

## Examples

- Building a deck from Node: `examples/node/build-deck.js`

## References

- [`rslib/src/text.rs`](https://github.com/ankitects/anki/blob/main/rslib/src/text.rs).
  Anki's own HTML stripper; `src/text.ts` is a port of it.
- [APKG format documentation](https://decks.fandom.com/wiki/Anki_APKG_format_documentation)
