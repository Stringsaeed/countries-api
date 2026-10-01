import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { Schema } from "effect";
import { Country, CountryCode, City, Manifest, PrayerMethod, Names } from "../src/schema";
import { normalizeSearch } from "../src/query";
import {
  hashFile,
  lines,
  outputDirectory,
  prepareDirectories,
  rawDirectory,
  sources,
} from "./common";

const require = createRequire(import.meta.url);
const LocaleFile = Schema.Struct({
  main: Schema.Record(
    Schema.String,
    Schema.Struct({
      localeDisplayNames: Schema.Struct({
        territories: Schema.Record(Schema.String, Schema.String),
      }),
    }),
  ),
});
function territories(locale: string) {
  const value: unknown = require(`cldr-localenames-full/main/${locale}/territories.json`);
  const names =
    Schema.decodeUnknownSync(LocaleFile)(value).main[locale]?.localeDisplayNames.territories;
  if (!names) throw new Error(`Missing CLDR locale ${locale}`);
  return names;
}
const en = territories("en");
const ar = territories("ar");
const rawMethods: unknown = JSON.parse(
  await readFile("data/overrides/prayer-methods.json", "utf8"),
);
const methods = Schema.decodeUnknownSync(
  Schema.Struct({
    countries: Schema.Record(Schema.String, PrayerMethod),
    cities: Schema.Record(Schema.String, PrayerMethod),
  }),
)(rawMethods);
const rawOverrides: unknown = JSON.parse(await readFile("data/overrides/city-names.json", "utf8"));
const overrides = Schema.decodeUnknownSync(Schema.Record(Schema.String, Names))(rawOverrides);
await prepareDirectories();
const sourceFiles = await sources();
for (const source of sourceFiles)
  if ((await hashFile(join(rawDirectory, source.file))) !== source.sha256)
    throw new Error(`Source checksum mismatch: ${source.file}`);
const cldrVersion: unknown = require("cldr-localenames-full/package.json");
const version = createHash("sha256")
  .update(
    JSON.stringify({
      sourceFiles,
      cldrVersion,
      methods,
      overrides,
      builderSha256: await hashFile(import.meta.filename),
      searchSha256: await hashFile("src/query.ts"),
      schemaSha256: await hashFile("src/schema.ts"),
    }),
  )
  .digest("hex")
  .slice(0, 16);
