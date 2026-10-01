# Geographic data

Country display names come from the pinned `cldr-localenames-full` package. Country codes come from GeoNames `countryInfo.txt`, excluding the retired `CS` and `AN` entries. GeoNames includes countries, territories, and `XK`. This list is not a claim that every entry is an independent state.

City data comes from the full `allCountries.zip` export. Included feature codes are `PPL`, `PPLA`, `PPLA2`, `PPLA3`, `PPLA4`, `PPLA5`, `PPLC`, `PPLF`, `PPLG`, `PPLL`, `PPLR`, and `PPLS`. No population threshold is imposed. This coverage includes towns, villages, and groups of settlements. Historical, abandoned, destroyed, and neighborhood entries are excluded.

`alternateNamesV2.zip` provides language-specific names. Preferred and short names rank above other alternatives. Historic alternatives are excluded from display-name selection. Original alternative names remain in the search index. Arabic coverage is incomplete, especially for small settlements outside Arabic-speaking countries. Missing Arabic names remain null.

The source record's GeoNames ID is the stable city identifier. Coordinates use decimal degrees. The builder validates latitude, longitude, and IANA timezone identifiers. First-level administrative codes remain source codes in `region`.

`data/overrides/city-names.json` accepts reviewed name overrides keyed by GeoNames ID, such as `{"292223":{"en":"Dubai","ar":"دبي"}}`. Prayer recommendations live in `data/overrides/prayer-methods.json`. These are application suggestions, not official prayer schedules. Unmapped countries return null; the iOS app must offer a configurable fallback. Country defaults do not encode every local authority, madhab, Ramadan adjustment, or high-latitude rule.

The builder records SHA-256 checksums for source files and generates a content version from those checksums, the CLDR package, overrides, and builder source. The manifest records source coverage, total places, and Arabic translation coverage. `npm run data:download -- --refresh` fetches new source snapshots. Generation is offline after downloading and does not call GeoNames at request time.

A subset download replaces `data/raw/sources.json`. To return to worldwide coverage, run `npm run data:download` without `DATA_COUNTRIES`, then rebuild. Raw snapshots remain cached unless `--refresh` is used.

GeoNames data is licensed under Creative Commons Attribution. Retain visible attribution in the consuming application's credits, including a link to [GeoNames](https://www.geonames.org/). Review [GeoNames export terms](https://www.geonames.org/export/) and the [Unicode license](https://www.unicode.org/license.txt) before redistributing datasets. The repository's MIT license covers its code, not third-party geographic data.

The Sharjah display-name override follows [the UAE Ministry of Foreign Affairs city naming](https://www.mofa.gov.ae/ar-ae/THE-UAE), replacing a source alternative that names the emirate rather than the city.
