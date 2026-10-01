import { createWriteStream } from "node:fs";
import { access, writeFile, rename } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { hashFile, prepareDirectories, rawDirectory } from "./common";

await prepareDirectories();
const countries = process.env.DATA_COUNTRIES?.split(",").map((code) => code.trim().toUpperCase());
if (countries?.some((code) => !/^[A-Z]{2}$/.test(code)))
  throw new Error("DATA_COUNTRIES must contain comma-separated country codes.");
const files = [
  "countryInfo.txt",
  ...(countries ? countries.map((code) => `${code}.zip`) : ["allCountries.zip"]),
  "alternateNamesV2.zip",
];
const records = [];
for (const file of files) {
  const path = join(rawDirectory, file);
  let exists = false;
  try {
    await access(path);
    exists = true;
  } catch {
    /* A new source needs downloading. */
  }
  if (!exists || process.argv.includes("--refresh")) {
    console.info(`Downloading ${file}`);
    const response = await fetch(`https://download.geonames.org/export/dump/${file}`, {
      signal: AbortSignal.timeout(900000),
    });
    if (!response.ok || !response.body)
      throw new Error(`Download failed: ${file} (${response.status})`);
    const reader = response.body.getReader();
    async function* chunks() {
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) return;
          const value: unknown = result.value;
          if (!(value instanceof Uint8Array)) throw new Error("Unexpected response chunk.");
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    }
    await pipeline(Readable.from(chunks()), createWriteStream(`${path}.partial`));
    await rename(`${path}.partial`, path);
  }
  records.push({ file, sha256: await hashFile(path) });
}
await writeFile(join(rawDirectory, "sources.json"), JSON.stringify(records, null, 2) + "\n");
console.info("Sources downloaded and checksummed. Run npm run data:build.");
