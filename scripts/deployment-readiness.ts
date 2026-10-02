import { Schema } from "effect";

const Health = Schema.Struct({ status: Schema.Literal("ok"), datasetVersion: Schema.String });
type Options = {
  origin: URL;
  version: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  request?: (url: URL, init: RequestInit) => Promise<Response>;
  now?: () => number;
  pause?: (milliseconds: number) => Promise<void>;
  report?: (event: { attempt: number; reason: string }) => void;
};

export async function waitForDeploymentHealth(options: Options): Promise<void> {
  const request = options.request ?? fetch;
  const now = options.now ?? Date.now;
  const pause = options.pause ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const report =
    options.report ??
    ((event) =>
      console.warn(
        JSON.stringify({ event: "waiting_for_https", origin: options.origin.origin, ...event }),
      ));
  const deadline = now() + (options.timeoutMs ?? 600000);
  const interval = options.pollIntervalMs ?? 15000;
  let attempt = 0;
  let reason = "No successful health response.";
  while (now() < deadline) {
    attempt++;
    let response: Response | undefined;
    try {
      response = await request(new URL("/health", options.origin), {
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, Math.min(10000, deadline - now()))),
      });
    } catch (error) {
      reason = error instanceof Error ? error.message : "HTTPS connection failed.";
      if (error instanceof Error && error.cause instanceof Error)
        reason += `: ${error.cause.message}`;
    }
    if (response?.ok) {
      const value: unknown = await response.json();
      const health = Schema.decodeUnknownSync(Health)(value);
      if (health.datasetVersion === options.version) return;
      reason = `Waiting for dataset ${options.version}; received ${health.datasetVersion}.`;
    } else if (response) {
      reason = `Health endpoint returned HTTP ${response.status}.`;
      await response.body?.cancel();
      if (![404, 429, 500, 502, 503, 504].includes(response.status)) throw new Error(reason);
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    report({ attempt, reason });
    await pause(Math.min(interval, remaining));
  }
  throw new Error(
    `Deployment HTTPS readiness timed out for ${options.origin.origin}. Last failure: ${reason}. Check the Workers custom domain and SSL/TLS > Edge Certificates.`,
  );
}
