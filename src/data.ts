import { Effect, Schema } from "effect";
import { ApiError, run, storage } from "./errors";
import { City, Manifest } from "./schema";
import { ftsQuery, localized, nextCursor, normalizeSearch, type Query } from "./query";

async function readObject<S extends Schema.ConstraintDecoder<unknown>>(
  env: Env,
  key: string,
  schema: S,
): Promise<S["Type"]> {
  return run(
    Effect.gen(function* () {
      const object = yield* storage(() => env.DATA.get(`${env.DATASET_VERSION}/${key}`));
      if (!object || object.size > 1024 * 1024)
        return yield* Effect.fail(
          new ApiError({
            status: 503,
            code: "dataset_unavailable",
            message: "The dataset has not been published or is invalid.",
          }),
        );
      const value: unknown = yield* storage(() => object.json());
      return yield* Effect.try({
        try: () => Schema.decodeUnknownSync(schema)(value),
        catch: () =>
          new ApiError({
            status: 503,
            code: "dataset_invalid",
            message: "The published dataset is invalid.",
          }),
      });
    }),
  );
}
export async function readManifest(env: Env) {
  const manifest = await readObject(env, "manifest.json", Manifest);
  if (manifest.version !== env.DATASET_VERSION)
    throw new ApiError({
      status: 503,
      code: "dataset_invalid",
      message: "Dataset version mismatch.",
    });
  return manifest;
}
export async function countries(env: Env, query: Query) {
  const manifest = await readManifest(env);
  const matches = manifest.countries.filter(
    (country) =>
      !query.q ||
      [country.code, country.name.en, country.name.ar ?? ""].some((name) =>
        normalizeSearch(name)
          .split(" ")
          .some((_, index, words) => words.slice(index).join(" ").startsWith(query.q)),
      ),
  );
  const page = matches.slice(query.after, query.after + query.limit);
  const after = query.after + page.length;
  return {
    data: page.map((country) => localized(country, query.language)),
    meta: {
      language: query.language,
      version: manifest.version,
      coverage: manifest.coverage,
      total: matches.length,
      nextCursor: after < matches.length ? nextCursor(query, after) : null,
    },
  };
}
const SearchRow = Schema.Struct({ ordinal: Schema.Int, payload: Schema.String });
export async function cities(env: Env, query: Query) {
  const manifest = await readManifest(env);
  if (!manifest.countries.some((country) => country.code === query.country))
    throw new ApiError({
      status: 404,
      code: "country_not_found",
      message: "Unknown country code.",
    });
  const total = manifest.countryCityCounts[query.country] ?? 0;
  let page: readonly City[];
  let after: number;
  let hasMore: boolean;
  if (query.q) {
    const result = await run(
      storage(() =>
        env.SEARCH.withSession("first-primary")
          .prepare(
            "SELECT cities.ordinal, cities.payload FROM city_search JOIN cities ON cities.id=city_search.rowid WHERE city_search MATCH ? AND cities.countryCode=? AND cities.ordinal>? ORDER BY cities.ordinal LIMIT ?",
          )
          .bind(ftsQuery(query.country, query.q), query.country, query.after, query.limit + 1)
          .all(),
      ),
    );
    const rows = Schema.decodeUnknownSync(Schema.Array(SearchRow))(result.results);
    page = rows.slice(0, query.limit).map((row) => {
      const value: unknown = JSON.parse(row.payload);
      return Schema.decodeUnknownSync(City)(value);
    });
    after = rows[Math.min(rows.length, query.limit) - 1]?.ordinal ?? query.after;
    hasMore = rows.length > query.limit;
  } else {
    const start = query.after;
    const end = Math.min(start + query.limit, total);
    if (start > total)
      throw new ApiError({
        status: 400,
        code: "invalid_cursor",
        message: "Cursor is outside the country list.",
      });
    const first = Math.floor(start / manifest.pageSize);
    const last = Math.floor(Math.max(start, end - 1) / manifest.pageSize);
    const chunks =
      start === end
        ? []
        : await Promise.all(
            Array.from({ length: last - first + 1 }, (_, index) =>
              readObject(env, `cities/${query.country}/${first + index}.json`, Schema.Array(City)),
            ),
          );
    page = chunks
      .flat()
      .slice(start % manifest.pageSize, (start % manifest.pageSize) + end - start);
    if (page.length !== end - start)
      throw new ApiError({
        status: 503,
        code: "dataset_invalid",
        message: "Incomplete country list.",
      });
    after = end;
    hasMore = end < total;
  }
  return {
    data: page.map((city) => localized(city, query.language)),
    meta: {
      language: query.language,
      version: manifest.version,
      coverage: manifest.coverage,
      nextCursor: hasMore ? nextCursor(query, after) : null,
    },
  };
}
