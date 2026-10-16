import { defineConfig, devices } from "@playwright/test";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
const baseURL = "http://localhost:3392";
if (!["127.0.0.1", "localhost"].includes(database.hostname) || !/^\/mesapay_.*validation$/.test(database.pathname)) {
  throw new Error("Service report browser tests require an explicitly selected isolated local validation database");
}
process.env.PLAYWRIGHT_BASE_URL = baseURL;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "service-reports.spec.ts",
  outputDir: "test-results/service-reports",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: "list",
  use: { baseURL, locale: "es-CO", screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: "npx next start -H 127.0.0.1 -p 3392",
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      AUTH_SECRET: "isolated-service-report-validation-not-for-deployment",
      APP_PUBLIC_BASE_URL: baseURL,
      KUSHKI_MODE: "mock",
      NODE_OPTIONS: "--no-experimental-webstorage",
    },
  },
});
