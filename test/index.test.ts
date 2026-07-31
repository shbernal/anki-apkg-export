import { describe, expect, it } from "vitest";

import AnkiExport, { Exporter } from "../src/index.js";
import { unzipDeckToBuffers } from "./_helpers.js";

describe("AnkiExport", () => {
  it("resolves to an Exporter bound to the deck name", async () => {
    const apkg = await AnkiExport("deck-name");

    expect(apkg).toBeInstanceOf(Exporter);
    expect(apkg.deckName).toBe("deck-name");
  });

  it("exposes addCard, addMedia and save", async () => {
    const apkg = await AnkiExport("deck-name");

    expect(typeof apkg.addCard).toBe("function");
    expect(typeof apkg.addMedia).toBe("function");
    expect(typeof apkg.save).toBe("function");
  });

  it("reuses the initialised sql.js module across calls", async () => {
    const [first, second] = await Promise.all([
      AnkiExport("first"),
      AnkiExport("second"),
    ]);

    // Distinct exporters, but the expensive wasm module is loaded once.
    expect(first).not.toBe(second);
    expect(first.deckName).toBe("first");
    expect(second.deckName).toBe("second");
  });

  it("passes template overrides through to the collection", async () => {
    const apkg = await AnkiExport("deck-name", {
      questionFormat: "Q: {{Front}}",
      css: ".card { color: red; }",
    });
    apkg.addCard("front", "back");

    const files = unzipDeckToBuffers(await apkg.save());
    const collection = files.get("collection.anki2");
    expect(collection).toBeDefined();

    // sql.js can reopen its own export, so assert on the real persisted models.
    const models = collection!.toString("latin1");
    expect(models).toContain("Q: {{Front}}");
    expect(models).toContain(".card { color: red; }");
  });

  it("produces an apkg containing a collection and a media map", async () => {
    const apkg = await AnkiExport("deck-name");
    apkg.addCard("front", "back");
    apkg.addMedia("note.txt", Buffer.from("hello"));

    const files = unzipDeckToBuffers(await apkg.save());

    expect([...files.keys()].sort()).toEqual([
      "0",
      "collection.anki2",
      "media",
    ]);
    expect(JSON.parse(files.get("media")!.toString())).toEqual({
      0: "note.txt",
    });
    expect(files.get("0")!.toString()).toBe("hello");
  });
});
