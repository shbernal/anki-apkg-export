# anki-apkg-export

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

- `addCard(front: string, back: string, options?: { tags?: string | string[] })`
- `addMedia(filename: string, data: Buffer | Uint8Array | ArrayBuffer | string)`
- `save(options?: JSZip.JSZipGeneratorOptions): Promise<Buffer>` (returns the APKG as a Node buffer)

## Examples

- Server example: `examples/server/server.js`

## Development

- `pnpm install`
- `pnpm run build`
- `pnpm test`
- `pnpm run lint`

## References

- [APKG format documentation](http://decks.wikia.com/wiki/Anki_APKG_format_documentation)
