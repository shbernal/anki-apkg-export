import { promises as fs } from "fs";
import path from "path";

import { unzipSync } from "fflate";

interface Card {
  front: string;
  back: string;
}

export const addCards = (
  apkg: Readonly<{ addCard: (front: string, back: string) => void }>,
  list: readonly Readonly<Card>[],
): void => {
  list.forEach(({ front, back }: Readonly<Card>) => {
    apkg.addCard(front, back);
  });
};

/** Reads a saved deck without touching the filesystem. */
export const unzipDeckToBuffers = (deck: Buffer): Map<string, Buffer> => {
  const entries = Object.entries(unzipSync(deck)).filter(
    ([name]: readonly [string, Uint8Array]) => !name.endsWith("/"),
  );

  return new Map(
    entries.map(([name, data]: readonly [string, Uint8Array]) => [name, Buffer.from(data)]),
  );
};

export const unzipDeckToDir = async (pathToDeck: string, pathToUnzipTo: string): Promise<void> => {
  await fs.mkdir(pathToUnzipTo, { recursive: true });
  const files = unzipDeckToBuffers(await fs.readFile(pathToDeck));

  await Promise.all(
    [...files].map(async ([name, data]: readonly [string, Buffer]) => {
      const filePath = path.join(pathToUnzipTo, name);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, data);
    }),
  );
};
