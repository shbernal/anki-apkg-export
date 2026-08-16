#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["anki==26.8.1"]
# ///
"""Check that real Anki accepts a deck this package wrote.

The unit tests read a generated deck back with `node:sqlite` and assert on the
rows. That proves the bytes are the ones we meant to write; it does not prove
Anki will take them. This does: it imports the package into a genuine
collection, then runs the same "Check Database" and media checks the desktop app
runs, and fails on anything they report.

    uv run tools/oracle/check_apkg.py                    # test/fixtures/output.apkg
    uv run tools/oracle/check_apkg.py path/to/deck.apkg

Regenerate the fixture deck first (`pnpm run fixture:regen`) if the exporter
changed, or this checks a stale file.
"""

from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
from pathlib import Path

import anki.lang

# Must precede the `anki.collection` import; see gen_stripped_fields.py.
anki.lang.set_lang("en_US")

from anki.collection import Collection  # noqa: E402
from anki.import_export_pb2 import (  # noqa: E402
    ImportAnkiPackageOptions,
    ImportAnkiPackageRequest,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PACKAGE = REPO_ROOT / "test" / "fixtures" / "output.apkg"

# Import-log buckets that mean Anki could not take the deck as written. Notes it
# merely recognises as duplicates are fine; these are not.
FATAL_LOG_FIELDS = (
    "conflicting",
    "missing_notetype",
    "missing_deck",
    "empty_first_field",
)


def describe(col: Collection) -> None:
    """Print what landed, so a failure is readable without a debugger."""
    print("collection after import")
    print("  decks     :", [d.name for d in col.decks.all_names_and_ids()])
    print("  notetypes :", [n.name for n in col.models.all_names_and_ids()])
    print("  notes     :", len(col.find_notes("")))
    print("  cards     :", col.card_count())
    for card_id in col.find_cards(""):
        due, card_type, queue = col.db.first(
            "select due, type, queue from cards where id = ?", card_id
        )
        print(f"    card {card_id}: due={due} type={card_type} queue={queue}")


def check(package: Path) -> list[str]:
    """Import the package and return the problems found, empty when clean."""
    problems: list[str] = []
    tmp = Path(tempfile.mkdtemp())
    col = Collection(str(tmp / "collection.anki2"))
    try:
        request = ImportAnkiPackageRequest(
            package_path=str(package),
            options=ImportAnkiPackageOptions(
                merge_notetypes=False,
                # Both on, so the scheduling and deck-config values the exporter
                # writes are exercised rather than discarded on the way in.
                with_scheduling=True,
                with_deck_configs=True,
            ),
        )
        try:
            log = col.import_anki_package(request).log
        except Exception as error:  # noqa: BLE001 - any failure here is the finding
            return [f"import raised {type(error).__name__}: {error}"]

        print(f"import log ({log.found_notes} notes found)")
        print("  new       :", len(log.new))
        print("  updated   :", len(log.updated))
        print("  duplicate :", len(log.duplicate))
        for field in FATAL_LOG_FIELDS:
            entries = getattr(log, field)
            print(f"  {field:<10}:", len(entries))
            if entries:
                problems.append(f"import log reported {len(entries)} {field}")
        if not log.found_notes:
            problems.append("import found no notes")

        print()
        describe(col)

        print()
        report, ok = col.fix_integrity()
        print("check database:", "ok" if ok else "PROBLEMS")
        if not ok:
            print(report)
            problems.append("check database reported problems")

        missing = col.media.check().missing
        print("missing media :", list(missing))
        if missing:
            problems.append(f"{len(missing)} referenced media file(s) missing")

        return problems
    finally:
        col.close()
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "package",
        nargs="?",
        default=DEFAULT_PACKAGE,
        type=Path,
        help="the .apkg to check (default: test/fixtures/output.apkg)",
    )
    args = parser.parse_args()

    package: Path = args.package.resolve()
    if not package.is_file():
        print(f"no such package: {package}", file=sys.stderr)
        return 2

    print(f"checking {package}\n")
    problems = check(package)

    print()
    if problems:
        for problem in problems:
            print("FAIL:", problem, file=sys.stderr)
        return 1
    print("PASS: anki accepted the package")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
