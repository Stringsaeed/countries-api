import { Miniflare } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { City } from "../src/schema";
import { normalizeSearch } from "../src/query";
import { release } from "./publish-data";

const { manifest, directory } = await release();
const country = process.argv[2] ?? "AE";
if (!/^[A-Z]{2}$/.test(country)) throw new Error("Supply an uppercase country code.");
const mf = new Miniflare({
  modules: true,
  scriptPath: "dist/worker.js",
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  bindings: {
    ENVIRONMENT: "local",
    DEV_AUTH_TOKEN: "local-smoke-test",
    DATASET_VERSION: manifest.version,
    APPLE_APP_ID_PREFIX: "UNCONFIGURED",
    APPLE_BUNDLE_ID: "UNCONFIGURED",
  },
  r2Buckets: ["DATA"],
  d1Databases: ["SEARCH"],
  durableObjects: { APP_ATTEST: { className: "AppAttestDevice", useSQLite: true } },
  ratelimits: {
    AUTH_LIMIT: { namespace_id: "1001", simple: { limit: 1000, period: 60 } },
    DATA_LIMIT: { namespace_id: "1002", simple: { limit: 1000, period: 60 } },
  },
});
try {
  const bucket = await mf.getR2Bucket("DATA");
  await bucket.put(`${manifest.version}/manifest.json`, JSON.stringify(manifest));
  const db = await mf.getD1Database("SEARCH");
  await db.exec(
    "CREATE TABLE cities(id INTEGER PRIMARY KEY,countryCode TEXT,ordinal INTEGER,payload TEXT); CREATE INDEX city_country_order ON cities(countryCode,ordinal); CREATE VIRTUAL TABLE city_search USING fts5(countryCode,names,content='',prefix='2 3 4');",
  );
  let count = 0;
  const files = (await readdir(join(directory, "cities", country))).sort(
    (a, b) => parseInt(a) - parseInt(b),
  );
  for (const file of files) {
    const text = await readFile(join(directory, "cities", country, file), "utf8");
    await bucket.put(`${manifest.version}/cities/${country}/${file}`, text);
    const value: unknown = JSON.parse(text);
    const cities = Schema.decodeUnknownSync(Schema.Array(City))(value);
    const statements = [];
    for (const city of cities) {
      statements.push(
        db
          .prepare("INSERT INTO cities VALUES(?,?,?,?)")
          .bind(city.id, country, ++count, JSON.stringify(city)),
      );
      statements.push(
        db
          .prepare("INSERT INTO city_search(rowid,countryCode,names) VALUES(?,?,?)")
          .bind(
            city.id,
            country.toLowerCase(),
            normalizeSearch(`${city.name.en} ${city.name.ar ?? ""}`),
          ),
      );
    }
    await db.batch(statements);
  }
  if (count !== manifest.countryCityCounts[country])
    throw new Error("Country page count mismatch.");
  const paths = [
    "/v1/countries.json",
    "/v1/countries.json?lang=ar",
    `/v1/countries/${country}/cities.json`,
    `/v1/countries/${country}/cities.json?lang=ar`,
    `/v1/countries/${country}/cities.json?q=Dubai`,
    `/v1/countries/${country}/cities.json?q=دبي&lang=ar`,
  ];
  for (const path of paths) {
    const response = await mf.dispatchFetch(`http://localhost${path}`, {
      headers: { Authorization: "Bearer local-smoke-test" },
    });
    if (response.status !== 200)
      throw new Error(`Smoke test failed: ${path} (${response.status}): ${await response.text()}`);
    const value: unknown = await response.json();
    const result = Schema.decodeUnknownSync(
      Schema.Struct({
        data: Schema.Array(Schema.Struct({ name: Schema.String })),
        meta: Schema.Struct({ language: Schema.String }),
      }),
    )(value);
    console.info(
      JSON.stringify({
        path,
        language: result.meta.language,
        firstNames: result.data.slice(0, 3).map((row) => row.name),
      }),
    );
    if (
      country === "AE" &&
      path.includes("q=") &&
      !result.data.some((row) => row.name === "Dubai" || row.name === "دبي")
    )
      throw new Error("Dubai search did not return Dubai.");
  }
  const unauthorized = await mf.dispatchFetch("http://localhost/v1/countries.json");
  if (unauthorized.status !== 401 && unauthorized.status !== 503)
    throw new Error("Unauthenticated data was served.");
  console.info(`Verified ${count} real ${country} populated places in the Worker runtime.`);
} finally {
  await mf.dispose();
}
