import { readFileSync } from "fs";

/**
 * The one definition of the deck frozen in test/fixtures/output.apkg.
 *
 * The byte-equality assertion and the regeneration path both build the deck
 * from here, so the fixture cannot drift from the test that guards it.
 */

/**
 * Pinned so ids, guids and the archive's timestamps are reproducible. Anything
 * that reads the clock has to go through `Date.now`, which the caller fakes.
 */
export const FIXTURE_NOW = 1_482_680_798_652;

export const FIXTURE_DECK_NAME = "deck-name";
export const FIXTURE_MEDIA_NAME = "anki.png";

interface FixtureCard {
  front: string;
  back: string;
  tags?: readonly string[];
}

export const FIXTURE_CARDS: readonly Readonly<FixtureCard>[] = [
  { front: "card #1 front", back: "card #1 back", tags: ["food", "fruit"] },
  { front: "card #2 front", back: "card #2 back" },
  { front: 'card #3 with image <img src="anki.png" />', back: "card #3 back" },
];

export const readFixture = (name: string): Buffer =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url));

/** The subset of the exporter this module needs, so it works against src or dist. */
interface FixtureDeck {
  addCard: (front: string, back: string, options?: Readonly<{ tags?: readonly string[] }>) => void;
  addMedia: (filename: string, data: Buffer) => void;
  save: () => Promise<Buffer>;
}

export const buildFixtureDeck = async (
  create: (deckName: string) => Promise<FixtureDeck>,
): Promise<Buffer> => {
  const apkg = await create(FIXTURE_DECK_NAME);
  apkg.addMedia(FIXTURE_MEDIA_NAME, readFixture(FIXTURE_MEDIA_NAME));

  FIXTURE_CARDS.forEach(({ front, back, tags }: Readonly<FixtureCard>) => {
    // An untagged card passes no options at all, the way a caller would.
    if (tags === undefined) {
      apkg.addCard(front, back);
      return;
    }

    apkg.addCard(front, back, { tags });
  });

  return apkg.save();
};
