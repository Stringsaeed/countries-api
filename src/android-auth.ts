import { Buffer } from "node:buffer";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { Schema } from "effect";
import { ApiError } from "./errors";

const Credentials = Schema.Struct({
  client_email: Schema.String,
  private_key: Schema.String,
});
const AccessToken = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.Int,
});
const Verdict = Schema.Struct({
  tokenPayloadExternal: Schema.Struct({
    requestDetails: Schema.Struct({
      requestPackageName: Schema.String,
      requestHash: Schema.String,
      timestampMillis: Schema.String,
    }),
    appIntegrity: Schema.Struct({
      appRecognitionVerdict: Schema.Literal("PLAY_RECOGNIZED"),
      packageName: Schema.String,
      certificateSha256Digest: Schema.Array(Schema.String),
    }),
    accountDetails: Schema.Struct({ appLicensingVerdict: Schema.Literal("LICENSED") }),
    deviceIntegrity: Schema.Struct({ deviceRecognitionVerdict: Schema.Array(Schema.String) }),
  }),
});
type AndroidEnv = Pick<
  Env,
  | "ENVIRONMENT"
  | "ANDROID_PACKAGE_NAME"
  | "ANDROID_CERTIFICATE_SHA256"
  | "GOOGLE_SERVICE_ACCOUNT_JSON"
>;
let cachedAccessToken: { credentials: string; token: string; expires: number } | undefined;

function unavailable() {
  return new ApiError({
    status: 503,
    code: "authentication_unavailable",
    message: "Android authentication is temporarily unavailable.",
  });
}
function unauthorized() {
  return new ApiError({
    status: 401,
    code: "unauthorized",
    message: "Valid Play Integrity proof is required.",
  });
}
export function androidConfig(env: AndroidEnv) {
  try {
    if (
      !["local", "staging", "production"].includes(env.ENVIRONMENT) ||
      !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(env.ANDROID_PACKAGE_NAME)
    )
      throw new Error("Invalid Android configuration.");
    const certificates = env.ANDROID_CERTIFICATE_SHA256.split(",").map((value) => value.trim());
    if (!certificates.length || certificates.some((value) => !/^[A-Za-z0-9_-]{43}$/.test(value)))
      throw new Error("Invalid signing certificate.");
    if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error("Missing service account.");
    const raw: unknown = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const credentials = Schema.decodeUnknownSync(Credentials)(raw);
    if (!/^[^@\s]+@[^@\s]+\.gserviceaccount\.com$/.test(credentials.client_email))
      throw new Error("Invalid service account.");
    const key = createPrivateKey(credentials.private_key);
    if (key.asymmetricKeyType !== "rsa") throw new Error("Invalid service account key.");
    return { packageName: env.ANDROID_PACKAGE_NAME, certificates, credentials, key };
  } catch {
    throw new ApiError({
      status: 503,
      code: "authentication_not_configured",
      message: "Android authentication has not been configured.",
    });
  }
}
export function androidRequestHash(request: Request) {
  return createHash("sha256")
    .update(
      [
        "countries-api:android:v1",
        request.method,
        request.url,
        request.headers.get("Accept-Language") ?? "",
        request.headers.get("If-None-Match") ?? "",
      ].join("\n"),
    )
    .digest("base64url");
}
async function accessToken(config: ReturnType<typeof androidConfig>) {
  const credentials = JSON.stringify(config.credentials);
  if (cachedAccessToken?.credentials === credentials && cachedAccessToken.expires > Date.now())
    return cachedAccessToken.token;
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      iss: config.credentials.client_email,
      scope: "https://www.googleapis.com/auth/playintegrity",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  ).toString("base64url");
  const payload = `${header}.${claims}`;
  const jwt = `${payload}.${sign("RSA-SHA256", Buffer.from(payload), config.key).toString("base64url")}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw unavailable();
  const raw: unknown = await response.json();
  const result = Schema.decodeUnknownSync(AccessToken)(raw);
  if (result.expires_in <= 60 || result.expires_in > 3600) throw unavailable();
  cachedAccessToken = {
    credentials,
    token: result.access_token,
    expires: Date.now() + (result.expires_in - 60) * 1000,
  };
  return result.access_token;
}
export async function authenticateAndroid(request: Request, env: Env) {
  const config = androidConfig(env);
  const token = request.headers.get("X-Play-Integrity-Token");
  if (!token || token.length > 16384 || !/^[A-Za-z0-9_.-]+$/.test(token)) throw unauthorized();
  const tokenId = createHash("sha256").update(token).digest("hex");
  const replay = env.APP_ATTEST.get(
    env.APP_ATTEST.idFromName(`play-integrity:${tokenId.slice(0, 2)}`),
  );
  if (!(await replay.claimIntegrityToken(tokenId))) throw unauthorized();
  try {
    const access = await accessToken(config);
    const response = await fetch(
      `https://playintegrity.googleapis.com/v1/${config.packageName}:decodeIntegrityToken`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
        body: JSON.stringify({ integrity_token: token }),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (response.status === 400) throw unauthorized();
    if (!response.ok) {
      if (response.status === 401) cachedAccessToken = undefined;
      throw unavailable();
    }
    const raw: unknown = await response.json();
    let verdict: typeof Verdict.Type;
    try {
      verdict = Schema.decodeUnknownSync(Verdict)(raw);
    } catch {
      throw unauthorized();
    }
    const { requestDetails, appIntegrity, deviceIntegrity } = verdict.tokenPayloadExternal;
    const timestamp = Number(requestDetails.timestampMillis);
    const age = Date.now() - timestamp;
    if (
      requestDetails.requestPackageName !== config.packageName ||
      appIntegrity.packageName !== config.packageName ||
      requestDetails.requestHash !== androidRequestHash(request) ||
      !/^[0-9]+$/.test(requestDetails.timestampMillis) ||
      !Number.isSafeInteger(timestamp) ||
      age < 0 ||
      age > 120000 ||
      !appIntegrity.certificateSha256Digest.length ||
      !appIntegrity.certificateSha256Digest.every((digest) =>
        config.certificates.includes(digest),
      ) ||
      !deviceIntegrity.deviceRecognitionVerdict.includes("MEETS_DEVICE_INTEGRITY")
    )
      throw unauthorized();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unavailable();
  }
  return `android:ip:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`;
}
