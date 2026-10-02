import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForDeploymentHealth } from "../scripts/deployment-readiness";

await test("waits for a newly provisioned HTTPS certificate", async () => {
  let attempts = 0;
  let clock = 0;
  await waitForDeploymentHealth({
    origin: new URL("https://staging.api.saeed.sh"),
    version: "0123456789abcdef",
    timeoutMs: 100,
    pollIntervalMs: 10,
    now: () => clock,
    pause: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    report: () => undefined,
    request: () => {
      if (++attempts < 3)
        return Promise.reject(
          new TypeError("fetch failed", { cause: new Error("ssl/tls alert handshake failure") }),
        );
      return Promise.resolve(Response.json({ status: "ok", datasetVersion: "0123456789abcdef" }));
    },
  });
  assert.equal(attempts, 3);
});

await test("stops after the readiness deadline without disabling TLS", async () => {
  let clock = 0;
  let attempts = 0;
  await assert.rejects(
    waitForDeploymentHealth({
      origin: new URL("https://staging.api.saeed.sh"),
      version: "0123456789abcdef",
      timeoutMs: 30,
      pollIntervalMs: 10,
      now: () => clock,
      pause: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      report: () => undefined,
      request: (url, init) => {
        assert.equal(url.protocol, "https:");
        assert.equal(init.redirect, "error");
        attempts++;
        return Promise.reject(new TypeError("fetch failed"));
      },
    }),
    /readiness timed out/,
  );
  assert.equal(attempts, 3);
});

await test("waits for the requested dataset after an older Worker responds", async () => {
  let clock = 0;
  let attempts = 0;
  await waitForDeploymentHealth({
    origin: new URL("https://staging.api.saeed.sh"),
    version: "0123456789abcdef",
    timeoutMs: 30,
    pollIntervalMs: 10,
    now: () => clock,
    pause: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    report: () => undefined,
    request: () =>
      Promise.resolve(
        Response.json({
          status: "ok",
          datasetVersion: ++attempts === 1 ? "previous" : "0123456789abcdef",
        }),
      ),
  });
  assert.equal(attempts, 2);
});

await test("rejects authentication failures on the public health endpoint immediately", async () => {
  let attempts = 0;
  await assert.rejects(
    waitForDeploymentHealth({
      origin: new URL("https://staging.api.saeed.sh"),
      version: "0123456789abcdef",
      request: () => {
        attempts++;
        return Promise.resolve(new Response(null, { status: 401 }));
      },
    }),
    /HTTP 401/,
  );
  assert.equal(attempts, 1);
});
