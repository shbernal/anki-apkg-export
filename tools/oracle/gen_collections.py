#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["anki==26.8.1", "zstandard"]
# ///
"""Regenerate the reader's fixtures in `test/fixtures/collections/`.

The reader has to survive three package versions, two schema versions, zstd, a
decoy collection and two media-map encodings. None of that can be produced by
this package, which writes one shape and writes it strictly, so the fixtures
come from real Anki instead of from our own understanding of the format.

    uv run tools/oracle/gen_collections.py

Two of the four are exported by Anki directly. The other two are the same bytes
re-framed, because Anki cannot write the containers they represent: the v1
layout predates it, and a bare `collection.anki2` holding schema 18 is what a
user's own profile looks like rather than anything an exporter emits. Each is
built from an Anki export, never hand-assembled, and `derive` below is the whole
of the difference.

The content is synthetic and deliberately small: two basic notes, one of them
carrying an image, and one cloze note. Nothing here is anybody's study material.

Ids and timestamps come from the clock, so a regeneration changes the bytes.
Nothing compares these files byte for byte, and no test may assert on an id.
"""

from __future__ import annotations

import json
import struct
import tempfile
import zipfile
import zlib
from pathlib import Path

import anki.lang

# Must precede the `anki.collection` import; see gen_stripped_fields.py.
anki.lang.set_lang("en_US")

from anki.collection import Collection, DeckIdLimit  # noqa: E402
from anki.import_export_pb2 import ExportAnkiPackageOptions  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = REPO_ROOT / "test" / "fixtures" / "collections"

DECK_NAME = "Botany"
IMAGE_NAME = "venation.png"

# A 4x4 solid green PNG, built rather than committed so the only binary files in
# the repository are the packages themselves.
_PIXELS = b"".join(b"\x00" + bytes((32, 128, 64)) * 4 for _ in range(4))


def _png_chunk(kind: bytes, data: bytes) -> bytes:
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def png() -> bytes:
    header = struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", header)
        + _png_chunk(b"IDAT", zlib.compress(_PIXELS, 9))
        + _png_chunk(b"IEND", b"")
    )


def build(directory: Path) -> Collection:
    """A collection with the three notes every fixture carries."""
    col = Collection(str(directory / "collection.anki2"))
    col.media.write_data(IMAGE_NAME, png())
    deck_id = col.decks.id(DECK_NAME)

    def add(notetype: str, fields: list[str], tags: list[str]) -> None:
        model = col.models.by_name(notetype)
        note = col.new_note(model)
        for index, value in enumerate(fields):
            note.fields[index] = value
        note.tags = tags
        col.add_note(note, deck_id)

    add(
        "Basic",
        ["Leaf venation patterns", "<ul><li>Parallel venation is typical of monocots</li></ul>"],
        ["botany", "plants::leaves"],
    )
    add(
        "Basic",
        ["Which pigment absorbs red light?", f'Chlorophyll <i>a</i> <img src="{IMAGE_NAME}">'],
        [],
    )
    # Cloze is what D-1's note-type policy is about, and its encoding differs
    # between the two schema versions: `models[].type` at 11, a protobuf varint
    # in `notetypes.config` at 18.
    add("Cloze", ["The {{c1::mitochondrion}} makes ATP.", "Also called the powerhouse."], ["biology"])

    return col


def export(col: Collection, out: Path, *, legacy: bool) -> None:
    """`legacy` picks the container: True gives package v2, False gives v3."""
    col.export_anki_package(
        out_path=str(out),
        options=ExportAnkiPackageOptions(
            with_scheduling=True,
            with_deck_configs=True,
            with_media=True,
            legacy=legacy,
        ),
        limit=DeckIdLimit(col.decks.id(DECK_NAME)),
    )


def read(package: Path) -> dict[str, bytes]:
    with zipfile.ZipFile(package) as archive:
        return {item.filename: archive.read(item.filename) for item in archive.infolist()}


def write(package: Path, entries: dict[str, bytes]) -> None:
    # Deflate rather than store, which is what Anki writes and what keeps these
    # files small enough to belong in a repository.
    with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)


def unzstd(data: bytes) -> bytes:
    """Anki writes frames with no content size, so a one-shot decompress refuses."""
    import zstandard  # noqa: PLC0415 - only the v3 paths need it

    return zstandard.ZstdDecompressor().decompressobj().decompress(data)


def media_names(entries: dict[str, bytes]) -> list[str]:
    """The filenames a v3 media map carries, in entry order.

    `MediaEntries` is a repeated `MediaEntry` in field 1, whose own field 1 is
    the name. Read positionally rather than through a generated stub, so this
    script needs nothing but the anki wheel.
    """
    blob = unzstd(entries["media"])
    names: list[str] = []
    offset = 0
    while offset < len(blob):
        key = blob[offset]
        offset += 1
        length = blob[offset]
        offset += 1
        if key != 0x0A:
            raise SystemExit(f"unexpected media map field {key:#x}")
        entry = blob[offset : offset + length]
        offset += length
        if entry[0] != 0x0A:
            raise SystemExit(f"unexpected media entry field {entry[0]:#x}")
        names.append(entry[2 : 2 + entry[1]].decode("utf8"))
    return names


def derive_v1(v2: dict[str, bytes]) -> dict[str, bytes]:
    """Package v1: no `meta`, the collection under its plain name, JSON media."""
    entries = {"collection.anki2": v2["collection.anki21"], "media": v2["media"]}
    entries.update({name: data for name, data in v2.items() if name.isdigit()})
    return entries


def derive_v1_schema18(v3: dict[str, bytes]) -> dict[str, bytes]:
    """A v1 container holding schema 18, so the entry name implies nothing.

    A user's own profile is a bare `collection.anki2` at schema 18, and a reader
    that infers the schema from the filename gets it wrong there. This is that
    case in a package, which is the only place this package's reader can meet it.
    """
    collection = unzstd(v3["collection.anki21b"])
    media = {str(index): name for index, name in enumerate(media_names(v3))}
    entries = {"collection.anki2": collection, "media": json.dumps(media).encode("utf8")}
    # v3 compresses each media file too; v1 and v2 store them as they are.
    entries.update({name: unzstd(data) for name, data in v3.items() if name.isdigit()})
    return entries


def main() -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp())
    col = build(directory)

    v3_path = directory / "v3.apkg"
    v2_path = directory / "v2.apkg"
    export(col, v3_path, legacy=False)
    export(col, v2_path, legacy=True)
    col.close()

    v3, v2 = read(v3_path), read(v2_path)
    written = {
        "v3-schema18.apkg": v3,
        "v2-schema11.apkg": v2,
        "v1-schema11.apkg": derive_v1(v2),
        "v1-schema18.apkg": derive_v1_schema18(v3),
    }

    for name, entries in written.items():
        write(FIXTURES / name, entries)
        size = (FIXTURES / name).stat().st_size
        print(f"{name:22} {size:>8} bytes  {', '.join(entries)}")


if __name__ == "__main__":
    main()
