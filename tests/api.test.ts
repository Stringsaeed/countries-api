import {
  env,
  SELF,
  createExecutionContext,
  waitOnExecutionContext,
  runInDurableObject,
} from "cloudflare:test";
import { beforeAll, describe, expect, it, vi, afterEach } from "vitest";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { Buffer } from "node:buffer";
import cbor from "cbor";
import { Schema } from "effect";
import app from "../src/worker";
import { device, requestPayload } from "../src/auth";
import { enroll } from "../src/attestation";
import { androidRequestHash } from "../src/android-auth";
import { query, normalizeSearch } from "../src/query";
import developmentFixture from "./fixtures/attestation-development.json";
import productionFixture from "./fixtures/attestation-production.json";

const country = {
  code: "AE",
  name: { en: "United Arab Emirates", ar: "الإمارات العربية المتحدة" },
  flag: "🇦🇪",
  prayerCalculationMethod: "dubai",
};
const dubai = {
  id: 292223,
  countryCode: "AE",
  name: { en: "Dubai", ar: "دبي" },
  region: "03",
  location: { latitude: 25.0657, longitude: 55.17128 },
  timezone: "Asia/Dubai",
  prayerCalculationMethod: "dubai",
};
const sharjah = { ...dubai, id: 292672, name: { en: "Sharjah", ar: "الشارقة" } };
const village = { ...dubai, id: 300000, name: { en: "Example village", ar: null } };
const headers = { Authorization: "Bearer local-test-token" };
const Problem = Schema.Struct({ title: Schema.String, status: Schema.Int });
const Page = Schema.Struct({
  data: Schema.Array(Schema.Struct({ name: Schema.String, nameLanguage: Schema.String })),
  meta: Schema.Struct({ nextCursor: Schema.NullOr(Schema.String), language: Schema.String }),
});
async function page(response: Response) {
  const value: unknown = await response.json();
  return Schema.decodeUnknownSync(Page)(value);
}
async function problem(response: Response) {
  const value: unknown = await response.json();
  return Schema.decodeUnknownSync(Problem)(value);
}
async function local(path: string, extra: HeadersInit = {}) {
  return SELF.fetch(`http://localhost${path}`, { headers: { ...headers, ...extra } });
}
beforeAll(async () => {
  await env.DATA.put(
    `${env.DATASET_VERSION}/manifest.json`,
    JSON.stringify({
      version: env.DATASET_VERSION,
      pageSize: 100,
      countries: [
        country,
        {
          code: "EG",
          name: { en: "Egypt", ar: "مصر" },
          flag: "🇪🇬",
          prayerCalculationMethod: "egyptian",
        },
      ],
      countryCityCounts: { AE: 3, EG: 0 },
      cityCount: 3,
      arabicCityCount: 2,
      coverage: "world",
      sources: [],
    }),
  );
  await env.DATA.put(
    `${env.DATASET_VERSION}/cities/AE/0.json`,
    JSON.stringify([dubai, sharjah, village]),
  );
  await env.SEARCH.exec(
    "CREATE TABLE cities(id INTEGER PRIMARY KEY,countryCode TEXT,ordinal INTEGER,payload TEXT); CREATE VIRTUAL TABLE city_search USING fts5(countryCode,names,content='',prefix='2 3 4');",
  );
  for (const [index, city] of [dubai, sharjah, village].entries()) {
    await env.SEARCH.prepare("INSERT INTO cities VALUES(?,?,?,?)")
      .bind(city.id, "AE", index + 1, JSON.stringify(city))
      .run();
    await env.SEARCH.prepare("INSERT INTO city_search(rowid,countryCode,names) VALUES(?,?,?)")
      .bind(city.id, "ae", normalizeSearch(`${city.name.en} ${city.name.ar ?? ""}`))
      .run();
  }
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("data API", () => {
  it("reports the deployed dataset version for release verification", async () => {
    const response = await SELF.fetch("https://api.example.com/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", datasetVersion: "0123456789abcdef" });
  });
  it("negotiates Arabic regional language tags and weights", async () => {
    const response = await local("/v1/countries.json", {
      "Accept-Language": "fr;q=1,ar-EG;q=0.9,en;q=0.5",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Language")).toBe("ar");
    expect(response.headers.get("Vary")).toBe("Accept-Language");
    expect((await page(response)).data.map((item) => item.name)).toEqual([
      "الإمارات العربية المتحدة",
      "مصر",
    ]);
  });
  it("respects explicit language and refuses unsupported negotiation", async () => {
    expect(
      (await page(await local("/v1/countries.json?lang=en", { "Accept-Language": "ar" }))).meta
        .language,
    ).toBe("en");
    expect((await local("/v1/countries.json", { "Accept-Language": "fr" })).status).toBe(406);
    expect((await local("/v1/countries.json?lang=fr")).status).toBe(400);
  });
  it("searches both languages independent of display language", async () => {
    expect(
      (await page(await local("/v1/countries/ae/cities.json?q=دُبَـي&lang=en"))).data.map(
        (item) => item.name,
      ),
    ).toEqual(["Dubai"]);
    expect(
      (await page(await local("/v1/countries/AE/cities.json?q=dub&lang=ar"))).data.map(
        (item) => item.name,
      ),
    ).toEqual(["دبي"]);
    expect(
      (await page(await local("/v1/countries.json?q=مصر&lang=en"))).data.map((item) => item.name),
    ).toEqual(["Egypt"]);
  });
  it("paginates lists and discloses translation fallback", async () => {
    const first = await page(await local("/v1/countries/AE/cities.json?lang=ar&limit=2"));
    expect(first.data.map((item) => item.name)).toEqual(["دبي", "الشارقة"]);
    const second = await page(
      await local(`/v1/countries/AE/cities.json?lang=ar&limit=2&cursor=${first.meta.nextCursor}`),
    );
    expect(second.data).toEqual([{ name: "Example village", nameLanguage: "en" }]);
    expect(second.meta.nextCursor).toBeNull();
    expect(
      (await local(`/v1/countries/AE/cities.json?lang=en&cursor=${first.meta.nextCursor}`)).status,
    ).toBe(400);
  });
  it("paginates indexed search without duplicates", async () => {
    const first = await page(await local("/v1/countries/AE/cities.json?q=sh&limit=1"));
    expect(first.data.map((item) => item.name)).toEqual(["Sharjah"]);
    expect(first.meta.nextCursor).toBeNull();
  });
  it("keeps cache variants separate and checks authorization on a warmed cache", async () => {
    const ctx = createExecutionContext();
    const response = await app.fetch(
      new Request("http://localhost/v1/countries.json?lang=en", { headers }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("private");
    const etag = response.headers.get("ETag") ?? "";
    expect((await local("/v1/countries.json?lang=en", { "If-None-Match": etag })).status).toBe(304);
    expect(
      (
        await SELF.fetch("http://localhost/v1/countries.json?lang=en", {
          headers: { "If-None-Match": etag },
        })
      ).status,
    ).toBe(401);
    expect((await page(await local("/v1/countries.json?lang=ar"))).data[0]?.name).toBe(
      "الإمارات العربية المتحدة",
    );
  });
  it("rejects duplicate, unknown, oversized and invalid queries", async () => {
    for (const path of [
      "/v1/countries.json?lang=en&lang=ar",
      "/v1/countries.json?unexpected=1",
      "/v1/countries/AE/cities.json?limit=101",
      "/v1/countries/AE/cities.json?q=x",
      "/v1/countries/AE/cities.json?cursor=invalid",
    ])
      expect((await local(path)).status).toBe(400);
    expect((await local("/v1/countries/XX/cities.json")).status).toBe(404);
    expect((await local("/v1/countries/EG/cities.json")).status).toBe(200);
  });
  it("returns standardized errors without exposing internal details", async () => {
    const response = await SELF.fetch("http://localhost/v1/countries.json");
    expect(response.headers.get("Content-Type")).toBe("application/problem+json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await problem(response)).toEqual({ title: "unauthorized", status: 401 });
    expect(response.headers.get("X-Request-Id")).toBeTruthy();
  });
  it("never permits the local token on production or non-loopback hosts", async () => {
    for (const [environment, url] of [
      ["production", "http://localhost/v1/countries.json"],
      ["local", "https://api.example.com/v1/countries.json"],
    ]) {
      const ctx = createExecutionContext();
      const response = await app.fetch(
        new Request(url ?? "", { headers }),
        { ...env, ENVIRONMENT: environment ?? "" },
        ctx,
      );
      expect(response.status).toBe(401);
    }
  });
  it("requires configured authentication in production", async () => {
    const ctx = createExecutionContext();
    const response = await app.fetch(
      new Request("https://api.example.com/v1/countries.json"),
      { ...env, ENVIRONMENT: "production", APPLE_APP_ID_PREFIX: "UNCONFIGURED" },
      ctx,
    );
    expect(response.status).toBe(503);
  });
  it("rejects cursors from another dataset", () => {
    const cursor = Buffer.from(
      JSON.stringify({
        version: "1111111111111111",
        country: "AE",
        language: "en",
        q: "",
        after: 1,
      }),
    ).toString("base64url");
    expect(() =>
      query(
        new Request(`https://api.example.com/v1/countries/AE/cities.json?cursor=${cursor}`),
        "AE",
        env.DATASET_VERSION,
      ),
    ).toThrow("The dataset changed");
  });
});
describe("App Attest", () => {
  it("verifies recorded Apple certificate chains in the Workers runtime", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-03-01T00:00:00Z"));
    for (const fixture of [developmentFixture, productionFixture]) {
      const result = enroll(
        { ...fixture, challenge: Buffer.from(fixture.challenge, "base64").toString("utf8") },
        { ...env, ENVIRONMENT: "staging" },
      );
      expect(result.publicKey).toContain("BEGIN PUBLIC KEY");
    }
    expect(() =>
      enroll(
        {
          ...developmentFixture,
          challenge: Buffer.from(developmentFixture.challenge, "base64").toString("utf8"),
        },
        { ...env, ENVIRONMENT: "production" },
      ),
    ).toThrow();
  });
  it("rejects expired certificates and altered challenges", () => {
    expect(() => enroll({ ...productionFixture, challenge: "wrong" }, env)).toThrow();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-03-01T00:00:00Z"));
    expect(() => enroll({ ...productionFixture, challenge: "wrong" }, env)).toThrow();
  });
  it("consumes challenges and prevents counter replay under concurrent requests", async () => {
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const keyId = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    const stub = device(env, keyId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO device VALUES (1,?)",
        JSON.stringify({
          publicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
          receipt: "fixture",
          environment: "production",
          signCount: 0,
        }),
      );
    });
    const issued = await stub.challenge("assertion");
    if (!issued.ok) throw new Error("Expected challenge");
    const challenge = issued.value.challenge;
    const request = new Request("https://api.example.com/v1/countries.json?lang=ar");
    const payload = requestPayload(request, challenge);
    const data = Buffer.alloc(37);
    createHash("sha256")
      .update(`${env.APPLE_APP_ID_PREFIX}.${env.APPLE_BUNDLE_ID}`)
      .digest()
      .copy(data);
    data.writeUInt32BE(1, 33);
    const nonce = createHash("sha256")
      .update(Buffer.concat([data, createHash("sha256").update(payload).digest()]))
      .digest();
    const proof = cbor
      .encode({ authenticatorData: data, signature: sign("sha256", nonce, keys.privateKey) })
      .toString("base64");
    const results = await Promise.all([
      stub.verify({ challenge, assertion: proof, payload }),
      stub.verify({ challenge, assertion: proof, payload }),
    ]);
    expect(results.map((result) => result.ok).sort()).toEqual([false, true]);
    const valid = await stub.challenge("assertion");
    if (!valid.ok) throw new Error("Expected challenge");
    const get = new Request("https://api.example.com/v1/countries.json?lang=ar");
    const signedPayload = requestPayload(get, valid.value.challenge);
    data.writeUInt32BE(2, 33);
    const signedNonce = createHash("sha256")
      .update(Buffer.concat([data, createHash("sha256").update(signedPayload).digest()]))
      .digest();
    const signedProof = cbor
      .encode({ authenticatorData: data, signature: sign("sha256", signedNonce, keys.privateKey) })
      .toString("base64");
    const signedHeaders = {
      "X-App-Attest-Key-Id": keyId,
      "X-App-Attest-Challenge": valid.value.challenge,
      "X-App-Attest-Assertion": signedProof,
    };
    const ctx = createExecutionContext();
    const success = await app.fetch(
      new Request(get.url, { headers: signedHeaders }),
      { ...env, ENVIRONMENT: "production" },
      ctx,
    );
    expect(success.status).toBe(200);
    expect((await page(success)).data[0]?.name).toBe("الإمارات العربية المتحدة");
    await waitOnExecutionContext(ctx);
    expect(
      (
        await app.fetch(
          new Request(get.url, { headers: signedHeaders }),
          { ...env, ENVIRONMENT: "production" },
          createExecutionContext(),
        )
      ).status,
    ).toBe(401);
    const altered = await stub.challenge("assertion");
    if (!altered.ok) throw new Error("Expected challenge");
    const originalURL = new Request("https://api.example.com/v1/countries.json?lang=ar");
    data.writeUInt32BE(3, 33);
    const alteredNonce = createHash("sha256")
      .update(
        Buffer.concat([
          data,
          createHash("sha256")
            .update(requestPayload(originalURL, altered.value.challenge))
            .digest(),
        ]),
      )
      .digest();
    const alteredProof = cbor
      .encode({ authenticatorData: data, signature: sign("sha256", alteredNonce, keys.privateKey) })
      .toString("base64");
    const denied = await app.fetch(
      new Request("https://api.example.com/v1/countries.json?lang=en", {
        headers: {
          "X-App-Attest-Key-Id": keyId,
          "X-App-Attest-Challenge": altered.value.challenge,
          "X-App-Attest-Assertion": alteredProof,
        },
      }),
      { ...env, ENVIRONMENT: "production" },
      createExecutionContext(),
    );
    expect(denied.status).toBe(401);
    const next = await stub.challenge("assertion");
    if (!next.ok) throw new Error("Expected challenge");
    expect(
      (await stub.verify({ challenge: next.value.challenge, assertion: proof, payload })).ok,
    ).toBe(false);
  });
  it("limits outstanding challenges and rejects malformed enrollment", async () => {
    const keyId = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    const stub = device(env, keyId);
    const issued = await stub.challenge("attestation");
    if (!issued.ok) throw new Error("Expected challenge");
    expect(
      (await stub.register({ keyId, challenge: issued.value.challenge, attestation: "AAAA" })).ok,
    ).toBe(false);
    expect(
      (await stub.register({ keyId, challenge: issued.value.challenge, attestation: "AAAA" })).ok,
    ).toBe(false);
    for (let i = 0; i < 8; i++) expect((await stub.challenge("attestation")).ok).toBe(true);
    expect(await stub.challenge("attestation")).toEqual({ ok: false, reason: "rate_limited" });
    expect((await stub.challenge("assertion")).ok).toBe(false);
  });
});

describe("Android authentication", () => {
  it("matches the Android canonical payload test vector, including the empty ETag", () => {
    const req = new Request("https://api.example.com/v1/countries.json?lang=en", {
      headers: { "Accept-Language": "en" },
    });
    expect(androidRequestHash(req)).toBe("qiMLNzO9e1_BHYxHtLy42Hk2R1Eyku5kndgTj5uXaac");
  });
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const certificate = Buffer.alloc(32, 7).toString("base64url");
  const androidEnv = {
    ...env,
    ENVIRONMENT: "production",
    ANDROID_PACKAGE_NAME: "sh.saeed.azkarify",
    ANDROID_CERTIFICATE_SHA256: certificate,
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      client_email: "countries-api@test-project.iam.gserviceaccount.com",
      private_key: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
    }),
  };
  function request(extra: HeadersInit = {}, token = crypto.randomUUID()) {
    return new Request("https://api.example.com/v1/countries.json?lang=en", {
      headers: { "X-Play-Integrity-Token": token, ...extra },
    });
  }
  function verdict(request: Request) {
    return {
      tokenPayloadExternal: {
        requestDetails: {
          requestPackageName: androidEnv.ANDROID_PACKAGE_NAME,
          requestHash: androidRequestHash(request),
          timestampMillis: String(Date.now()),
        },
        appIntegrity: {
          appRecognitionVerdict: "PLAY_RECOGNIZED",
          packageName: androidEnv.ANDROID_PACKAGE_NAME,
          certificateSha256Digest: [certificate],
        },
        accountDetails: { appLicensingVerdict: "LICENSED" },
        deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
      },
    };
  }
  function google(payload: unknown, decodeStatus = 200) {
    return vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      if (url === "https://oauth2.googleapis.com/token") {
        if (!(init?.body instanceof URLSearchParams)) throw new Error("Expected form data.");
        const params = init.body;
        expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
        const jwt = params.get("assertion")?.split(".") ?? [];
        expect(jwt).toHaveLength(3);
        expect(
          verify(
            "RSA-SHA256",
            Buffer.from(`${jwt[0]}.${jwt[1]}`),
            keys.publicKey,
            Buffer.from(jwt[2] ?? "", "base64url"),
          ),
        ).toBe(true);
        const claims: unknown = JSON.parse(Buffer.from(jwt[1] ?? "", "base64url").toString());
        expect(claims).toMatchObject({
          iss: "countries-api@test-project.iam.gserviceaccount.com",
          scope: "https://www.googleapis.com/auth/playintegrity",
          aud: "https://oauth2.googleapis.com/token",
        });
        return Promise.resolve(
          Response.json({ access_token: "google-test-access-token", expires_in: 3600 }),
        );
      }
      expect(url).toBe(
        "https://playintegrity.googleapis.com/v1/sh.saeed.azkarify:decodeIntegrityToken",
      );
      expect(init?.headers).toEqual({
        Authorization: "Bearer google-test-access-token",
        "Content-Type": "application/json",
      });
      return Promise.resolve(Response.json(payload, { status: decodeStatus }));
    });
  }
  async function send(request: Request, bindings: Env = androidEnv) {
    const ctx = createExecutionContext();
    const response = await app.fetch(request, bindings, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }
  it("serves catalog data and rejects reuse before contacting Google again", async () => {
    const req = request({ "Accept-Language": "en" });
    const mock = google(verdict(req));
    const response = await send(req.clone());
    expect(response.status).toBe(200);
    expect((await page(response)).data.map((country) => country.name)).toEqual([
      "United Arab Emirates",
      "Egypt",
    ]);
    const calls = mock.mock.calls.length;
    const replay = await send(req.clone());
    expect(replay.status).toBe(401);
    expect(mock.mock.calls.length).toBe(calls);
  });
  it("requires a fresh token for conditional requests on a warmed cache", async () => {
    const req = request();
    google(verdict(req));
    const response = await send(req);
    const conditional = request({ "If-None-Match": response.headers.get("ETag") ?? "" });
    google(verdict(conditional));
    expect((await send(conditional)).status).toBe(304);
  });
  it("serves Arabic city search through Android authentication without Apple configuration", async () => {
    const req = new Request("https://api.example.com/v1/countries/AE/cities.json?q=Dubai", {
      headers: { "X-Play-Integrity-Token": crypto.randomUUID(), "Accept-Language": "ar" },
    });
    google(verdict(req));
    const response = await send(req, {
      ...androidEnv,
      APPLE_APP_ID_PREFIX: "UNCONFIGURED",
      APPLE_BUNDLE_ID: "UNCONFIGURED",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Language")).toBe("ar");
    expect((await page(response)).data.map((city) => city.name)).toEqual(["دبي"]);
  });
  it("accepts a token only once when duplicate requests arrive concurrently", async () => {
    const req = request();
    google(verdict(req));
    const responses = await Promise.all([send(req.clone()), send(req.clone())]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
  });
  it.each(["url", "language", "etag", "method"])(
    "rejects proof bound to another %s",
    async (field) => {
      const req = request();
      const other = new Request(field === "url" ? `${req.url}&limit=1` : req.url, {
        method: field === "method" ? "POST" : "GET",
        headers:
          field === "language"
            ? { "Accept-Language": "ar" }
            : field === "etag"
              ? { "If-None-Match": '"other"' }
              : {},
      });
      google(verdict(other));
      expect((await send(req)).status).toBe(401);
    },
  );
  it.each([
    "request-package",
    "app-package",
    "certificate",
    "recognition",
    "license",
    "device",
    "expired",
    "future",
    "timestamp",
  ])("rejects invalid %s verdicts", async (field) => {
    const req = request();
    const payload = verdict(req);
    const details = payload.tokenPayloadExternal;
    switch (field) {
      case "request-package":
        details.requestDetails.requestPackageName = "com.other.app";
        break;
      case "app-package":
        details.appIntegrity.packageName = "com.other.app";
        break;
      case "certificate":
        details.appIntegrity.certificateSha256Digest = [Buffer.alloc(32, 8).toString("base64url")];
        break;
      case "recognition":
        details.appIntegrity.appRecognitionVerdict = "UNEVALUATED";
        break;
      case "license":
        details.accountDetails.appLicensingVerdict = "UNLICENSED";
        break;
      case "device":
        details.deviceIntegrity.deviceRecognitionVerdict = [];
        break;
      case "expired":
        details.requestDetails.timestampMillis = String(Date.now() - 121000);
        break;
      case "future":
        details.requestDetails.timestampMillis = String(Date.now() + 10000);
        break;
      case "timestamp":
        details.requestDetails.timestampMillis = "NaN";
        break;
    }
    google(payload);
    const response = await send(req);
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("fails closed without Android credentials while leaving local debug access available", async () => {
    expect((await send(request(), { ...env, ENVIRONMENT: "production" })).status).toBe(503);
    expect((await local("/v1/countries.json")).status).toBe(200);
  });
  it.each(["service-account", "certificate"])(
    "rejects partial configuration missing the %s before contacting Google",
    async (missing) => {
      const mock = google({});
      const response = await send(request(), {
        ...androidEnv,
        ...(missing === "service-account"
          ? { GOOGLE_SERVICE_ACCOUNT_JSON: "" }
          : { ANDROID_CERTIFICATE_SHA256: "" }),
      });
      expect(response.status).toBe(503);
      expect(await problem(response)).toMatchObject({ title: "authentication_not_configured" });
      expect(mock).not.toHaveBeenCalled();
    },
  );
  it("maps Google outages to 503 and consumes the failed token", async () => {
    const req = request();
    google({}, 503);
    expect((await send(req.clone())).status).toBe(503);
    expect((await send(req.clone())).status).toBe(401);
  });
  it("rejects malformed tokens before contacting Google", async () => {
    const mock = google({});
    expect((await send(request({}, "bad token"))).status).toBe(401);
    expect(mock).not.toHaveBeenCalled();
  });
});
