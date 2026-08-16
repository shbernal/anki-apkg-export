# Local Agent Guide

## Read The Docs First

`docs/` holds the detail that used to live in this file. Each page opens with
frontmatter carrying `read_when` hints; read the pages matching the task before
coding.

| Task                              | Page                            |
| --------------------------------- | ------------------------------- |
| Changing what the deck contains   | `docs/reference/deck-format.md` |
| Changing module boundaries        | `docs/architecture.md`          |
| Changing the public API           | `docs/reference/index.md`       |
| Lint, format, gates, dependencies | `docs/tooling.md`               |
| Something imports or builds wrong | `docs/troubleshooting.md`       |

Update the matching page when behavior changes.

## Repository Context

- `anki-apkg-export` lives alongside other Anki-related packages under
  `anki-md-pkgs`; treat `mdanki`, `ankimd`, and `pdfanki` as related but separate
- this package is the base of the chain: `mdanki` depends on it, and `pdfanki`
  depends on `mdanki`
- release it before any downstream package that needs a new version of it
- keep it usable as a standalone library, not only as a piece of `mdanki` or
  `pdfanki`

## Project Scope

- generates Anki `.apkg` deck packages from JavaScript and TypeScript
- published to npm as `@shbernal/anki-apkg-export`, ESM-only, Node.js >= 24
- `src/exporter.ts` holds the deck/media/zip logic, `src/template.ts` the default
  note template, `src/text.ts` Anki's HTML stripper, `src/index.ts` the entry point
- there is no CLI; the package is a library

## Public API Guardrails

- the public surface is `AnkiExport(name, templateOverrides?)` returning
  `addCard`, `addMedia`, and `save`
- treat that surface as published API: changing it needs a deliberate semver
  decision, not incidental cleanup
- keep `exports`, `files`, and `dist` shape intact unless the change is the point
  of the task
- template overrides are `questionFormat`, `answerFormat`, and `css`; keep
  defaults working when adding options

## Validation Workflow

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

## Release Workflow

- publishing runs through `.github/workflows/publish.yml` with npm trusted
  publishing and provenance
- it triggers on a published GitHub release or manual dispatch, and uses the
  protected `npm-publish` environment
- the release tag must match `package.json#version`
- do not `npm publish` or `pnpm publish` by hand
- ask before creating tags, GitHub releases, or publishing
