# Local agent guide

## Read the docs first

`docs/` holds the detail this file used to carry. Each page opens with
frontmatter carrying `read_when` hints; read the pages matching the task before
coding.

| Task                              | Page                            |
| --------------------------------- | ------------------------------- |
| Changing what the deck contains   | `docs/reference/deck-format.md` |
| Changing module boundaries        | `docs/architecture.md`          |
| Changing the public API           | `docs/reference/index.md`       |
| Lint, format, gates, dependencies | `docs/tooling.md`               |
| Something imports or builds wrong | `docs/troubleshooting.md`       |
| Checking against the real Anki    | `tools/oracle/README.md`        |

Update the matching page when behavior changes.

## Project scope

- reads and writes Anki `.apkg` deck packages from JavaScript and TypeScript
- published to npm as `@shbernal/anki-apkg-export`, ESM-only, Node.js >= 24
- write path: `src/exporter.ts` holds the deck logic, `src/archive.ts` the
  `.apkg` packaging, `src/template.ts` the default note template, `src/text.ts`
  Anki's HTML stripper
- read path: `src/reader.ts` is its entry, `src/unpack.ts` the container,
  `src/collection.ts` the database, `src/protobuf.ts` the wire format
- `src/index.ts` is the package entry point for both
- **the two paths do not share their assumptions.** The writer knows one layout
  and is strict about it; the reader takes three package versions and two
  schemas. Keep the tolerance out of the writer and the strictness out of the
  reader; see `docs/architecture.md`
- there is no CLI; the package is a library, and nothing in it should assume a
  particular caller

## Public API guardrails

- the published API is `AnkiExport(name, templateOverrides?, { now }?)` returning
  `addCard`, `addMedia`, `save`, and `close`, plus `readApkg(bytes)` and
  `readPackage(sql, bytes)`
- changing it needs a deliberate semver decision, not incidental cleanup
- keep `exports`, `files`, and `dist` shape intact unless the change is the point
  of the task
- template overrides are `questionFormat`, `answerFormat`, and `css`; keep
  defaults working when adding options

## Validation workflow

```sh
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
npm pack --dry-run --ignore-scripts   # before anything release-shaped
```

Any change to the emitted deck also needs `pnpm run fixture:regen` **in the same
commit**. See `docs/tooling.md` for why the order matters.

The reader's fixtures in `test/fixtures/collections/` come from real Anki via
`pnpm run oracle:collections`. They are inputs rather than golden files, and
regenerating them changes their bytes every time, so no test may assert on an id
read out of them.

## Release workflow

- publishing runs through `.github/workflows/publish.yml` with npm trusted
  publishing and provenance
- it triggers on a published GitHub release or manual dispatch, and uses the
  protected `npm-publish` environment
- the release tag must match `package.json#version`
- `CHANGELOG.md` gets the release's section in the same commit as the version
  bump, and the GitHub release body is that section verbatim
- do not `npm publish` or `pnpm publish` by hand
- ask before creating tags, GitHub releases, or publishing
