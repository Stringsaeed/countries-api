# Deploy with Alchemy

## Administrator prerequisites

1. Use a Cloudflare account with Workers, SQLite Durable Objects, D1, and R2 enabled. Choose a plan that can hold the full worldwide search index and serve the expected request volume. R2 requires billing activation even when usage stays within allowances.
2. Create a scoped Cloudflare API token for the deployment account. Grant Workers Scripts Edit, Workers R2 Storage Edit, D1 Edit, and Account Settings Read for workers.dev discovery. For a custom domain, grant Zone Read and Workers Routes Edit on that specific zone. Alchemy manages the Durable Object namespace as a Worker binding.
3. Create private R2 buckets named `countries-api-staging-data` and `countries-api-production-data`, or only the environment you intend to deploy. Alchemy adopts these named buckets and manages their configuration. Leave public access disabled. Create R2 S3 credentials with Object Read & Write permission scoped to those buckets. Set `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`. Bulk publication uses the S3 API rather than the Cloudflare management API.
4. Obtain the Apple App ID prefix from the app's registered identifier and the exact bundle identifier. The prefix is often the Team ID, but check it explicitly.
5. Enable App Attest and regenerate the app's provisioning profiles if needed.
6. Generate separate random values for `ALCHEMY_PASSWORD` and `ALCHEMY_STATE_TOKEN` and store both in your password manager. Alchemy stores deployment state in the `countries-api-state` Worker and its Durable Object. Keep the state token identical for staging, production, and local administrators using the same Cloudflare account. Keep each stage's encryption password consistent across its deployments. Enable an account workers.dev subdomain for the authenticated state service, even though the API Workers use custom domains.

## Configure and deploy staging

```sh
cp .env.example .env
# Fill in the Cloudflare token, account, R2 S3 credentials, Apple identifiers, and state password.
npm run data:download
npm run data:build
npm run check
npm run build
npm run deploy:staging
```

Alchemy validates required settings before making API calls. It creates a private bucket and a versioned search database, imports the generated SQL in bounded sequential files, publishes JSON, and deploys the Worker. The full import and tens of thousands of JSON objects take time and incur storage operations. Retrying an incomplete release uses the same database name. A completed release skips import. Deployment state persists in Cloudflare between runs. Do not deploy locally while a GitHub deployment is running.

Staging defaults to `https://staging.api.saeed.sh`, configured through `STAGING_API_DOMAIN`. `API_DOMAIN` applies only to production and defaults to `api.saeed.sh`. A custom domain must belong to an active Cloudflare zone managed by the account. Alchemy binds it to the Worker and disables that Worker's workers.dev URL. Staging cannot use the production domain. Preview subdomains remain disabled.

Keep separate Apple app identifiers if staging uses a different app bundle. Staging accepts development and production App Attest environments. Test enrollment on a physical iPhone, English and Arabic queries, an unauthorized request after warming a response, and a request replay. A real-device smoke test is required before production release.

## Deploy production

Configure the production Apple identifiers and domain in `.env`, then run:

```sh
npm run deploy -- --stage production
```

Production requires a worldwide dataset and rejects development attestation. It has no local authentication token. Keep staging and production domains separate.

Inspect Cloudflare request logs, error rates, D1 query costs, R2 operations, and Durable Object storage. Cloudflare's binding rate limits are per-location approximate abuse controls; the Durable Object challenge quota is per-device. Add account WAF rules for public authentication endpoints if traffic warrants them. Do not add a cache rule that bypasses the Worker for `/v1/*`.

## Connect the API domain

The production base URL is `https://api.saeed.sh` and staging uses `https://staging.api.saeed.sh`. `saeed.sh` currently uses Vercel's authoritative nameservers. Website hosting and DNS hosting are separate: the website can stay on Vercel while DNS moves to Cloudflare.

For the standard Cloudflare setup:

1. Add `saeed.sh` as a zone in your Cloudflare account.
2. Inventory and copy every existing DNS record before changing nameservers, including Vercel website records, email records, and verification records. Use the exact values shown by Vercel for your project rather than a generic Vercel IP or CNAME. Keep the website records DNS-only.
3. Change the domain's authoritative nameservers at the registrar to the pair assigned by Cloudflare. If Vercel is the registrar, use its domain nameserver settings. Wait for the Cloudflare zone to become active.
4. Leave `API_DOMAIN=api.saeed.sh` in `.env`. Deploy production with Alchemy. Its Workers custom-domain resource creates the API DNS record and certificate. Resolve any pre-existing `api` CNAME before attaching the domain.
5. Verify HTTPS at `https://api.saeed.sh/health`, then enroll the iOS app against this exact origin. Set the Swift client's `baseURL` to `https://api.saeed.sh`.

