import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createHash } from "node:crypto";
import { ApiError, decode, invalid } from "./errors";
import { AttestationRequest, ChallengeRequest, CountryCode, Version } from "./schema";
import { authenticate, configured, device, unwrap } from "./auth";
import { countries, cities } from "./data";
import { query } from "./query";
export { AppAttestDevice } from "./auth";

const app = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();
app.use("*", async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  c.header("X-Request-Id", c.get("requestId"));
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cache-Control", "no-store");
  await next();
});
app.onError((error, c) => {
  const known = error instanceof ApiError;
  const status = known ? error.status : 500;
  if (!known)
    console.error(
      JSON.stringify({
        event: "request_failed",
        requestId: c.get("requestId"),
        path: c.req.path,
        error: error.name,
      }),
    );
  if (status === 429 || status === 503) c.header("Retry-After", "60");
  if (status === 401) c.header("WWW-Authenticate", 'AppAttest realm="countries-api"');
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title: known ? error.code : "internal_error",
      status,
      detail: known ? error.message : "An unexpected error occurred.",
      instance: `urn:uuid:${c.get("requestId")}`,
    }),
    {
      status,
      headers: {
        ...Object.fromEntries(c.res.headers),
        "Content-Type": "application/problem+json",
        "Cache-Control": "no-store",
      },
    },
  );
});
app.notFound(() => {
  throw new ApiError({ status: 404, code: "not_found", message: "Endpoint not found." });
});
app.get("/health", (c) => c.json({ status: "ok", datasetVersion: c.env.DATASET_VERSION }));
app.use(
  "/v1/auth/*",
  bodyLimit({
    maxSize: 32768,
    onError: () => {
      throw new ApiError({
        status: 413,
        code: "body_too_large",
        message: "Request body is too large.",
      });
    },
  }),
);
app.use("/v1/auth/*", async (c, next) => {
  configured(c.env);
  const result = await c.env.AUTH_LIMIT.limit({
    key: c.req.header("CF-Connecting-IP") ?? "unknown",
  });
  if (!result.success)
    throw new ApiError({
      status: 429,
      code: "rate_limited",
      message: "Too many authentication requests.",
    });
  if (
    c.req.method === "POST" &&
    c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  )
    throw new ApiError({
      status: 415,
      code: "unsupported_media_type",
      message: "Send application/json.",
    });
  await next();
});
async function json(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw invalid("Invalid JSON.");
  }
}
app.post("/v1/auth/challenge", async (c) => {
  const input = decode(ChallengeRequest, await json(c.req.raw));
  return c.json(unwrap(await device(c.env, input.keyId).challenge(input.purpose)));
});
app.post("/v1/auth/attest", async (c) => {
  const input = decode(AttestationRequest, await json(c.req.raw));
  unwrap(await device(c.env, input.keyId).register(input));
  return c.body(null, 204);
});

async function data(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  country: string,
) {
  const ip = await env.DATA_LIMIT.limit({
    key: `ip:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
  });
  if (!ip.success)
    throw new ApiError({ status: 429, code: "rate_limited", message: "Too many requests." });
  const identity = await authenticate(request, env);
  const perKey = await env.DATA_LIMIT.limit({ key: `key:${identity}` });
  if (!perKey.success)
    throw new ApiError({ status: 429, code: "rate_limited", message: "Too many requests." });
  if (request.method !== "GET") throw invalid("Use GET for data requests.");
  let version: string;
  try {
    version = decode(Version, env.DATASET_VERSION);
  } catch {
    throw new ApiError({
      status: 503,
      code: "dataset_unavailable",
      message: "A dataset has not been published.",
    });
  }
  const parsed = query(request, country, version);
  const cacheUrl = new URL(`/__internal_cache/${version}/${country || "countries"}`, request.url);
  cacheUrl.search = new URLSearchParams({
    lang: parsed.language,
    q: parsed.q,
    limit: String(parsed.limit),
    after: String(parsed.after),
  }).toString();
  const cacheKey = new Request(cacheUrl);
  let response = await caches.default.match(cacheKey);
  if (!response) {
    const body = JSON.stringify(country ? await cities(env, parsed) : await countries(env, parsed));
    response = new Response(body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Language": parsed.language,
        ETag: `"${createHash("sha256").update(body).digest("hex")}"`,
        "X-Dataset-Version": version,
        "Cache-Control": "public, max-age=31536000",
      },
    });
    ctx.waitUntil(
      caches.default.put(cacheKey, response.clone()).catch(() => {
        console.error(JSON.stringify({ event: "cache_write_failed" }));
      }),
    );
  }
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, max-age=86400, must-revalidate");
  headers.set("Vary", "Accept-Language");
  const etag = headers.get("ETag");
  const matches = request.headers
    .get("If-None-Match")
    ?.split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""));
  if (matches && (matches.includes("*") || (etag && matches.includes(etag))))
    return new Response(null, { status: 304, headers });
  return new Response(response.body, { headers });
}
app.get("/v1/countries.json", (c) => data(c.req.raw, c.env, c.executionCtx, ""));
app.get("/v1/countries/:countryCode/cities.json", (c) => {
  const country = decode(CountryCode, c.req.param("countryCode").toUpperCase());
  return data(c.req.raw, c.env, c.executionCtx, country);
});
export default app;
