import {
  env,
  SELF,
  createExecutionContext,
  waitOnExecutionContext,
  runInDurableObject,
} from "cloudflare:test";
import { beforeAll, describe, expect, it, vi, afterEach } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { Buffer } from "node:buffer";
import cbor from "cbor";
import { Schema } from "effect";
import app from "../src/worker";
import { device, requestPayload } from "../src/auth";
import { enroll } from "../src/attestation";
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
afterEach(() => vi.useRealTimers());
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
