import { promises as fs } from "fs";
import path from "path";
import JSZip from "jszip";

interface Card {
  front: string;
  back: string;
}

export const addCards = (
  apkg: { addCard: (front: string, back: string) => void },
  list: Card[],
): void => list.forEach(({ front, back }) => apkg.addCard(front, back));

/** Reads a saved deck without touching the filesystem. */
export const unzipDeckToBuffers = async (
  deck: Buffer,
): Promise<Map<string, Buffer>> => {
  const zip = await new JSZip().loadAsync(deck);
  const entries = Object.values(zip.files).filter((file) => !file.dir);

  return new Map(
    await Promise.all(
      entries.map(
        async (file) =>
          [file.name, await file.async("nodebuffer")] as [string, Buffer],
      ),
    ),
  );
};

export const unzipDeckToDir = async (
  pathToDeck: string,
  pathToUnzipTo: string,
): Promise<void> => {
  await fs.mkdir(pathToUnzipTo, { recursive: true });
  const zipContent = await fs.readFile(pathToDeck);
  const zip = await new JSZip().loadAsync(zipContent, { createFolders: true });

  await Promise.all(
    Object.keys(zip.files).map(async (key) => {
      const file = zip.files[key];
      if (!file || file.dir) return;

      const filePath = path.join(pathToUnzipTo, file.name);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const data = await file.async("nodebuffer");
      await fs.writeFile(filePath, data);
    }),
  );
};
