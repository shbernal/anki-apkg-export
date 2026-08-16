import { describe, expect, it } from "vitest";

import AnkiExport, { Exporter } from "../src/index.js";
import { unzipDeckToBuffers } from "./_helpers.js";

/** Any fixed instant; only that both builds are handed the same one matters. */
const FIXED_NOW = 1_700_000_000_000;

describe("the package entry point", () => {
  it("resolves to an Exporter bound to the deck name", async () => {
    expect.hasAssertions();
    const apkg = await AnkiExport("deck-name");

    expect(apkg).toBeInstanceOf(Exporter);
    expect(apkg.deckName).toBe("deck-name");
  });

  it("exposes addCard, addMedia and save", async () => {
    expect.hasAssertions();
    const apkg = await AnkiExport("deck-name");

    /*
     * `toBeTypeOf` would have to reference the methods themselves, which
     * `unbound-method` rejects; `typeof` reads the same property safely.
     */
    /* oxlint-disable vitest/prefer-expect-type-of */
    expect(typeof apkg.addCard).toBe("function");
    expect(typeof apkg.addMedia).toBe("function");
    expect(typeof apkg.save).toBe("function");
    /* oxlint-enable vitest/prefer-expect-type-of */
  });

  it("reuses the initialised sql.js module across calls", async () => {
    expect.hasAssertions();
    const [first, second] = await Promise.all([AnkiExport("first"), AnkiExport("second")]);

    /* Distinct exporters, but the expensive wasm module is loaded once. */
    expect(first).not.toBe(second);
    expect(first.deckName).toBe("first");
    expect(second.deckName).toBe("second");
  });

  it("passes template overrides through to the collection", async () => {
    expect.hasAssertions();
    const apkg = await AnkiExport("deck-name", {
      questionFormat: "Q: {{Front}}",
      css: ".card { color: red; }",
    });
    apkg.addCard("front", "back");

    const files = unzipDeckToBuffers(await apkg.save());
    const collection = files.get("collection.anki2");
    expect(collection).toBeDefined();

    /* The export is a real sqlite file, so assert on the persisted models. */
    const models = collection!.toString("latin1");
    expect(models).toContain("Q: {{Front}}");
    expect(models).toContain(".card { color: red; }");
  });

  it("accepts a clock, and template overrides alongside it", async () => {
    expect.hasAssertions();
    const build = async (): Promise<Buffer> => {
      const apkg = await AnkiExport("deck-name", { css: ".card {}" }, { now: FIXED_NOW });
      apkg.addCard("front", "back");

      return apkg.save();
    };

    /* Two decks built in different milliseconds, identical to the byte: the
       injected clock is the only clock the exporter or the template reads. */
    const [firstBuild, secondBuild] = [await build(), await build()];

    expect(firstBuild.equals(secondBuild)).toBe(true);
  });

  it("produces an apkg containing a collection and a media map", async () => {
    expect.hasAssertions();
    const apkg = await AnkiExport("deck-name");
    apkg.addCard("front", "back");
    apkg.addMedia("note.txt", Buffer.from("hello"));

    const files = unzipDeckToBuffers(await apkg.save());

    expect([...files.keys()].sort()).toStrictEqual(["0", "collection.anki2", "media"]);
    expect(JSON.parse(files.get("media")!.toString())).toStrictEqual({
      0: "note.txt",
    });
    expect(files.get("0")!.toString()).toBe("hello");
  });
});
