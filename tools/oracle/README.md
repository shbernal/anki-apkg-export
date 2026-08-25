# The Anki oracle

Two checks that run this package's output past the real Anki library instead of
past our own understanding of it. Neither is part of `pnpm test`: they need
Python and a wheel off PyPI, which the JavaScript gates deliberately do not.

## Running them

Both scripts carry [PEP 723](https://peps.python.org/pep-0723/) inline metadata,
so [uv](https://docs.astral.sh/uv/) resolves and caches the pinned `anki` wheel
on first run. There is no virtualenv to create and nothing to activate.

```sh
pnpm run oracle:fixture         # regenerate test/fixtures/anki-stripped-fields.json
pnpm run oracle:fixture:check   # report whether that fixture is current, writing nothing
pnpm run oracle:check           # confirm anki accepts test/fixtures/output.apkg
```

Or call them directly, which is the same thing:

```sh
uv run tools/oracle/gen_stripped_fields.py
uv run tools/oracle/check_apkg.py [path/to/deck.apkg]
```

Without uv, any environment with the pinned `anki` installed works. The scripts
are ordinary Python, and the inline metadata is a comment to everything else:

```sh
python -m venv .oracle && .oracle/bin/pip install anki==26.8.1
.oracle/bin/python tools/oracle/gen_stripped_fields.py
```

## What each one proves

`gen_stripped_fields.py` writes every case in `corpus.py` into the first field of
a note in a genuine collection and reads back the `sfld` and `csum` Anki
computed, committing them as `test/fixtures/anki-stripped-fields.json`. That
fixture is the entire basis for trusting `src/text.ts`, which reimplements
Anki's HTML stripper. A failure in `test/text.test.ts` means this package drifted
from Anki. It is not a fixture to refresh until the diff has been read.

`check_apkg.py` imports a generated deck into a fresh collection, then runs the
same "Check Database" and media checks the desktop app runs. The unit tests read
decks back with `node:sqlite` and prove the bytes are the ones we meant to write;
only this proves Anki will take them. Run it after any change to the emitted
deck, alongside `pnpm run fixture:regen`.

It then imports the same package a second time and requires that Anki report no
new notes and leave the note count alone. That is the half of the note guid's
promise Anki owns: notes are matched on their guid, so a deck arriving in a
collection that already holds it updates rather than duplicates. The other half,
that two builds of identical content carry the same guids, is a property of this
package and is pinned in `test/exporter.test.ts`.

## Pins and provenance

`anki` is pinned exactly, in each script's inline metadata, and the version that
actually produced the fixture is recorded in the fixture itself. The two pins are
kept in step by hand; there are only two.

The fixture carries no timestamp on purpose. A regeneration that changes nothing
must produce an empty diff, or `--check` cannot tell "Anki moved" from "someone
reran the script". `.github/workflows/oracle-drift.yml` leans on that: it runs
monthly against the _latest_ `anki` rather than the pin, and opening a failure
there is how an upstream change to the stripper reaches us.

`named_entities.py` is the `htmlescape` crate's `NAMED_ENTITIES` table, which
Anki reaches through `decode_entities` in `rslib/src/text.rs`. It is a
compile-time Rust constant and cannot be read back out of the installed wheel,
so it is committed here rather than derived at run time.

## Changing the corpus

Add cases to `corpus.py` freely and regenerate in the same commit: the new
expectations come from Anki, not from us. Removing a case silently drops
coverage, so leave cases in place unless the behaviour they pin down is gone.
