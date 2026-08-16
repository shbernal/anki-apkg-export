# anki-apkg-export

[![weekly downloads](https://img.shields.io/npm/dw/%40shbernal%2Fanki-apkg-export.svg?label=npm%20downloads&logo=npm)](https://www.npmjs.com/package/@shbernal/anki-apkg-export)
[![total downloads](https://img.shields.io/npm/dt/%40shbernal%2Fanki-apkg-export.svg?label=npm%20total%20downloads&logo=npm)](https://www.npmjs.com/package/@shbernal/anki-apkg-export)

Server-side ESM module for generating Anki `.apkg` decks.

## Requirements

- Node.js >= 24
- ESM

## Install

```sh
pnpm add @shbernal/anki-apkg-export
```

## Usage (Node/TypeScript)

```ts
import fs from "fs";
import AnkiExport from "@shbernal/anki-apkg-export";

const apkg = await AnkiExport("deck-name");

apkg.addMedia("anki.png", fs.readFileSync("anki.png"));

apkg.addCard("card #1 front", "card #1 back");
apkg.addCard("card #2 front", "card #2 back", {
  tags: ["nice", "better card"],
});
apkg.addCard('card #3 with image <img src="anki.png" />', "card #3 back");

const zip = await apkg.save();
fs.writeFileSync("./output.apkg", zip);
console.log(`Package has been generated: output.apkg`);
```

### Template customization

`AnkiExport(name, templateOverrides?)` returns a Promise that resolves to an exporter. You can override `questionFormat`, `answerFormat`, and `css`:

```ts
const apkg = await AnkiExport("customized", {
  questionFormat: "{{Front}}",
  answerFormat: '{{FrontSide}}<hr id="answer">{{Back}}',
  css: ".card { font-family: Arial; font-size: 20px; }",
});
```

### API

- `addCard(front: string, back: string, options?: { tags?: string | readonly string[] })`
- `addMedia(filename: string, data: Buffer | Uint8Array | ArrayBuffer | string)`
- `save(options?: ZipOptions): Promise<Buffer>` (returns the APKG as a Node buffer; `ZipOptions` is [fflate](https://github.com/101arrowz/fflate)'s, e.g. `{ level: 0 }` to store uncompressed)

## Generated decks

Decks are written at **schema 11** (package version Legacy1), which every
current Anki release imports.

The rows are written the way Anki writes them for the same content:

- `sfld` and `csum` come from the first field with its HTML stripped, using
  Anki's own stripper — media filenames are kept, so
  `a <img src="b.png">` sorts as `a  b.png `.
- `mod` columns are epoch **seconds**; only `id` columns are milliseconds.
- New cards are numbered from 1 in the new-card queue, and `col.conf.nextPos`
  is left pointing past the last one used.

One deliberate difference: `col.crt` is pinned to the 04:00 **UTC** day
rollover where Anki uses 04:00 local. Deriving it from the local clock would
make the same deck compress to different bytes in different timezones, and
`crt` only matters for review and learning cards, which this package never
emits.

Saving the same input twice produces byte-identical archives, so callers can
compare or cache on the result.

## Examples

- Server example: `examples/server/server.js`

## Development

- `pnpm install`
- `pnpm run build`
- `pnpm test`
- `pnpm run lint` (oxlint, type-aware)
- `pnpm run format` (oxfmt)
- `pnpm run fixture:regen` rebuilds `test/fixtures/output.apkg` after an
  intended change to the emitted deck

## References

- [APKG format documentation](http://decks.wikia.com/wiki/Anki_APKG_format_documentation)
