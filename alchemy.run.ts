import "dotenv/config";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import alchemy from "alchemy";
import { CloudflareStateStore } from "alchemy/state";
import {
  D1Database,
  DurableObjectNamespace,
  R2Bucket,
  RateLimit,
  Worker,
} from "alchemy/cloudflare";
import { Schema } from "effect";
import { Manifest } from "./src/schema";
import { importSql, publishObjects, release } from "./scripts/publish-data";

function required(name: string) {
  const value = process.env[name];
  if (!value || value.startsWith("replace-"))
    throw new Error(`Set ${name} in .env before deploying.`);
  return value;
}
const account = required("CLOUDFLARE_ACCOUNT_ID");
const token = required("CLOUDFLARE_API_TOKEN");
const password = required("ALCHEMY_PASSWORD");
const stateToken = required("ALCHEMY_STATE_TOKEN");
const accessKeyId = required("R2_ACCESS_KEY_ID");
const secretAccessKey = required("R2_SECRET_ACCESS_KEY");
const prefix = required("APPLE_APP_ID_PREFIX");
const bundle = required("APPLE_BUNDLE_ID");
if (!/^[A-Z0-9]{10}$/.test(prefix) || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundle))
  throw new Error("Set a valid Apple App ID prefix and bundle identifier.");
const app = await alchemy("countries-api", {
  stage: "staging",
  password,
  stateStore: (scope) =>
    new CloudflareStateStore(scope, {
      scriptName: "countries-api-state",
      stateToken: alchemy.secret(stateToken),
    }),
});
if (!["staging", "production"].includes(app.stage))
  throw new Error("Only staging and production deployments are supported.");
const productionDomain = process.env.API_DOMAIN?.trim() || "api.saeed.sh";
const domain =
  app.stage === "production"
    ? productionDomain
    : process.env.STAGING_API_DOMAIN?.trim() || "staging.api.saeed.sh";
if (domain && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain))
  throw new Error("Configure an API hostname without a scheme, port, or path.");
if (app.stage === "staging" && domain?.toLowerCase() === productionDomain.toLowerCase())
  throw new Error("The staging domain must differ from the production domain.");
const { manifest, directory } = await release();
if (app.stage === "production" && manifest.coverage !== "world")
  throw new Error("Production requires the full worldwide dataset.");
const bucket = await R2Bucket("data", {
  name: `countries-api-${app.stage}-data`,
  devDomain: false,
  delete: false,
  empty: false,
  adopt: true,
});
const search = await D1Database(`search-${manifest.version}`, {
  name: `countries-api-${app.stage}-search-${manifest.version}`,
  delete: false,
  readReplication: { mode: "auto" },
});
const QueryResponse = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.Array(
    Schema.Struct({ results: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) }),
  ),
});
async function query(sql: string) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${search.id}/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql }),
      signal: AbortSignal.timeout(60000),
    },
  );
  if (!response.ok) throw new Error(`Cloudflare D1 query failed (${response.status}).`);
  const value: unknown = await response.json();
  const result = Schema.decodeUnknownSync(QueryResponse)(value);
  if (!result.success) throw new Error("Cloudflare rejected the dataset verification query.");
  return result.result[0]?.results ?? [];
}
const tables = await query("SELECT name FROM sqlite_schema WHERE name='dataset'");
const ready = tables.length ? await query("SELECT version FROM dataset") : [];
if (!ready.some((row) => row.version === manifest.version)) {
  await importSql(search.name, directory, true);
}
const counts = await query("SELECT COUNT(*) AS count FROM cities");
if (counts[0]?.count !== manifest.cityCount)
  throw new Error("D1 city count does not match the dataset.");
const indexCounts = await query("SELECT COUNT(*) AS count FROM city_search");
if (indexCounts[0]?.count !== manifest.cityCount)
  throw new Error("D1 search index count does not match the dataset.");
const object = await bucket.get(`${manifest.version}/manifest.json`);
if (!object) {
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${account}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 5,
  });
  try {
    await publishObjects(
      {
        put: (key, value, options) =>
          s3.send(
            new PutObjectCommand({
              Bucket: bucket.name,
              Key: key,
              Body: value,
              ContentType: options.httpMetadata.contentType,
            }),
          ),
      },
      directory,
      manifest.version,
    );
  } finally {
    s3.destroy();
  }
} else {
  const existing: unknown = await object.json();
  const stored = Schema.decodeUnknownSync(Manifest)(existing);
  if (JSON.stringify(stored) !== JSON.stringify(manifest))
    throw new Error("An immutable dataset version already has different contents.");
}
export const worker = await Worker("api", {
  name: `countries-api-${app.stage}`,
  entrypoint: "src/worker.ts",
  compatibilityDate: "2026-10-01",
  compatibilityFlags: ["nodejs_compat"],
  url: !domain,
  previewSubdomains: false,
  ...(domain ? { domains: [domain] } : {}),
  observability: { enabled: true, headSamplingRate: 0.1 },
  bindings: {
    DATA: bucket,
    SEARCH: search,
    APP_ATTEST: DurableObjectNamespace("devices", { className: "AppAttestDevice", sqlite: true }),
    AUTH_LIMIT: RateLimit({ namespace_id: 1001, simple: { limit: 30, period: 60 } }),
    DATA_LIMIT: RateLimit({ namespace_id: 1002, simple: { limit: 120, period: 60 } }),
    ENVIRONMENT: app.stage,
    APPLE_APP_ID_PREFIX: prefix,
    APPLE_BUNDLE_ID: bundle,
    DATASET_VERSION: manifest.version,
  },
});
await app.finalize();
console.info(
  JSON.stringify({
    stage: app.stage,
    datasetVersion: manifest.version,
    url: domain ? `https://${domain}` : worker.url,
  }),
);
