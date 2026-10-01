# Architecture

Hono owns routing and HTTP middleware. Effect Schema validates requests and stored data. Effect models expected storage failures and maps them to stable API errors. Domain records use schema-derived TypeScript types, and geographic identifiers are validated at boundaries.

A data request passes the IP limiter, App Attest verification, and device limiter before the Worker consults its internal Cache API. Authentication is never cached. The cache key includes the dataset version, country, effective language, normalized query, page position, and limit. Attestation material does not enter shared cache keys.

On a cache miss, lists read bounded JSON objects from private R2. Search uses D1 FTS5 over normalized names and aliases, with an indexed country and stable ordinal. D1 sessions use `first-primary` so a newly activated release cannot cache an incomplete replica result. Warm searches use the internal edge cache. The cache is local to each Cloudflare data center; an uncached request can still incur storage latency.

The Worker sets private caching headers on the response sent to the client. Internally stored responses use a long TTL because their keys contain the immutable dataset version. Public CDN rules must never cache the outer API response before authentication. R2 has no public domain. There is no route exposing internal cache entries.

Each device has a SQLite-backed Durable Object. It stores its attested key and receipt, challenges, and a challenge quota. Verification consumes a challenge and updates the assertion counter in a synchronous transaction. This adds a state-service round trip to authenticated requests. The native client can reduce requests by caching country and city pages locally.

Deployment creates a separate search database for each release, imports its data, checks the row count, publishes R2 objects, and writes the R2 manifest last. Alchemy updates the Worker only after these steps succeed. Earlier databases and R2 versions are retained for rollback. Alchemy state persists in an authenticated Cloudflare state-service Worker and Durable Object. GitHub staging and production deployments share a concurrency group. Administrators must also avoid concurrent local deployment.

The D1 database is not a general application database. It is a generated read-only search index. The API has no public administrative routes. Dataset updates, naming overrides, and deployment credentials remain operator tasks.
