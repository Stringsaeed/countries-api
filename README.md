# Countries API

A native iOS geographic API built with TypeScript, Hono, Effect, and Cloudflare Workers. It lists countries and populated places, searches English and Arabic names, and requires Apple App Attest proof before serving data.

The production base URL is `https://api.saeed.sh`. The staging base URL is `https://staging.api.saeed.sh`. Override it with `STAGING_API_DOMAIN` if needed. See [domain and DNS setup](docs/deployment.md#connect-the-api-domain).

Alchemy provisions private R2 storage, a versioned D1 search database, a Durable Object namespace, rate-limit bindings, and the Worker. Authentication runs before the shared internal cache. Data responses use private client caching and ETags.

## Run locally

Use Node.js 24 or newer.

```sh
npm ci
cp .dev.vars.example .dev.vars
# Replace the example token with a random local token.
npm run data:download
npm run data:build
npm run data:publish -- --local
npm run dev
```

The full source includes millions of populated places. Allow several gigabytes of disk space and time for generation and publication. For a smaller development dataset, set `DATA_COUNTRIES=AE,EG,SA` when downloading. A subset cannot be deployed to production.

Send `Authorization: Bearer <your local token>` to `http://localhost:8787`. The development token works only when `ENVIRONMENT=local` and the request uses a loopback hostname. Alchemy never deploys that token or the local environment.

```sh
curl -H 'Authorization: Bearer <your local token>' \
  -H 'Accept-Language: ar' \
  'http://localhost:8787/v1/countries/AE/cities.json?q=Dubai'
```

Run `npm run check` and `npm run build` before publishing changes. `check` includes TypeScript, ESLint with zero warnings, Prettier, the OpenAPI contract, and tests. Use `npm run lint:fix` for ESLint fixes and `npm run format` to apply Prettier formatting. The tests execute inside the Workers runtime with real R2, D1, cache, and Durable Object emulation. The test pool pins its supported compatibility date separately from the deployment date.

## API

- `GET /v1/countries.json`
- `GET /v1/countries/{countryCode}/cities.json`
- `POST /v1/auth/challenge`
- `POST /v1/auth/attest`
- `GET /health`

Use `Accept-Language: en`, `ar`, or weighted regional tags such as `ar-AE, en;q=0.8`. An explicit `lang=en|ar` query parameter overrides the header. Unsupported negotiation returns `406`. The default is English. Responses include `Content-Language` and `Vary: Accept-Language`.

Both list endpoints accept `q`, `limit`, and `cursor`. Country limits are 1–250. City limits are 1–100. Country search accepts one character. City search requires at least two characters, at most 64 normalized characters, and at most five words. Search matches English and Arabic regardless of the display language. City search uses token prefixes and known aliases, with all query words required. It does not perform arbitrary substring or typo matching. City results use a stable order by source population descending, then GeoNames ID ascending. Country results use country-code order.

Return the opaque `meta.nextCursor` in the next request while preserving language, country, and search. A new dataset returns `409 dataset_changed` for an old cursor. Duplicate and unknown query parameters return `400`.

Each country has `code`, `flag`, `names`, a localized `name`, `nameLanguage`, and `prayerCalculationMethod`. Each city has `id`, `countryCode`, `names`, `name`, `nameLanguage`, `region`, `location`, `timezone`, and `prayerCalculationMethod`. `region` is the GeoNames first-level administrative code. Coordinates describe the place's reference position. Timezones are IANA identifiers, not fixed UTC offsets.

`names.ar` is nullable. If an Arabic translation is missing, `name` falls back to the source's English name and `nameLanguage` is `en`. The API does not fabricate translations. Country names use Unicode CLDR. Country coverage includes territories and GeoNames' Kosovo entry. Flags use regional-indicator emoji; appearance depends on the client platform.

Errors use `application/problem+json`, an HTTP status, a stable error code in `title`, and a request ID. Authentication and error responses use `Cache-Control: no-store`. Authenticated JSON responses use `private, max-age=86400, must-revalidate` and support `If-None-Match`. A conditional request still requires a fresh assertion. The app may retain downloaded data for offline use.

The schema-derived [OpenAPI contract](docs/openapi.json) is checked in CI. Regenerate it with `npm run api:generate` after changing response or enrollment schemas. Run `npm run data:smoke` after generating data to exercise actual UAE records in the bundled Worker.

See [the iOS protocol](docs/ios-authentication.md), [deployment setup](docs/deployment.md), [architecture](docs/architecture.md), and [data provenance](docs/data.md).

## Public repository

The code can be public. The Apple App ID prefix and bundle identifier are identifiers, not secrets. No shared API secret is embedded in the iOS application. Never commit `.env`, `.dev.vars`, `.alchemy`, deployment state, raw downloads, or generated data. The included fixtures are public upstream test vectors, with their license retained.

CI runs tests and checks without Cloudflare or Apple credentials. GitHub Actions deploys staging from `main` and promotes an exact staging release to production through a manual workflow. Configure protected environments and the secrets listed in [deployment setup](docs/deployment.md#github-actions). Alchemy state persists in Cloudflare. Once this directory is a Git repository, `npm install` installs the Husky commit-message hook with conventional commit types. Pull requests never run the deployment workflows. Production promotion requires a successful staging run; configure GitHub environment reviewers to require administrator approval.
