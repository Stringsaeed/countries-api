# iOS request authentication

Enable the App Attest capability for the app's explicit App ID. Verify that the provisioning profile includes `com.apple.developer.devicecheck.appattest-environment`. Use development attestation with the staging API and production attestation with the production API. Production rejects development keys.

Use `DCAppAttestService.shared.isSupported` on a physical supported device. Production has no unauthenticated fallback for unsupported devices or simulators. Cache previously downloaded data if offline behavior is required.

## Enroll a key

1. Generate the key with `DCAppAttestService.generateKey()`.
2. Send `POST /v1/auth/challenge` with `{"keyId":"<Apple base64 key ID>","purpose":"attestation"}`.
3. Hash the UTF-8 bytes of the returned `challenge` string using SHA-256. Do not decode it from base64url before hashing.
4. Pass that hash to `attestKey(_:clientDataHash:)`.
5. Send `POST /v1/auth/attest` with `keyId`, `challenge`, and the standard base64 `attestation` object. A successful response is `204`.
6. Persist the key ID only after enrollment succeeds. Apple stores the private key. Each environment needs its own enrollment.

The server validates the CBOR shape, certificate validity, chain, nonce, public-key hash, App ID hash, initial counter, environment, and credential ID. It stores the public key and receipt in a Durable Object. The baseline verifier is `node-app-attest`, with additional boundary and certificate checks in this repository. Apple fraud-receipt assessment and newer optional attestation extension policy are not enabled in this version.

## Sign a data request

Request another challenge using `purpose=assertion`. Build the exact payload below, joined with a single LF byte, with no trailing newline:

```text
countries-api:v1
GET
<complete HTTPS request URL, including the encoded query>
<Accept-Language header, or an empty string>
<If-None-Match header, or an empty string>
<challenge string>
```

Hash the UTF-8 payload using SHA-256 and pass it to `generateAssertion(_:clientDataHash:)`. Send the request with these headers:

- `X-App-Attest-Key-Id`: Apple's standard base64 key ID.
- `X-App-Attest-Challenge`: the returned challenge string.
- `X-App-Attest-Assertion`: the assertion object's standard base64 encoding.

The URL and signed headers must match the request transmitted over HTTP. Prefer `Accept-Language: en` or `ar`. Redirects change the signed URL, so call the final HTTPS API origin directly.

Challenges expire after 120 seconds. Each key can have eight outstanding challenges. The server consumes a challenge on a verification attempt, including a failed attempt. Obtain a new challenge and assertion for each retry. Requests and counter updates execute atomically within one device's Durable Object.

Serialize signed requests for a key. Apple counters increase when assertions are generated. Delivering a higher counter before a lower one causes the lower one to be rejected. See [CountriesAPIClient.swift](../examples/ios/CountriesAPIClient.swift) for enrollment, canonical payload construction, and a request queue. The example disables automatic URLCache handling; add an explicit application-level offline cache and retain ETags if desired.

Handle transient Apple errors with backoff. Do not create a new key on every launch or network failure. Re-enroll after Apple reports an invalid key. If server key state has been deliberately removed, clear the stored key ID and enroll a new key. The example leaves that administrative recovery to the application.

App Attest proves possession of a key attested for the configured application. It does not prevent a legitimate installation from downloading and redistributing this public geographic information. CORS, User-Agent checks, and a shared API key cannot provide equivalent proof.
