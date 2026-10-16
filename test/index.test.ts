import { describe, expect, it } from "vitest";

import AnkiExport, { readApkg } from "../src/index.js";

/** Any fixed instant; only that both builds are handed the same one matters. */
const FIXED_NOW = 1_700_000_000_000;

describe("the package entry point", () => {
  it("passes the deck name and template overrides through to the collection", async () => {
    expect.hasAssertions();
    const apkg = await AnkiExport("deck-name", {
      questionFormat: "Q: {{Front}}",
      css: ".card { color: red; }",
    });
    apkg.addCard("front", "back");

    const { decks, notetypes } = await readApkg(await apkg.save());

    expect(decks.map((deck) => deck.name)).toContain("deck-name");
    expect(notetypes).toMatchObject([
      { css: ".card { color: red; }", templates: [{ qfmt: "Q: {{Front}}" }] },
    ]);
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
});
