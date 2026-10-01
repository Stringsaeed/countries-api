import { Buffer } from "node:buffer";
import { X509Certificate } from "node:crypto";
import cbor from "cbor";
import { Schema } from "effect";
import { verifyAttestation, verifyAssertion } from "node-app-attest";

const Attestation = Schema.Struct({
  fmt: Schema.Literal("apple-appattest"),
  authData: Schema.Uint8Array,
  attStmt: Schema.Struct({
    x5c: Schema.Array(Schema.Uint8Array).check(Schema.isMinLength(2), Schema.isMaxLength(2)),
    receipt: Schema.Uint8Array,
  }),
});
const Assertion = Schema.Struct({
  signature: Schema.Uint8Array,
  authenticatorData: Schema.Uint8Array,
});
const Verified = Schema.Struct({
  keyId: Schema.String,
  publicKey: Schema.String,
  receipt: Schema.Uint8Array,
  environment: Schema.Literals(["development", "production"]),
});

function oneCbor(bytes: Buffer): unknown {
  const values: unknown[] = cbor.decodeAllSync(bytes, { max_depth: 8 });
  if (values.length !== 1) throw new Error("Expected one CBOR object.");
  return values[0];
}
export function enroll(input: { keyId: string; challenge: string; attestation: string }, env: Env) {
  const bytes = Buffer.from(input.attestation, "base64");
  if (bytes.toString("base64") !== input.attestation) throw new Error("Invalid base64.");
  const object = Schema.decodeUnknownSync(Attestation)(oneCbor(bytes));
  if (object.authData.length < 55 || object.attStmt.receipt.length === 0)
    throw new Error("Invalid authenticator data.");
  const certificates = object.attStmt.x5c.map((der) => new X509Certificate(Buffer.from(der)));
  const now = Date.now();
  for (const certificate of certificates) {
    if (now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo))
      throw new Error("Expired or not yet valid certificate.");
  }
  const [leaf, intermediate] = certificates;
  if (!leaf || !intermediate || leaf.ca || !intermediate.ca || !leaf.checkIssued(intermediate))
    throw new Error("Invalid certificate chain.");
  const result: unknown = verifyAttestation({
    attestation: bytes,
    challenge: input.challenge,
    keyId: input.keyId,
    bundleIdentifier: env.APPLE_BUNDLE_ID,
    teamIdentifier: env.APPLE_APP_ID_PREFIX,
    allowDevelopmentEnvironment: env.ENVIRONMENT === "staging" || env.ENVIRONMENT === "local",
  });
  const verified = Schema.decodeUnknownSync(Verified)(result);
  return {
    publicKey: verified.publicKey,
    receipt: Buffer.from(verified.receipt).toString("base64"),
    environment: verified.environment,
  };
}
export function assertion(
  input: { assertion: string; payload: string; publicKey: string; signCount: number },
  env: Env,
) {
  const bytes = Buffer.from(input.assertion, "base64");
  if (bytes.toString("base64") !== input.assertion) throw new Error("Invalid base64.");
  const object = Schema.decodeUnknownSync(Assertion)(oneCbor(bytes));
  if (
    object.authenticatorData.length < 37 ||
    object.authenticatorData.length > 4096 ||
    object.signature.length > 128
  )
    throw new Error("Invalid authenticator data.");
  const result: unknown = verifyAssertion({
    assertion: bytes,
    payload: input.payload,
    publicKey: input.publicKey,
    signCount: input.signCount,
    bundleIdentifier: env.APPLE_BUNDLE_ID,
    teamIdentifier: env.APPLE_APP_ID_PREFIX,
  });
  return Schema.decodeUnknownSync(
    Schema.Struct({ signCount: Schema.Int.check(Schema.isGreaterThan(0)) }),
  )(result).signCount;
}
