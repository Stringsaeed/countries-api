import { Schema } from "effect";

export const Language = Schema.Literals(["en", "ar"]);
export type Language = typeof Language.Type;
export const CountryCode = Schema.String.check(Schema.isPattern(/^[A-Z]{2}$/)).pipe(
  Schema.brand("CountryCode"),
);
export type CountryCode = typeof CountryCode.Type;
export const Version = Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/));
export const Names = Schema.Struct({
  en: Schema.NonEmptyString,
  ar: Schema.NullOr(Schema.NonEmptyString),
});
export const PrayerMethod = Schema.Literals([
  "muslim_world_league",
  "egyptian",
  "karachi",
  "umm_al_qura",
  "dubai",
  "qatar",
  "kuwait",
  "singapore",
  "north_america",
  "tehran",
  "turkey",
]);
export const Country = Schema.Struct({
  code: CountryCode,
  name: Names,
  flag: Schema.NonEmptyString,
  prayerCalculationMethod: Schema.NullOr(PrayerMethod),
});
export type Country = typeof Country.Type;
export const City = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  countryCode: CountryCode,
  name: Names,
  region: Schema.NullOr(Schema.String),
  location: Schema.Struct({
    latitude: Schema.Finite.check(Schema.isBetween({ minimum: -90, maximum: 90 })),
    longitude: Schema.Finite.check(Schema.isBetween({ minimum: -180, maximum: 180 })),
  }),
  timezone: Schema.NonEmptyString,
  prayerCalculationMethod: Schema.NullOr(PrayerMethod),
});
export type City = typeof City.Type;
export const Manifest = Schema.Struct({
  version: Version,
  pageSize: Schema.Literal(100),
  countries: Schema.Array(Country),
  countryCityCounts: Schema.Record(Schema.String, Schema.Int),
  cityCount: Schema.Int,
  arabicCityCount: Schema.Int,
  coverage: Schema.Literals(["world", "subset"]),
  sources: Schema.Array(Schema.Struct({ file: Schema.String, sha256: Schema.String })),
});
export type Manifest = typeof Manifest.Type;
export const KeyId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9+/]{43}=$/));
export const Challenge = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/));
export const ChallengeRequest = Schema.Struct({
  keyId: KeyId,
  purpose: Schema.Literals(["attestation", "assertion"]),
});
export const AttestationRequest = Schema.Struct({
  keyId: KeyId,
  challenge: Challenge,
  attestation: Schema.String.check(
    Schema.isMinLength(4),
    Schema.isMaxLength(24000),
    Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
  ),
});
export const Cursor = Schema.Struct({
  version: Version,
  country: Schema.String,
  language: Language,
  q: Schema.String,
  after: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10000000 })),
});
export type Cursor = typeof Cursor.Type;
