---
doc-schema-version: 1
title: "Tooling"
summary: "The validation gates, the oxlint and oxfmt setup, and why each disabled rule is disabled."
read_when:
  - Running the gates before a commit or release
  - Adding, changing, or removing a lint rule
  - Wondering whether to copy this config to a sibling package
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

`pnpm run fixture:regen` rebuilds `test/fixtures/output.apkg` by rerunning the
golden test with `UPDATE_FIXTURE` set. It is not a standalone script on purpose:
one would need `dist/`, inverting the gate order above, and would duplicate the
deck definition that lives once in `test/_fixture-deck.ts`.

Git hooks are lefthook's: pre-commit lints staged files without `--type-aware`
for speed, pre-push runs the full type-aware lint.

## oxlint And oxfmt

This package uses **oxlint** and **oxfmt**. ESLint, Prettier, and
`typescript-eslint` are gone. It went first among the four `anki-md-pkgs`
packages because it is the base of the dependency chain and the smallest
surface; `mdanki`, `ankimd`, and `pdfanki` are still on ESLint + Prettier, and
that split is intentional rather than drift.

- `.oxlintrc.json` enables all five categories: `correctness`, `suspicious`,
  `perf`, `pedantic`, and `style`. That is a higher bar than the other three
  packages' `recommendedTypeChecked` + `stylisticTypeChecked`.
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

## Why Rules Are Disabled

Every entry in the `rules` block carries a comment saying why. Do not drop those
comments. The reasons fall into four kinds, and a new entry should say which it
is:

| Kind                                | Examples                                                                                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Would change emitted output         | `sort-keys` and `unicorn/no-null` reorder or drop keys `src/template.ts` serializes into the deck                                                                                       |
| Contradicts another enabled rule    | `sort-imports` vs oxfmt's `sortImports`; `import/consistent-type-specifier-style` vs `consistent-type-imports`; `vitest/prefer-to-be-truthy` vs `vitest/prefer-strict-boolean-matchers` |
| Wrong for this package              | `import/no-nodejs-modules` in a Node library; `import/no-named-export` against a published named surface; `new-cap` against the `AnkiExport` factory                                    |
| Pointed at the project's convention | `one-var: never`; `no-magic-numbers` ignoring `-1/0/1`; `prefer-readonly-parameter-types` with `treatMethodsAsReadonly` and an `allow` list                                             |

`overrides` scopes two exemptions: `no-magic-numbers` off for `src/template.ts`,
whose numbers are Anki's own schema values, and the length and statement budgets
plus `vitest/no-hooks` and `init-declarations` off for `test/**`.

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