const directory = join(outputDirectory, version);
await mkdir(directory, { recursive: true });
const dbFile = join(outputDirectory, "build.sqlite");
await rm(dbFile, { force: true });
const db = new DatabaseSync(dbFile);
db.exec(
  "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; CREATE TABLE raw_cities(id INTEGER PRIMARY KEY,country TEXT,population INTEGER,name TEXT,ar TEXT,englishScore INTEGER DEFAULT 0,arabicScore INTEGER DEFAULT 0,aliases TEXT,payload TEXT); CREATE INDEX raw_countries ON raw_cities(country,population DESC,id)",
);
const insert = db.prepare(
  "INSERT INTO raw_cities(id,country,population,name,aliases,payload) VALUES(?,?,?,?,?,?)",
);
const countryRecords: Country[] = [];
for await (const columns of lines(join(rawDirectory, "countryInfo.txt"))) {
  const code = columns[0];
  if (code === "CS" || code === "AN") continue;
  if (!code || !en[code] || !ar[code]) throw new Error(`Missing standard country name: ${code}`);
  countryRecords.push(
    Schema.decodeUnknownSync(Country)({
      code,
      name: { en: en[code], ar: ar[code] },
      flag: [...code].map((letter) => String.fromCodePoint(127397 + letter.charCodeAt(0))).join(""),
      prayerCalculationMethod: methods.countries[code] ?? null,
    }),
  );
}
countryRecords.sort((a, b) => a.code.localeCompare(b.code, "en"));
const codes = new Set(countryRecords.map((country) => country.code));
const populatedCodes = new Set([
  "PPL",
  "PPLA",
  "PPLA2",
  "PPLA3",
  "PPLA4",
  "PPLA5",
  "PPLC",
  "PPLF",
  "PPLG",
  "PPLL",
  "PPLR",
  "PPLS",
]);
let inserted = 0;
const validTimezones = new Set<string>();
db.exec("BEGIN");
for (const source of sourceFiles.filter(
  (file) => file.file.endsWith(".zip") && file.file !== "alternateNamesV2.zip",
)) {
  for await (const column of lines(
    join(rawDirectory, source.file),
    source.file.replace(/\.zip$/, ".txt"),
  )) {
    if (column[6] !== "P" || !populatedCodes.has(column[7] ?? "")) continue;
    const code = Schema.decodeUnknownSync(CountryCode)(column[8]);
    if (!codes.has(code)) throw new Error(`City references unknown country ${code}`);
    const id = Number(column[0]);
    const name = column[2] || column[1] || "";
    const timezone = column[17] ?? "";
    if (!validTimezones.has(timezone)) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: timezone });
        validTimezones.add(timezone);
      } catch {
        throw new Error(`Invalid timezone for city ${id}: ${timezone}`);
      }
    }
    const city = Schema.decodeUnknownSync(City)({
      id,
      countryCode: code,
      name: { en: name, ar: null },
      region: column[10] || null,
      location: { latitude: Number(column[4]), longitude: Number(column[5]) },
      timezone,
      prayerCalculationMethod: methods.cities[String(id)] ?? methods.countries[code] ?? null,
    });
    insert.run(
      id,
      code,
      Number(column[14]) || 0,
      name,
      normalizeSearch([name, column[2], column[3]?.replace(/,/g, " ")].join(" ")),
      JSON.stringify(city),
    );
    if (++inserted % 50000 === 0) {
      db.exec("COMMIT; BEGIN");
      console.info(`Imported ${inserted} populated places`);
    }
  }
}
db.exec("COMMIT");
if (inserted === 0) throw new Error("No populated places found.");
console.info(`Localizing ${inserted} populated places`);
const english = db.prepare(
  "UPDATE raw_cities SET name=?,englishScore=? WHERE id=? AND englishScore<?",
);
const arabic = db.prepare("UPDATE raw_cities SET ar=?,arabicScore=? WHERE id=? AND arabicScore<?");
db.exec("BEGIN");
let translated = 0;
for await (const column of lines(
  join(rawDirectory, "alternateNamesV2.zip"),
  "alternateNamesV2.txt",
)) {
  if ((column[2] !== "en" && column[2] !== "ar") || column[7] === "1" || !column[3]) continue;
  const score =
    1 + (column[4] === "1" ? 4 : 0) + (column[5] === "1" ? 2 : 0) - (column[6] === "1" ? 1 : 0);
  (column[2] === "ar" ? arabic : english).run(column[3], score, Number(column[1]), score);
  if (++translated % 50000 === 0) db.exec("COMMIT; BEGIN");
}
db.exec("COMMIT");
const Raw = Schema.Struct({
  id: Schema.Int,
  country: Schema.String,
  population: Schema.Int,
  name: Schema.String,
  ar: Schema.NullOr(Schema.String),
  aliases: Schema.String,
  payload: Schema.String,
});
const counts: Record<string, number> = {};
let arabicCount = 0;
const sqlStream = createWriteStream(join(directory, "search.sql"));
async function sql(value: string) {
  if (Buffer.byteLength(value) > 100000) throw new Error("SQL statement exceeds the D1 limit.");
  if (!sqlStream.write(value + "\n")) await once(sqlStream, "drain");
}
function literal(value: string | number) {
  return typeof value === "number" ? String(value) : `'${value.replace(/'/g, "''")}'`;
}
await sql(
  "DROP TABLE IF EXISTS city_search;\nDROP TABLE IF EXISTS cities;\nDROP TABLE IF EXISTS dataset;\nCREATE TABLE IF NOT EXISTS dataset (version TEXT PRIMARY KEY);\nCREATE TABLE IF NOT EXISTS cities(id INTEGER PRIMARY KEY,countryCode TEXT NOT NULL,ordinal INTEGER NOT NULL,payload TEXT NOT NULL);\nCREATE INDEX IF NOT EXISTS city_country_order ON cities(countryCode,ordinal);\nCREATE VIRTUAL TABLE IF NOT EXISTS city_search USING fts5(countryCode,names,content='',tokenize='unicode61 remove_diacritics 2',prefix='2 3 4');",
);
for (const country of countryRecords) {
  let ordinal = 0;
  let chunk: City[] = [];
  let chunkIndex = 0;
  const cityDirectory = join(directory, "cities", country.code);
  await mkdir(cityDirectory, { recursive: true });
  for (const value of db
    .prepare(
      "SELECT id,country,population,name,ar,aliases,payload FROM raw_cities WHERE country=? ORDER BY population DESC,id",
    )
    .iterate(country.code)) {
    const row = Schema.decodeUnknownSync(Raw)(value);
    const payload: unknown = JSON.parse(row.payload);
    const original = Schema.decodeUnknownSync(City)(payload);
    const city = Schema.decodeUnknownSync(City)({
      ...original,
      name: overrides[String(row.id)] ?? { en: row.name, ar: row.ar },
    });
    if (city.name.ar !== null) arabicCount++;
    chunk.push(city);
    ordinal++;
    await sql(
      `INSERT OR REPLACE INTO cities VALUES(${[city.id, country.code, ordinal, JSON.stringify(city)].map(literal).join(",")});`,
    );
    await sql(
      `INSERT INTO city_search(rowid,countryCode,names) VALUES(${[city.id, country.code.toLowerCase(), normalizeSearch(`${city.name.en} ${city.name.ar ?? ""} ${row.aliases}`)].map(literal).join(",")});`,
    );
    if (chunk.length === 100) {
      await writeFile(join(cityDirectory, `${chunkIndex++}.json`), JSON.stringify(chunk));
      chunk = [];
    }
  }
  if (chunk.length)
    await writeFile(join(cityDirectory, `${chunkIndex}.json`), JSON.stringify(chunk));
  counts[country.code] = ordinal;
}
await sql(`INSERT OR REPLACE INTO dataset VALUES(${literal(version)});`);
sqlStream.end();
await once(sqlStream, "finish");
const manifest = Schema.decodeUnknownSync(Manifest)({
  version,
  pageSize: 100,
  countries: countryRecords,
  countryCityCounts: counts,
  cityCount: inserted,
  arabicCityCount: arabicCount,
  coverage: sourceFiles.some((source) => source.file === "allCountries.zip") ? "world" : "subset",
  sources: sourceFiles,
});
await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
await writeFile(join(outputDirectory, "latest.json"), JSON.stringify({ version }));
db.close();
console.info(
  JSON.stringify({
    version,
    countries: countryRecords.length,
    cities: inserted,
    arabicCities: arabicCount,
    coverage: manifest.coverage,
  }),
);
