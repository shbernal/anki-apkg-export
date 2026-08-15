import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/* Installed as a dependency this would be: import AnkiExport from 'anki-apkg-export'; */
import AnkiExport from "../../dist/index.js";

/** @param {Readonly<import("../../src/index.js").Exporter>} apkg */
const addCards = (apkg) => {
  apkg.addCard("card #1 front", "card #1 back");
  apkg.addCard("card #2 front", "card #2 back");
  apkg.addCard('card #3 with image <img src="anki.png" />', "card #3 back");
};

const run = async () => {
  const apkg = await AnkiExport("deck-name-node");

  const assetPath = fileURLToPath(new URL("../assets/anki.png", import.meta.url));
  apkg.addMedia("anki.png", fs.readFileSync(assetPath));

  addCards(apkg);

  try {
    const zip = await apkg.save();
    fs.writeFileSync(path.join(process.cwd(), "output.apkg"), zip);
    console.log(`Package has been generated: output.apkg`);
  } catch (error) {
    console.error(error);
  }
};

await run();
