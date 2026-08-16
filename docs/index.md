---
doc-schema-version: 1
title: "anki-apkg-export"
summary: "Start here for what this library does, how to call it, and which page answers which question."
read_when:
  - Getting oriented in this project
  - Deciding which docs page covers a question
  - Updating the main project overview
doc_type: "overview"
---

# anki-apkg-export

A library that builds Anki `.apkg` deck packages from JavaScript and TypeScript.
Published to npm as `@shbernal/anki-apkg-export`.

## What This Project Does

It takes a deck name, some cards, and optionally some media files, and returns
the bytes of an `.apkg` archive. Internally that means seeding an in-memory
SQLite collection with Anki's schema-11 defaults, inserting a note and a card
row per call to `addCard`, and zipping the result with its media manifest.

It intentionally does not own:

- **A CLI.** This is a library. `mdanki` is the tool that wraps it.
- **Markdown, PDF, or any other input format.** Callers pass HTML strings.
- **Multiple notetypes or templates.** One notetype with a Front/Back pair,
  whose question format, answer format, and CSS the caller may override.
- **Scheduling.** Every card it writes is new; it never emits review or
  learning cards, and never writes `revlog` rows.
- **Schema 18 / package version v3.** See [deck format](reference/deck-format.md).

## Quickstart

```sh
pnpm add @shbernal/anki-apkg-export
```

```ts
import fs from "fs";
import AnkiExport from "@shbernal/anki-apkg-export";

const apkg = await AnkiExport("deck-name");

apkg.addMedia("anki.png", fs.readFileSync("anki.png"));
apkg.addCard("card #1 front", "card #1 back");
apkg.addCard("card #2 front", "card #2 back", { tags: ["nice", "better card"] });

fs.writeFileSync("./output.apkg", await apkg.save());
```

Requires Node.js >= 24 and ESM. The full signature list is in the
[reference](reference/index.md).

## Main Workflows

| Question                                                     | Page                                    |
| ------------------------------------------------------------ | --------------------------------------- |
| What are the exported functions and their arguments?         | [Reference](reference/index.md)         |
| What exactly ends up in the generated deck, and why?         | [Deck format](reference/deck-format.md) |
| Where does each responsibility live in `src/`?               | [Architecture](architecture.md)         |
| Which gates run, and why is the lint config shaped that way? | [Tooling](tooling.md)                   |
| An export imported into Anki looks wrong                     | [Troubleshooting](troubleshooting.md)   |

## Verification

The smallest command that proves the package still works:

```sh
pnpm test
```

That includes the golden test, which builds a three-card deck with one media
file under a pinned clock and asserts byte equality against
`test/fixtures/output.apkg`. Any intended change to the emitted deck means
regenerating it with `pnpm run fixture:regen` in the same commit.

The full gate sequence before anything release-shaped is in
[tooling](tooling.md).
