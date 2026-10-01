import { createReadStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { Readable } from "node:stream";
import yauzl from "yauzl";
import { Schema } from "effect";

export const rawDirectory = join(process.cwd(), "data/raw");
export const outputDirectory = join(process.cwd(), "data/generated");
export const Source = Schema.Struct({ file: Schema.String, sha256: Schema.String });
export async function sources() {
  const value: unknown = JSON.parse(await readFile(join(rawDirectory, "sources.json"), "utf8"));
  return Schema.decodeUnknownSync(Schema.Array(Source))(value);
}
export async function hashFile(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    const value: unknown = chunk;
    if (!(value instanceof Uint8Array)) throw new Error("Unexpected file chunk.");
    hash.update(value);
  }
  return hash.digest("hex");
}
async function zipStream(file: string, member: string): Promise<Readable> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error("Invalid archive."));
        return;
      }
      zip.on("error", reject);
      zip.on("end", () => {
        zip.close();
        reject(new Error(`Missing archive entry ${member}`));
      });
      zip.on("entry", (entry: yauzl.Entry) => {
        if (entry.fileName !== member) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            zip.close();
            reject(error ?? new Error("Invalid archive entry."));
            return;
          }
          stream.on("end", () => zip.close());
          stream.on("error", reject);
          resolve(stream);
        });
      });
      zip.readEntry();
    });
  });
}
export async function* lines(file: string, member?: string) {
  const stream = member ? await zipStream(file, member) : createReadStream(file);
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (line && !line.startsWith("#")) yield line.split("\t");
    }
  } finally {
    reader.close();
    stream.destroy();
  }
}
export async function prepareDirectories() {
  await mkdir(rawDirectory, { recursive: true });
  await mkdir(outputDirectory, { recursive: true });
}
