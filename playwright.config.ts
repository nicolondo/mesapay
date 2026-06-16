import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for MESAPAY.
 *
 * Two ways to use it:
 *
 * 1. Read-only health crawl (no server needed, safe against prod):
 *      npm run crawl                  # crawls https://mesapay.co
 *      npm run crawl -- http://localhost:3300
 *    See e2e/crawl.mjs — it does NOT submit forms or log in.
 *
 * 2. Spec-based E2E (npx playwright test). Specs live in e2e/*.spec.ts.
 *    Point them at a base URL via PLAYWRIGHT_BASE_URL. For authenticated
 *    flows, run against a LOCAL instance with a LOCAL database (never prod).
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3300",
    locale: "es-CO",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "mobile", use: { ...devices["iPhone 13"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
});
