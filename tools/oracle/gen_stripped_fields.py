#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["anki==26.8.1"]
# ///
"""Regenerate `test/fixtures/anki-stripped-fields.json` from real Anki.

Every case in `corpus.py` is written into the first field of a note in a genuine
collection, and the `sfld` / `csum` the reference implementation computed are
read straight back out of the `notes` table. Nothing here reimplements Anki's
HTML stripping -- that is the whole point, since `src/text.ts` is the
reimplementation being checked.

    uv run tools/oracle/gen_stripped_fields.py

Pass `--check` to fail instead of writing when the fixture is out of date; that
is what the scheduled drift workflow runs.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from importlib.metadata import version as installed_version
from pathlib import Path

import anki.lang

# `field_checksum` reaches for a translation and dies on `NoneType.strip_html`
# unless a language is set, and it has to happen before `anki.collection` is
# imported. Leave this above the import below.
anki.lang.set_lang("en_US")

from anki.collection import Collection  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))

from corpus import CASES  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "test" / "fixtures" / "anki-stripped-fields.json"


def anki_version() -> str:
    """The version actually installed, not the one the script asks for.

    This is the distribution version, which matches the pin above and what you
    would `pip install`. `anki.buildinfo.version` zero-pads the month
    ("26.08.1") and would read as a different release to anyone comparing it
    against the pin.
    """
    return installed_version("anki")


def collect() -> list[dict[str, object]]:
    """Add one note per case and read back what Anki stored for it."""
    tmp = tempfile.mkdtemp()
    col = Collection(os.path.join(tmp, "collection.anki2"))
    try:
        notetype = col.models.by_name("Basic")
        deck_id = col.decks.id("oracle")

        cases: list[dict[str, object]] = []
        for text in CASES:
            note = col.new_note(notetype)
            note.fields[0] = text
            note.fields[1] = "back"
            col.add_note(note, deck_id)
            sfld, csum = col.db.first("select sfld, csum from notes where id = ?", note.id)
            # `sfld` comes back as an int when the field parses as one.
            cases.append({"input": text, "sfld": str(sfld), "csum": csum})
        return cases
    finally:
        col.close()


def render(cases: list[dict[str, object]]) -> str:
    """The fixture text, deliberately free of anything time-varying.

    No timestamp: a regeneration that changes nothing must produce an empty
    diff, or the drift check cannot tell "Anki moved" from "someone reran it".
    """
    document = {
        "ankiVersion": anki_version(),
        "generator": "tools/oracle/gen_stripped_fields.py",
        "cases": cases,
    }
    return json.dumps(document, ensure_ascii=False, indent=2) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit non-zero if the committed fixture differs, and write nothing",
    )
    args = parser.parse_args()

    text = render(collect())
    current = FIXTURE.read_text(encoding="utf-8") if FIXTURE.exists() else None

    if args.check:
        if current == text:
            print(f"fixture is current against anki {anki_version()} ({len(CASES)} cases)")
            return 0
        print(
            f"fixture is STALE against anki {anki_version()}.\n"
            "Anki changed how it stores stripped fields, or the corpus changed.\n"
            "Rerun without --check, then read the diff as a report on src/text.ts.",
            file=sys.stderr,
        )
        return 1

    FIXTURE.write_text(text, encoding="utf-8")
    verb = "unchanged" if current == text else "updated"
    print(f"{verb}: {FIXTURE.relative_to(REPO_ROOT)} ({len(CASES)} cases, anki {anki_version()})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
