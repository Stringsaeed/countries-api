# Android request authentication

Release builds use Google Play Integrity standard requests. Debug builds use the local API's bearer token. Both staging and production require Play-recognized release builds for Android access.

## Activation still required

As of October 20, 2026, the user reports that Play Integrity is linked for `sh.saeed.azkarify` and has supplied Google Cloud project number `97729473680`. Use this numeric project number in the Android release app. The certificate, service account, deployed Worker settings, and authenticated device requests still need live verification. The Android app's offline city fallback can remain available until a real authenticated catalog request succeeds.

GitHub environment settings were checked on October 20, 2026. Both `staging` and `production` now have `ANDROID_PACKAGE_NAME=sh.saeed.azkarify`, `ANDROID_CERTIFICATE_SHA256=UzMce-9lr4LWICl7IWHsJIaRLOgzr7UQXf6P8hoMdjY`, and a secret named `GOOGLE_SERVICE_ACCOUNT_JSON`. The certificate value has the required unpadded base64url format. Its match to the installed Play app has not been verified. GitHub exposes the secret's presence, not its contents; service-account validity still needs a live verification request. Updating these settings does not redeploy an existing Worker.

The configuration values and remaining activation steps are:

| Setting or step                            | Where it belongs                                        | Remaining work                                                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Numeric Google Cloud project number        | Android release app configuration                       | Use `97729473680L` with `setCloudProjectNumber`. Linking is reported complete; a live app request remains unverified. The Worker does not need this number.                   |
| `GOOGLE_SERVICE_ACCOUNT_JSON`              | GitHub `staging` and `production` environment secrets   | Secret presence verified in both environments. Verify the credentials and linked-project authorization through a live authenticated request after deployment.                 |
| `ANDROID_CERTIFICATE_SHA256`               | GitHub `staging` and `production` environment variables | Configured in both environments with valid encoding. Verify it matches the Play app-signing certificate through a live authenticated request.                                 |
| `ANDROID_PACKAGE_NAME`                     | GitHub `staging` and `production` environment variables | Configured and verified as `sh.saeed.azkarify` in both environments and repository defaults.                                                                                  |
| Staging deployment and device verification | Countries API workflow and a physical Android device    | Deploy the updated server with the settings above, install a release build through a Play testing track, and verify authenticated country listing and city search on staging. |
| Production promotion                       | Countries API production workflow                       | Promote the exact tested staging release with production credentials/settings, then verify an authenticated request against the production origin.                            |

The workflows use GitHub environment settings during deployment; changing `.env.example` alone does not configure a deployed Worker. Local tests mock Google OAuth and token-decoding responses while running the Worker, replay protection, and catalog storage in local Workers emulation. A successful dry-run build does not deploy the server. A successful `/health` response does not prove Play authentication.

## Configure Google Play and the Worker

1. Use the reported linked Google Cloud project number `97729473680` for the Play Console app with package `sh.saeed.azkarify`. Confirm Play Integrity is enabled in that project when verifying the setup live. This number is public configuration and does not replace the service-account credentials or app-signing certificate digest.
2. Publish a release to a Play testing track and install it through Google Play with an entitled tester account.
3. Create a service account in the linked project. Save its JSON credentials as the `GOOGLE_SERVICE_ACCOUNT_JSON` GitHub environment secret for each API environment that should accept Android. Never embed the credentials in the app or commit them.
4. Set the GitHub environment variable `ANDROID_PACKAGE_NAME` to `sh.saeed.azkarify`.
5. Obtain the SHA-256 fingerprint of the app-signing certificate in Play Console, convert the hexadecimal bytes to unpadded base64url, and set `ANDROID_CERTIFICATE_SHA256`. Use the certificate that signs the installed Play app. For key rotation, supply a comma-separated allowlist of accepted certificates.
6. Deploy through the existing workflow. Android remains disabled when the certificate and service account are absent. Partial or invalid configuration fails deployment validation.

Convert a colon-separated SHA-256 fingerprint locally:

```sh
node --input-type=module -e 'console.log(Buffer.from(process.argv[1].replaceAll(":", ""), "hex").toString("base64url"))' 'PASTE_SHA256_FINGERPRINT'
```

The same deployment settings are in `.env.example`. Each environment may use a separate linked Cloud project. The project number is an app configuration value; the Worker uses service-account credentials to obtain its Google access token.

## Send a catalog request

Add `implementation("com.google.android.play:integrity:1.6.0")` to the Android dependencies. Prepare a standard token provider with `setCloudProjectNumber(97729473680L)` and retain it for reuse. The Kotlin `L` suffix is required because the project number exceeds the `Int` range. Prepare another provider when it expires.

For every catalog request, join these five UTF-8 fields with LF bytes. Do not append an extra newline after joining:

```text
countries-api:android:v1
GET
<complete HTTPS URL, including the encoded query>
<Accept-Language header, or an empty string>
<If-None-Match header, or an empty string>
```

Hash the payload with SHA-256 and encode the digest as unpadded base64url. Pass it to `StandardIntegrityTokenRequest.builder().setRequestHash(requestHash).build()`. Send the resulting token in `X-Play-Integrity-Token` with the catalog request.

Preserve empty final fields when joining the lines. An empty ETag field means the joined payload ends with the separator before that field. For `GET https://api.example.com/v1/countries.json?lang=en` with `Accept-Language: en` and no ETag, the expected request hash is `qiMLNzO9e1_BHYxHtLy42Hk2R1Eyku5kndgTj5uXaac`.

The URL and headers must match the transmitted request. Use the final HTTPS origin directly; redirects change the bound URL. Country and city responses and pagination are identical to iOS. Android does not use the iOS enrollment endpoints.

The Worker requires matching request and app packages, request hash, an allowed signing certificate, `PLAY_RECOGNIZED`, `LICENSED`, and `MEETS_DEVICE_INTEGRITY`. Tokens must be no older than 120 seconds and cannot have a future timestamp. Each token is consumed on its first verification attempt, including provider failures. Obtain a fresh token for retries and conditional requests. Failed proof returns `401`; Google authentication outages return `503`.

Play Integrity does not expose a stable device identifier. Android uses IP rate limits; iOS also has an attested-key limit. Do not treat a client-supplied device ID as a trusted identity.

Every Android catalog request requires a Google token decode before the API cache lookup. Google's default server-decryption quota is 10,000 per day per Cloud project. Cache downloaded pages in the app, monitor quota, and request an increase before exceeding it. A legitimate installation can still redistribute downloaded data.

## Debug against the local API

Set a random `DEV_AUTH_TOKEN` in `.dev.vars` and run `npm run dev`. Connect an emulator or USB device with:

```sh
adb reverse tcp:8787 tcp:8787
```

Use `http://127.0.0.1:8787/v1` in the debug app and send `Authorization: Bearer <local token>`. Enable HTTP cleartext only in the debug Android manifest. Keep the token and HTTP origin out of release builds. Reverse forwarding preserves the loopback hostname required by the local-token check. The host alias `10.0.2.2` does not meet that check.

References: [Google setup](https://developer.android.com/google/play/integrity/setup), [standard requests](https://developer.android.com/google/play/integrity/standard), [verdicts](https://developer.android.com/google/play/integrity/verdicts), and [service-account authentication](https://developers.google.com/identity/protocols/oauth2/service-account).