A plain Vercel CNAME pointing `api` to a workers.dev hostname does not configure a Workers custom domain or its TLS certificate. If you must keep Vercel as the authoritative DNS provider, Cloudflare offers a Business or Enterprise partial-zone setup. Delegating `api.saeed.sh` as a separate Cloudflare zone requires Enterprise subdomain setup. Those alternatives need the corresponding zone configuration before Alchemy can attach the Worker.

References: [Cloudflare Workers custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [partial-zone setup](https://developers.cloudflare.com/dns/zone-setups/partial-setup/), [subdomain delegation](https://developers.cloudflare.com/dns/zone-setups/subdomain-setup/setup/), and [Vercel nameserver settings](https://vercel.com/docs/domains/working-with-nameservers).

## Update or roll back data

Download a fresh snapshot with `npm run data:download -- --refresh`, rebuild, verify, and deploy. A new source or naming override creates a new dataset version and search database. Previous versions remain available in private storage.

To roll back, restore the previous generated release's `data/generated/latest.json` pointer and redeploy from the corresponding code and the shared Alchemy state. A Worker-only rollback also needs compatible R2 and D1 bindings. Never delete the prior database or R2 prefix until its retention period has elapsed.

Do not run infrastructure destroy commands as routine cleanup. R2 and D1 resources use retention settings. Revoke an app installation by removing its Durable Object key state through an administrator operation, not a public endpoint.

## GitHub Actions

The CI workflow checks pushes and pull requests without deployment credentials. `Deploy staging` runs on pushes to `main`, or manually from `main`. It runs checks, builds the full dataset, performs a real-data local smoke test, deploys to `staging.api.saeed.sh`, and verifies HTTPS, dataset version, and rejection of unauthenticated data requests. It waits up to ten minutes for HTTPS and the expected release to become ready, then saves the generated dataset as a seven-day release artifact. TLS verification stays enabled. Source snapshots are cached immediately after download so a later deployment failure does not discard them.

`Deploy production` runs manually from `main`. Supply the successful staging run ID shown in its summary. The workflow validates the source run, checks out that run's exact commit, downloads its dataset artifact, and deploys to `api.saeed.sh`. It does not download a different geographic snapshot during promotion. An expired artifact requires a new staging run. Deployment concurrency is shared across both workflows, with running deployments allowed to finish.

### Configure repository environments

Create GitHub environments named `staging` and `production`. Restrict both to the `main` branch. Add required reviewers to `production` so promotion requires approval, and enable branch protection for `main`. These settings require configuration in GitHub; workflow files alone do not enforce reviewers.

Set these secrets in each environment:

| Secret                 | Purpose                                               |
| ---------------------- | ----------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN` | Scoped infrastructure deployment credentials          |
| `R2_ACCESS_KEY_ID`     | Bucket-scoped S3 access key                           |
| `R2_SECRET_ACCESS_KEY` | Bucket-scoped S3 secret                               |
| `ALCHEMY_PASSWORD`     | Encryption password for the stage's Alchemy state     |
| `ALCHEMY_STATE_TOKEN`  | Shared authentication token for `countries-api-state` |

Set these variables in each environment:

| Variable                | Purpose                                        |
| ----------------------- | ---------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | Target Cloudflare account                      |
| `APPLE_APP_ID_PREFIX`   | App ID prefix registered with Apple            |
| `APPLE_BUNDLE_ID`       | Bundle identifier accepted by this environment |

Use the same `ALCHEMY_STATE_TOKEN` in both environments when deploying to the same Cloudflare account. Use separate Cloudflare and R2 credentials where their scopes differ. Domain values are set in the workflows.

Optionally set the staging environment variable `GEONAMES_SNAPSHOT`, such as `2026-10-02`. Changing it creates a new cache key and downloads a fresh worldwide source snapshot. The cache saves download time, but GitHub may evict it; a cache miss also downloads a fresh snapshot. Production always uses the exact staging artifact regardless of source-cache eviction. Release artifacts and caches contain public geographic data only, never `.env`, `.alchemy`, tokens, or device records. The full release uses substantial artifact storage; adjust retention to your promotion window and storage budget.

Once the repository is on GitHub, enable Actions, configure environments and credentials, and push to `main` for the first staging deployment. After verifying App Attest on a physical iPhone, open `Deploy production`, select `main`, enter the staging run ID, and approve the protected environment deployment.

The state service is provisioned automatically on the first configured deployment. If the application was already deployed using the previous local state backend, migrate that state before adopting this remote backend. Preserve the local state and do not start a fresh infrastructure deployment over existing resources without migration.

The post-deployment checks verify the reachable Worker and denied unauthenticated access. They do not replace physical-device attestation checks or prove the entire authenticated search flow. No GitHub or Cloudflare deployment has been executed from this workspace yet.
