import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Miniflare } from "miniflare";
import { publishObjects, splitSql } from "../scripts/publish-data";

await test("publishes JSON objects and a manifest to real private R2 storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "countries-publish-"));
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    r2Buckets: ["DATA"],
  });
  try {
    await mkdir(join(directory, "cities/AE"), { recursive: true });
    await writeFile(join(directory, "cities/AE/0.json"), '[{"name":"دبي"}]');
    await writeFile(join(directory, "manifest.json"), '{"version":"0123456789abcdef"}');
    await writeFile(join(directory, "search.sql"), "CREATE TABLE unrelated(value TEXT);");
    const bucket = await mf.getR2Bucket("DATA");
    await publishObjects(bucket, directory, "0123456789abcdef");
    assert.equal(
      await (await bucket.get("0123456789abcdef/cities/AE/0.json"))?.text(),
      '[{"name":"دبي"}]',
    );
    assert.equal(
      await (await bucket.get("0123456789abcdef/manifest.json"))?.text(),
      '{"version":"0123456789abcdef"}',
    );
    assert.equal(await bucket.get("0123456789abcdef/search.sql"), null);
  } finally {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("a failed object upload never publishes the release manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "countries-publish-failure-"));
  const keys: string[] = [];
  try {
    await mkdir(join(directory, "cities/AE"), { recursive: true });
    await writeFile(join(directory, "cities/AE/0.json"), "[]");
    await writeFile(join(directory, "manifest.json"), "{}");
    await assert.rejects(
      publishObjects(
        {
          put(key) {
            keys.push(key);
            return Promise.reject(new Error("Storage unavailable"));
          },
        },
        directory,
        "0123456789abcdef",
      ),
      /Storage unavailable/,
    );
    assert.deepEqual(keys, ["0123456789abcdef/cities/AE/0.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("splits large SQL imports without breaking quoted statement data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "countries-sql-"));
  const db = new DatabaseSync(":memory:");
  try {
    const text = "دبي O'Brien; " + "x".repeat(350);
    const literal = text.replace(/'/g, "''");
    const rows = Array.from(
      { length: 22000 },
      (_, index) => `INSERT INTO places VALUES(${index},'${literal}');`,
    );
    await writeFile(
      join(directory, "search.sql"),
      "CREATE TABLE places(id INTEGER PRIMARY KEY,name TEXT);\n" + rows.join("\n") + "\n",
    );
    const paths = await splitSql(directory);
    assert.ok(paths.length > 1);
    for (const path of paths) db.exec(await readFile(path, "utf8"));
    assert.deepEqual(
      { ...db.prepare("SELECT COUNT(*) AS count FROM places").get() },
      { count: 22000 },
    );
    assert.deepEqual(
      { ...db.prepare("SELECT name FROM places WHERE id=21999").get() },
      { name: text },
    );
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
