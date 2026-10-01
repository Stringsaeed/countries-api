import { Schema } from "effect";
import { format, resolveConfig } from "prettier";
import { readFile, writeFile } from "node:fs/promises";
import {
  Country,
  City,
  Names,
  Language,
  Version,
  ChallengeRequest,
  AttestationRequest,
} from "../src/schema";

function jsonSchema(schema: Schema.Constraint) {
  const document = Schema.toJsonSchemaDocument(schema);
  if (Object.keys(document.definitions).length)
    throw new Error("OpenAPI schemas must be self-contained.");
  return document.schema;
}
const CountryResponse = Schema.Struct({
  ...Country.fields,
  name: Schema.NonEmptyString,
  names: Names,
  nameLanguage: Language,
});
const CityResponse = Schema.Struct({
  ...City.fields,
  name: Schema.NonEmptyString,
  names: Names,
  nameLanguage: Language,
});
const Meta = Schema.Struct({
  language: Language,
  version: Version,
  coverage: Schema.Literals(["world", "subset"]),
  nextCursor: Schema.NullOr(Schema.String),
});
const ProblemSchema = Schema.Struct({
  type: Schema.String,
  title: Schema.String,
  status: Schema.Int,
  detail: Schema.String,
  instance: Schema.String,
});
const security = [{ AppAttestKey: [], AppAttestChallenge: [], AppAttestAssertion: [] }];
function errors(statuses: number[]) {
  return Object.fromEntries(
    statuses.map((status) => [
      String(status),
      {
        description: "Request rejected or service unavailable.",
        content: {
          "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } },
        },
      },
    ]),
  );
}
function parameters(city: boolean) {
  return [
    {
      name: "Accept-Language",
      in: "header",
      description:
        "Weighted en and ar language ranges. Regional tags are supported. Defaults to en.",
      schema: { type: "string" },
    },
    { name: "If-None-Match", in: "header", schema: { type: "string" } },
    {
      name: "lang",
      in: "query",
      description: "Overrides Accept-Language.",
      schema: { type: "string", enum: ["en", "ar"] },
    },
    {
      name: "q",
      in: "query",
      description:
        "English or Arabic word-prefix search. City queries require at least 2 normalized characters and at most 5 words.",
      schema: { type: "string", maxLength: 128 },
    },
    {
      name: "limit",
      in: "query",
      schema: { type: "integer", minimum: 1, maximum: city ? 100 : 250, default: city ? 100 : 250 },
    },
    { name: "cursor", in: "query", schema: { type: "string", maxLength: 1024 } },
  ];
}
function list(schema: Schema.Constraint, city: boolean) {
  return {
    security,
    parameters: parameters(city),
    responses: {
      "200": {
        description: "A localized, paginated list.",
        headers: {
          "Content-Language": { schema: { type: "string", enum: ["en", "ar"] } },
          ETag: { schema: { type: "string" } },
          "X-Dataset-Version": { schema: { type: "string" } },
        },
        content: {
          "application/json": {
            schema: jsonSchema(
              Schema.Struct({
                data: Schema.Array(schema),
                meta: city ? Meta : Schema.Struct({ ...Meta.fields, total: Schema.Int }),
              }),
            ),
          },
        },
      },
      "304": { description: "The authenticated client's cached representation is current." },
      ...errors([400, 401, 404, 406, 409, 429, 500, 503]),
    },
  };
}
const document = {
  openapi: "3.1.0",
  info: {
    title: "Countries API",
    version: "1.0.0",
    description:
      "Geographic lists and English/Arabic search for native iOS clients. Follow docs/ios-authentication.md to construct cryptographic request proof.",
  },
  servers: [
    { url: "https://api.saeed.sh", description: "Production" },
    { url: "https://staging.api.saeed.sh", description: "Staging" },
  ],
  paths: {
    "/v1/countries.json": {
      get: { operationId: "listCountries", ...list(CountryResponse, false) },
    },
    "/v1/countries/{countryCode}/cities.json": {
      get: {
        operationId: "listCities",
        ...list(CityResponse, true),
        parameters: [
          {
            name: "countryCode",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^[A-Za-z]{2}$" },
          },
          ...parameters(true),
        ],
      },
    },
    "/v1/auth/challenge": {
      post: {
        operationId: "createChallenge",
        requestBody: {
          required: true,
          content: { "application/json": { schema: jsonSchema(ChallengeRequest) } },
        },
        responses: {
          "200": {
            description: "A one-time challenge valid for 120 seconds.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["challenge", "expiresAt"],
                  properties: {
                    challenge: { type: "string" },
                    expiresAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          ...errors([400, 401, 413, 415, 429, 500, 503]),
        },
      },
    },
    "/v1/auth/attest": {
      post: {
        operationId: "enrollAppAttestKey",
        requestBody: {
          required: true,
          content: { "application/json": { schema: jsonSchema(AttestationRequest) } },
        },
        responses: {
          "204": { description: "The key was enrolled." },
          ...errors([400, 401, 413, 415, 429, 500, 503]),
        },
      },
    },
    "/health": {
      get: {
        operationId: "health",
        responses: {
          "200": {
            description: "The Worker is running. This does not check deployment readiness.",
          },
        },
      },
    },
  },
  components: {
    schemas: { Problem: jsonSchema(ProblemSchema) },
    securitySchemes: {
      AppAttestKey: {
        type: "apiKey",
        in: "header",
        name: "X-App-Attest-Key-Id",
        description: "Apple's base64 key identifier, not a shared API secret.",
      },
      AppAttestChallenge: {
        type: "apiKey",
        in: "header",
        name: "X-App-Attest-Challenge",
        description: "A one-time server-issued challenge.",
      },
      AppAttestAssertion: {
        type: "apiKey",
        in: "header",
        name: "X-App-Attest-Assertion",
        description:
          "A fresh cryptographic assertion bound to the complete URL and signed headers.",
      },
    },
  },
};
const text = await format(JSON.stringify(document), {
  ...(await resolveConfig("docs/openapi.json")),
  parser: "json",
});
if (process.argv.includes("--check")) {
  if ((await readFile("docs/openapi.json", "utf8")) !== text)
    throw new Error("OpenAPI contract is stale. Run npm run api:generate.");
} else await writeFile("docs/openapi.json", text);
