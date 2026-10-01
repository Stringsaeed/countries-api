import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        compatibilityDate: "2026-08-15",
        bindings: {
          ENVIRONMENT: "local",
          APPLE_APP_ID_PREFIX: "V8H6LQ9448",
          APPLE_BUNDLE_ID: "io.uebelacker.AppAttestExample",
          DATASET_VERSION: "0123456789abcdef",
          DEV_AUTH_TOKEN: "local-test-token",
        },
      },
    }),
  ],
  test: { include: ["tests/**/*.test.ts"], testTimeout: 15000, fileParallelism: false },
});
