import { Schema } from "effect";
import { readFile } from "node:fs/promises";
import { Manifest, Version } from "../src/schema";

const base = new URL(process.env.API_BASE_URL ?? "");
if (base.protocol !== "https:" || base.pathname !== "/" || base.search || base.hash)
  throw new Error("Set API_BASE_URL to the deployed HTTPS origin.");
const pointer: unknown = JSON.parse(await readFile("data/generated/latest.json", "utf8"));
const { version } = Schema.decodeUnknownSync(Schema.Struct({ version: Version }))(pointer);
const Health = Schema.Struct({
  status: Schema.Literal("ok"),
  datasetVersion: Schema.Literal(version),
});
const Problem = Schema.Struct({
  title: Schema.Literal("unauthorized"),
  status: Schema.Literal(401),
});
const response = await fetch(new URL("/health", base), {
  redirect: "error",
  signal: AbortSignal.timeout(30000),
});
if (!response.ok) throw new Error(`Health check failed (${response.status}).`);
const health: unknown = await response.json();
Schema.decodeUnknownSync(Health)(health);
for (const path of ["/v1/countries.json", "/v1/countries/AE/cities.json?q=Dubai"]) {
  const result = await fetch(new URL(path, base), {
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (result.status !== 401)
    throw new Error(`Unauthenticated request failed its access-control check (${result.status}).`);
  const value: unknown = await result.json();
  Schema.decodeUnknownSync(Problem)(value);
  if (result.headers.get("Cache-Control") !== "no-store")
    throw new Error("Authentication failures must not be cached.");
}
const value: unknown = JSON.parse(
  await readFile(`data/generated/${version}/manifest.json`, "utf8"),
);
Schema.decodeUnknownSync(Manifest)(value);
console.info(
  JSON.stringify({
    origin: base.origin,
    datasetVersion: version,
    health: "ok",
    unauthenticatedAccess: "denied",
  }),
);
