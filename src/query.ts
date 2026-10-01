import Negotiator from "negotiator";
import { Buffer } from "node:buffer";
import { Schema } from "effect";
import { ApiError, decode, invalid } from "./errors";
import { Cursor, Language } from "./schema";

export function normalizeSearch(value: string) {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("en")
    .replace(/\p{M}/gu, "")
    .replace(/ـ/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}
export function language(request: Request): Language {
  const explicit = new URL(request.url).searchParams.get("lang");
  if (explicit !== null) return decode(Language, explicit);
  const header = request.headers.get("Accept-Language");
  if (!header) return "en";
  if (header.length > 512) throw invalid("Accept-Language is too long.");
  const negotiated = new Negotiator({ headers: { "accept-language": header } }).language([
    "en",
    "ar",
  ]);
  if (!negotiated)
    throw new ApiError({
      status: 406,
      code: "language_not_supported",
      message: "Supported languages are en and ar.",
    });
  return Schema.decodeUnknownSync(Language)(negotiated);
}
export function query(request: Request, country: string, version: string) {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (!["lang", "q", "limit", "cursor"].includes(key) || params.getAll(key).length > 1)
      throw invalid("Unknown or duplicate query parameter.");
  }
  const locale = language(request);
  const rawQuery = params.get("q") ?? "";
  if (rawQuery.length > 128) throw invalid("Search is too long.");
  const q = normalizeSearch(rawQuery);
  if (rawQuery && !q) throw invalid("Search must contain letters or numbers.");
  if (q.length > 64 || q.split(" ").length > 5 || (country && q && q.length < 2))
    throw invalid("City search requires 2 to 64 characters and at most 5 words.");
  const max = country ? 100 : 250;
  const rawLimit = params.get("limit") ?? String(max);
  if (!/^\d{1,3}$/.test(rawLimit)) throw invalid("Invalid limit.");
  const limit = Number(rawLimit);
  if (limit < 1 || limit > max) throw invalid(`Limit must be between 1 and ${max}.`);
  let after = 0;
  const rawCursor = params.get("cursor");
  if (rawCursor) {
    if (rawCursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(rawCursor))
      throw invalid("Invalid cursor.");
    let cursor: Cursor;
    try {
      const json: unknown = JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8"));
      cursor = decode(Cursor, json);
    } catch {
      throw invalid("Invalid cursor.");
    }
    if (cursor.version !== version)
      throw new ApiError({
        status: 409,
        code: "dataset_changed",
        message: "The dataset changed. Restart pagination.",
      });
    if (cursor.country !== country || cursor.language !== locale || cursor.q !== q)
      throw invalid("Cursor does not match this query.");
    after = cursor.after;
  }
  return { language: locale, q, limit, after, country, version };
}
export type Query = ReturnType<typeof query>;
export function nextCursor(query: Query, after: number) {
  return Buffer.from(
    JSON.stringify({
      version: query.version,
      country: query.country,
      language: query.language,
      q: query.q,
      after,
    }),
  ).toString("base64url");
}
export function ftsQuery(country: string, q: string) {
  return `countryCode : "${country.toLowerCase()}" AND ${q
    .split(" ")
    .map((word) => `names : "${word}"*`)
    .join(" AND ")}`;
}
export function localized<T extends { name: { en: string; ar: string | null } }>(
  item: T,
  language: Language,
) {
  const { name, ...rest } = item;
  return {
    ...rest,
    names: name,
    name: name[language] ?? name.en,
    nameLanguage: language === "ar" && name.ar !== null ? "ar" : "en",
  };
}
