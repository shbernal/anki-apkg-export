# Contributing

Bug reports, pull requests, and questions are welcome. This page is the
development side of the project. [README.md](README.md) covers using the
published package, and [AGENTS.md](AGENTS.md) is the short guide to read before
touching the code.

## Setup

```sh
git clone https://github.com/shbernal/anki-apkg-export.git
cd anki-apkg-export
corepack enable   # activates the pnpm version pinned in package.json
pnpm install
```

Node.js >= 24, ESM only. Tests run against `src/`, so nothing needs building
first. Installing also installs the lefthook git hooks.

## Gates

Run these before pushing. CI runs the same five, under the same names, on Node
24 and 26.

```sh
pnpm run format:check   # oxfmt
pnpm run typecheck      # tsc --noEmit
pnpm run lint           # oxlint, type-aware
pnpm test               # vitest
pnpm run build          # tsc -p tsconfig.build.json
```

`typecheck` before `build` is deliberate, since `build` is what writes `dist/`.
Anything release-shaped also gets `npm pack --dry-run --ignore-scripts`.

While iterating there are `pnpm run test:watch`, `pnpm run build:watch`, and
`pnpm run test:coverage`.

Pre-commit formats the staged files and lints them without `--type-aware` for
speed; pre-push runs the full lint, the typecheck, and the tests. Do not bypass
the hooks. [docs/tooling.md](docs/tooling.md) explains the lint setup and why
each disabled rule is disabled.

## Changing what the deck contains

`test/deck-round-trip.test.ts` builds a deck under a pinned clock and asserts
byte equality against `test/fixtures/output.apkg`, so any change to the emitted
bytes fails it by design. Regenerate the fixture with `pnpm run fixture:regen`
**in the same commit** as the change, so the new bytes and their reason land
together.

That test proves the bytes are the ones we meant to write. Only Anki proves Anki
will take them, so follow with `pnpm run oracle:check`. The oracle needs Python
and [uv](https://docs.astral.sh/uv/) and is deliberately not part of `pnpm test`;
see [tools/oracle/README.md](tools/oracle/README.md).

Read [docs/reference/deck-format.md](docs/reference/deck-format.md) first. It
records what every field holds and which differences from Anki are deliberate.

## Layout

```text
src/index.ts          entry point; loads sql.js and reads the clock once
src/exporter.ts       the deck: rows, ids, note identity, media collection
src/archive.ts        the .apkg container: media manifest, zipping, UTC timestamps
src/template.ts       the empty collection, as one SQL script
src/text.ts           a port of Anki's HTML stripper
src/html-entities.ts  the named-entity table that stripper decodes with
test/                 vitest suites and fixtures
tools/oracle/         Python checks against the real anki library
docs/                 durable documentation, one page per subject
```

The boundaries between those modules, and the reasons they sit where they do,
are in [docs/architecture.md](docs/architecture.md).

## Documentation

Durable documentation lives in `docs/`, and each page's frontmatter says when to
read it. Update the page a change invalidates in the same commit as the change.
The table in `AGENTS.md` maps a task to its page.

## Public API

The published API is `AnkiExport(name, templateOverrides?, { now }?)` and the
`addCard`, `addMedia`, `save`, and `close` it returns. Changing it is fine when
it makes the library clearer or safer, but it is a semver decision rather than
incidental cleanup, and it belongs in [CHANGELOG.md](CHANGELOG.md) with a
migration note. There are no deprecation cycles here.

`mdanki` depends on this package, and `pdfanki` depends on `mdanki`, so a change
to the emitted bytes breaks fixtures downstream. Say so in the pull request.

## Commits

One independent change per commit. A behavior change and its doc update belong
together; a rename and a new feature do not. Commit messages carry no AI
attribution trailers, and a shared `commit-msg` hook rejects them.

## Issues and pull requests

GitHub issues are the only tracker. A report should say what you ran, what you
got, and what you expected. When it concerns a generated deck, attach the deck
or the handful of lines that build it; either beats describing it.

Fully AI-generated issues and pull requests are welcome. Say so in the body, and
name the harness and the model you used.
