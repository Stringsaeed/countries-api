import { DurableObject } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import { Schema } from "effect";
import { ApiError, decode } from "./errors";
import { assertion, enroll } from "./attestation";
import { AttestationRequest, Challenge, KeyId } from "./schema";

type Success<T> = { ok: true; value: T };
type Failure = { ok: false; reason: "unauthorized" | "rate_limited" };
type Result<T> = Success<T> | Failure;
const unauthorized: Failure = { ok: false, reason: "unauthorized" };
const StoredKey = Schema.Struct({
  publicKey: Schema.String,
  receipt: Schema.String,
  environment: Schema.String,
  signCount: Schema.Int,
});

export class AppAttestDevice extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS device (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS challenges (value TEXT PRIMARY KEY, purpose TEXT NOT NULL, expires INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS quota (id INTEGER PRIMARY KEY CHECK(id=1), window INTEGER NOT NULL, count INTEGER NOT NULL)",
    );
  }
  challenge(
    purpose: "attestation" | "assertion",
  ): Result<{ challenge: string; expiresAt: string }> {
    const now = Date.now();
    const window = Math.floor(now / 60000);
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM challenges WHERE expires <= ?", now);
      const quota = this.ctx.storage.sql
        .exec<{ window: number; count: number }>("SELECT window,count FROM quota WHERE id=1")
        .toArray()[0];
      if (quota?.window === window && quota.count >= 60)
        return { ok: false, reason: "rate_limited" };
      this.ctx.storage.sql.exec(
        "INSERT INTO quota VALUES (1,?,1) ON CONFLICT(id) DO UPDATE SET window=excluded.window, count=CASE WHEN quota.window=excluded.window THEN quota.count+1 ELSE 1 END",
        window,
      );
      const key = this.ctx.storage.sql.exec("SELECT id FROM device WHERE id=1").toArray()[0];
      if ((purpose === "assertion" && !key) || (purpose === "attestation" && key))
        return unauthorized;
      const count =
        this.ctx.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM challenges")
          .toArray()[0]?.count ?? 0;
      if (count >= 8) return { ok: false, reason: "rate_limited" };
      const challenge = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
        "base64url",
      );
      const expires = now + 120000;
      this.ctx.storage.sql.exec(
        "INSERT INTO challenges VALUES (?,?,?)",
        challenge,
        purpose,
        expires,
      );
      return { ok: true, value: { challenge, expiresAt: new Date(expires).toISOString() } };
    });
  }
  private consume(challenge: string, purpose: string) {
    const entry = this.ctx.storage.sql
      .exec<{ purpose: string; expires: number }>(
        "SELECT purpose,expires FROM challenges WHERE value=?",
        challenge,
      )
      .toArray()[0];
    this.ctx.storage.sql.exec("DELETE FROM challenges WHERE value=?", challenge);
    return entry?.purpose === purpose && entry.expires > Date.now();
  }
  register(input: typeof AttestationRequest.Type): Result<null> {
    if (!this.consume(input.challenge, "attestation")) return unauthorized;
    if (this.ctx.storage.sql.exec("SELECT id FROM device WHERE id=1").toArray().length)
      return unauthorized;
    try {
      const key = enroll(input, this.env);
      this.ctx.storage.sql.exec(
        "INSERT INTO device VALUES (1,?)",
        JSON.stringify({ ...key, signCount: 0 }),
      );
      return { ok: true, value: null };
    } catch {
      return unauthorized;
    }
  }
  verify(input: { challenge: string; assertion: string; payload: string }): Result<null> {
    return this.ctx.storage.transactionSync(() => {
      if (!this.consume(input.challenge, "assertion")) return unauthorized;
      const row = this.ctx.storage.sql
        .exec<{ value: string }>("SELECT value FROM device WHERE id=1")
        .toArray()[0];
      if (!row) return unauthorized;
      try {
        const raw: unknown = JSON.parse(row.value);
        const key = Schema.decodeUnknownSync(StoredKey)(raw);
        const signCount = assertion(
          { ...input, publicKey: key.publicKey, signCount: key.signCount },
          this.env,
        );
        this.ctx.storage.sql.exec(
          "UPDATE device SET value=? WHERE id=1",
          JSON.stringify({ ...key, signCount }),
        );
        return { ok: true, value: null };
      } catch {
        return unauthorized;
      }
    });
  }
}
export function configured(env: Env) {
  if (
    !["local", "staging", "production"].includes(env.ENVIRONMENT) ||
    !/^[A-Z0-9]{10}$/.test(env.APPLE_APP_ID_PREFIX) ||
    !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(env.APPLE_BUNDLE_ID)
  ) {
    throw new ApiError({
      status: 503,
      code: "authentication_not_configured",
      message: "App authentication has not been configured.",
    });
  }
}
export function device(env: Env, keyId: string) {
  const id = env.APP_ATTEST.idFromName(createHash("sha256").update(keyId).digest("hex"));
  return env.APP_ATTEST.get(id);
}
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok)
    throw new ApiError({
      status: result.reason === "rate_limited" ? 429 : 401,
      code: result.reason,
      message:
        result.reason === "rate_limited"
          ? "Too many requests."
          : "Valid App Attest proof is required.",
    });
  return result.value;
}
export function requestPayload(request: Request, challenge: string) {
  return [
    "countries-api:v1",
    request.method,
    request.url,
    request.headers.get("Accept-Language") ?? "",
    request.headers.get("If-None-Match") ?? "",
    challenge,
  ].join("\n");
}
export async function authenticate(request: Request, env: Env): Promise<string> {
  const host = new URL(request.url).hostname;
  if (
    env.ENVIRONMENT === "local" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(host) &&
    env.DEV_AUTH_TOKEN
  ) {
    const supplied = Buffer.from(request.headers.get("Authorization") ?? "");
    const expected = Buffer.from(`Bearer ${env.DEV_AUTH_TOKEN}`);
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return "local";
  }
  configured(env);
  let keyId: string;
  let challenge: string;
  try {
    keyId = decode(KeyId, request.headers.get("X-App-Attest-Key-Id"));
    challenge = decode(Challenge, request.headers.get("X-App-Attest-Challenge"));
  } catch {
    throw new ApiError({
      status: 401,
      code: "unauthorized",
      message: "Valid App Attest proof is required.",
    });
  }
  const proof = request.headers.get("X-App-Attest-Assertion");
  if (!proof || proof.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(proof))
    throw new ApiError({
      status: 401,
      code: "unauthorized",
      message: "Valid App Attest proof is required.",
    });
  unwrap(
    await device(env, keyId).verify({
      challenge,
      assertion: proof,
      payload: requestPayload(request, challenge),
    }),
  );
  return createHash("sha256").update(keyId).digest("hex");
}
