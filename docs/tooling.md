---
doc-schema-version: 1
title: "Tooling"
summary: "The validation gates, the oxlint and oxfmt setup, and why each disabled rule is disabled."
read_when:
  - Running the gates before a commit or release
  - Adding, changing, or removing a lint rule
  - Wondering whether to copy this config to a sibling package
  - Checking this package against the real Anki library
doc_type: "guide"
---

# Tooling

## Validation Gates

Run in this order; `typecheck` before `build` is deliberate, since `build` is
what produces `dist/`.

```sh
pnpm install --frozen-lockfile
pnpm run format:check   # oxfmt
pnpm run typecheck      # tsc --noEmit
pnpm run lint           # oxlint, type-aware
pnpm test               # vitest
pnpm run build          # tsc -p tsconfig.build.json
```

Before anything release-shaped, also:

```sh
npm pack --dry-run --ignore-scripts
```

`typecheck` runs against `tsconfig.json`, whose `include` covers `src/`, `test/`
**and `vitest.config.ts`**. The config file is in there because a config outside
the gate is a config whose options nobody checks — `vitest.config.ts` carried a
`threads` key removed back in Vitest 1, silently ignored for the package's whole
history. `tsconfig.build.json` narrows `include` back to `src/**/*`, so none of
this reaches `dist/`.

`pnpm run fixture:regen` rebuilds `test/fixtures/output.apkg` by rerunning the
golden test with `UPDATE_FIXTURE` set. It is not a standalone script on purpose:
one would need `dist/`, inverting the gate order above, and would duplicate the
deck definition that lives once in `test/_fixture-deck.ts`.

Git hooks are lefthook's: pre-commit lints staged files without `--type-aware`
for speed, pre-push runs the full type-aware lint.

## The Anki Oracle

`tools/oracle/` holds two Python scripts that check this package against the
real Anki library rather than against our reading of it. They are not part of
`pnpm test` — they need Python and a wheel off PyPI, which the JavaScript gates
deliberately do not.

```sh
pnpm run oracle:fixture   # regenerate test/fixtures/anki-stripped-fields.json
pnpm run oracle:check     # confirm anki accepts test/fixtures/output.apkg
```

