import { createReadStream, createWriteStream } from "node:fs";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Schema } from "effect";
import { Manifest } from "../src/schema";
import { outputDirectory } from "./common";

export async function release() {
  const pointer: unknown = JSON.parse(await readFile(join(outputDirectory, "latest.json"), "utf8"));
  const { version } = Schema.decodeUnknownSync(
    Schema.Struct({ version: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/)) }),
  )(pointer);
  const directory = join(outputDirectory, version);
  const value: unknown = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  const manifest = Schema.decodeUnknownSync(Manifest)(value);
  if (manifest.version !== version) throw new Error("Dataset version mismatch.");
  return { manifest, directory };
}
export async function publishObjects(
  bucket: {
    put(
      key: string,
      value: string | Uint8Array<ArrayBuffer>,
      options: { httpMetadata: { contentType: string } },
    ): Promise<unknown>;
  },
  directory: string,
  version: string,
) {
  async function* files(path: string, prefix = ""): AsyncGenerator<{ path: string; key: string }> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) yield* files(join(path, entry.name), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith(".json"))
        yield { path: join(path, entry.name), key: `${version}/${prefix}${entry.name}` };
    }
  }
  const pending = new Set<Promise<unknown>>();
  let count = 0;
  for await (const file of files(directory)) {
    if (file.key.endsWith("/manifest.json")) continue;
    const promise = readFile(file.path).then((bytes) =>
      bucket.put(file.key, new Uint8Array(bytes), {
        httpMetadata: { contentType: "application/json" },
      }),
    );
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => undefined,
    );
    if (pending.size >= 8) await Promise.race(pending);
    if (++count % 5000 === 0) console.info(`Published ${count} JSON objects`);
  }
  await Promise.all(pending);
  await bucket.put(
    `${version}/manifest.json`,
    await readFile(join(directory, "manifest.json"), "utf8"),
    { httpMetadata: { contentType: "application/json" } },
  );
}
export async function splitSql(directory: string) {
  const splitDirectory = join(directory, "sql");
  await mkdir(splitDirectory, { recursive: true });
  const reader = createInterface({
    input: createReadStream(join(directory, "search.sql")),
    crlfDelay: Infinity,
  });
  const paths: string[] = [];
  let stream: ReturnType<typeof createWriteStream> | undefined;
  let bytes = 0;
  for await (const line of reader) {
    if (!stream || bytes > 8 * 1024 * 1024) {
      if (stream) {
        stream.end();
        await once(stream, "finish");
      }
      const path = join(splitDirectory, `${String(paths.length).padStart(5, "0")}.sql`);
      paths.push(path);
      stream = createWriteStream(path);
      bytes = 0;
    }
    if (!stream.write(line + "\n")) await once(stream, "drain");
    bytes += Buffer.byteLength(line) + 1;
  }
  if (stream) {
    stream.end();
    await once(stream, "finish");
  }
  return paths;
}
export async function importSql(database: string, directory: string, remote: boolean) {
  for (const file of await splitSql(directory)) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "node_modules/wrangler/bin/wrangler.js",
          "d1",
          "execute",
          database,
          remote ? "--remote" : "--local",
          "--file",
          file,
          "--yes",
        ],
        { stdio: "inherit", env: process.env },
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`D1 import failed (${code}).`)),
      );
    });
  }
}
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  if (!process.argv.includes("--local"))
    throw new Error(
      "Use --local for local data. Remote publishing is handled by npm run deploy with Alchemy.",
    );
  const { Miniflare } = await import("miniflare");
  const { manifest, directory } = await release();
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    r2Buckets: { DATA: "countries-api-local-data" },
    r2Persist: ".wrangler/state/v3/r2",
  });
  try {
    await importSql("countries-api-local-search", directory, false);
    await publishObjects(await mf.getR2Bucket("DATA"), directory, manifest.version);
    const existing = await readFile(".dev.vars", "utf8").catch(() => "");
    await writeFile(
      ".dev.vars",
      existing.replace(/^DATASET_VERSION=.*\n?/gm, "") + `DATASET_VERSION=${manifest.version}\n`,
    );
  } finally {
    await mf.dispose();
  }
  console.info(`Published local dataset ${manifest.version}`);
}
