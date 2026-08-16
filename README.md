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

## Usage

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

fs.writeFileSync("./output.apkg", await apkg.save());
```

### Template customization

`AnkiExport(name, templateOverrides?)` accepts `questionFormat`, `answerFormat`,
and `css`:

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
- `save(options?: ZipOptions): Promise<Buffer>`

Full signatures and defaults: [docs/reference](docs/reference/index.md).

## Generated decks

Decks are written at **schema 11** (package version Legacy1), which every
current Anki release imports, with rows written the way Anki writes them for the
same content. Saving the same input twice produces byte-identical archives.

The field-by-field contract, the deliberate deviations, and the known
non-conformances are in [docs/reference/deck-format](docs/reference/deck-format.md).

## Documentation

- [Overview](docs/index.md)
- [Architecture](docs/architecture.md)
- [Reference](docs/reference/index.md) and [deck format](docs/reference/deck-format.md)
- [Tooling](docs/tooling.md) and [troubleshooting](docs/troubleshooting.md)

## Development

```sh
pnpm install
pnpm run format:check && pnpm run typecheck && pnpm run lint && pnpm test && pnpm run build
```

See [docs/tooling](docs/tooling.md) for the full gate sequence and the lint
setup.

## Examples

- Server example: `examples/server/server.js`

## References

- [APKG format documentation](http://decks.wikia.com/wiki/Anki_APKG_format_documentation)