Both run through `uv`, which resolves the pinned `anki` wheel from inline
[PEP 723](https://peps.python.org/pep-0723/) metadata; there is no virtualenv to
create. `tools/oracle/README.md` covers the fallback for machines without uv,
what each script proves, and where the entity table came from.

Run `oracle:check` alongside `pnpm run fixture:regen` whenever the emitted deck
changes: the golden test proves the bytes are the ones we meant to write, and
only the oracle proves Anki will take them.

`.github/workflows/oracle-drift.yml` runs both monthly against the _latest_
`anki` rather than the pin. That is the only thing watching for Anki changing
its HTML stripper underneath `src/text.ts`; a failure there is a report to read,
not a regression to revert.

## oxlint And oxfmt

This package uses **oxlint** and **oxfmt**. ESLint, Prettier, and
`typescript-eslint` are gone. It went first among the four `anki-md-pkgs`
packages because it is the base of the dependency chain and the smallest
surface; `mdanki`, `ankimd`, and `pdfanki` are still on ESLint + Prettier, and
that split is intentional rather than drift.

- `.oxlintrc.json` enables all five categories: `correctness`, `suspicious`,
  `perf`, `pedantic`, and `style`. That is a higher bar than the other three
  packages' `recommendedTypeChecked` + `stylisticTypeChecked`.
- Categories are not everything: `unicorn/prefer-node-protocol` belongs to none
  of the five and is switched on by name. If a convention seems to hold by habit
  rather than by a gate, check whether the rule exists but is uncategorized
  before assuming oxlint lacks it.
- `lint` passes `--type-aware`, which needs the `oxlint-tsgolint`
  devDependency. Without it the type-aware rules silently do not run.
- oxfmt uses its own defaults — `printWidth` 100, `sortPackageJson` — plus
  `sortImports`, so **oxfmt owns import ordering**; no lint rule does.
- oxfmt formats Markdown, YAML, and JSON as well as TS/JS, so `pnpm-lock.yaml`
  must stay in `ignorePatterns`.

TypeScript is on **7.x** here. The old 6.x hold across the four packages existed
only because `typescript-eslint` 8.x rejected the TS 7.0 API, and that
dependency is gone from this one. TS 7 was verified to emit byte-identical `.js`
and `.d.ts` against TS 6. Keep `oxlint-tsgolint` in step with the `typescript`
major — its version tracks the TS release it was built against.

## Why `verbatimModuleSyntax` Is Off

`tsconfig.json` turns on `strict` plus `noImplicitOverride`, `isolatedModules`,
`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. The one strictness
knob deliberately left off is `verbatimModuleSyntax`, and it should stay off
unless the import style changes with it.

It conflicts with a style decision this package already made. `.oxlintrc.json`
sets `consistent-type-imports` to `inline-type-imports`, so a module importing
both a value and a type from one specifier writes
`import initSqlJs, { type SqlJsStatic } from "sql.js"`. Under
`verbatimModuleSyntax` tsc emits that verbatim minus the type, leaving
`import initSqlJs, {} from "sql.js"` in `dist/`. Splitting the type onto its own
`import type` line fixes the emit and immediately trips `no-duplicate-imports`
instead — two specifiers, one module.

So the knob costs either odd bytes in shipped output or two suppressed lint
rules, and it buys little here: `isolatedModules` is already on and catches the
single-file-transpiler hazard, the package is ESM-only under `module: NodeNext`,
and `tsc` is the only thing that ever compiles it. Turning it on is a decision
about import _style_, not a ratchet — take it together with
`consistent-type-imports` and `import/consistent-type-specifier-style`, or not
at all.

## Why Rules Are Disabled

Every entry in the `rules` block carries a comment saying why. Do not drop those
comments. The reasons fall into four kinds, and a new entry should say which it
is:

| Kind                                | Examples                                                                                                                                                                                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Would change emitted output         | `sort-keys` and `unicorn/no-null` reorder or drop keys `src/template.ts` serializes into the deck                                                                                                                                                    |
| Contradicts another enabled rule    | `sort-imports` vs oxfmt's `sortImports`; `import/consistent-type-specifier-style` vs `consistent-type-imports`; `vitest/prefer-to-be-truthy` vs `vitest/prefer-strict-boolean-matchers`; `vitest/prefer-called-once` vs `vitest/prefer-called-times` |
| Wrong for this package              | `import/no-nodejs-modules` in a Node library; `import/no-named-export` against a published named surface; `new-cap` against the `AnkiExport` factory                                                                                                 |
| Pointed at the project's convention | `one-var: never`; `no-magic-numbers` ignoring `-1/0/1`; `prefer-readonly-parameter-types` with `treatMethodsAsReadonly` and an `allow` list                                                                                                          |

`overrides` scopes three exemptions: `no-magic-numbers` off for
`src/template.ts`, whose numbers are Anki's own schema values; the length and
statement budgets plus `vitest/no-hooks` and `init-declarations` off for
`test/**`; and the five `no-unsafe-*` rules off for `examples/**`.

That last one is a fifth kind of reason — **the rule has no program to reason
about**. `examples/server/server.js` is plain JavaScript importing the built
`dist/`, so it is in no TypeScript program: `allowJs` is off, and a gitignored
build output cannot be a typecheck input. Its `fs`/`path`/`url` imports resolve
to `error`, and the `no-unsafe-*` rules then report on the absent program rather
than on the code. Excluding `examples/` in `tsconfig.json` does not silence
them; the exemption has to live in `.oxlintrc.json`.

A handful of sites carry `oxlint-disable-next-line` with a reason above it, all
at genuine boundaries: sql.js rows and `JSON.parse` results that only the caller
can type, and the one helper that must mutate the object it is given.

## Copying This To A Sibling Package

`.oxlintrc.json` is **not** a drop-in for `mdanki`, `ankimd`, or `pdfanki`.
Roughly half of what the `style` category adds needed either per-rule
configuration or a documented exemption, and several of those are specific to
this package — the Anki schema literal, the sql.js and `JSON.parse` boundaries,
the `AnkiExport` factory. Migrating another package is its own task per package.

The three formatting styles across the four packages also differ deliberately.
Converging them would rewrite nearly every line and bury real history in
`git blame` for no functional gain. Each repo gates its own style with
`format:check`, which is what actually matters.

## Dependencies

- Check pnpm itself before dependency work, and update `packageManager` when the
  latest pnpm is the same major.
- Keep `minimumReleaseAgeStrict: true` in `pnpm-workspace.yaml`.
- Refresh the four `anki-md-pkgs` packages coherently rather than one in
  isolation.

The runtime dependencies are `sql.js` and `fflate`, and both are load-bearing.
`fflate` writes the ZIP container that an `.apkg` is; Node ships deflate in
`node:zlib` but no archive writer. `sql.js` builds the collection in memory and
hands the bytes back through `db.export()`, which `node:sqlite` cannot match
until `DatabaseSync.prototype.serialize()` — added in Node 26.1.0. Dropping
`sql.js` therefore means `engines.node: ">=26.1"`, a breaking change to
`Exporter`'s `sql` parameter, and a fixture regen, because a different SQLite
build writes different `collection.anki2` bytes for the same deck. That is a
major-version task for after Node 26 reaches LTS, not a cleanup.

Tests read decks back with `node:sqlite` rather than the `sqlite3` package, so
the assertions see the deck through a different SQLite than the one that wrote
it. It is also why nothing here needs a native build step. `node:sqlite` returns
null-prototype rows, which `toStrictEqual` treats as a different type from an
object literal — `test/anki-apkg-export.test.ts` clones them before asserting.
