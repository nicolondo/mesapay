import { defineConfig, devices } from "@playwright/test";
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Browser regressions require an explicitly selected isolated local test database");
}
export default defineConfig({
  testDir: "./e2e", testMatch: "hardening.spec.ts", fullyParallel: false, workers: 1,
  reporter: "list", use: { baseURL: "http://localhost:3390", locale: "es-CO", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "npx next start -p 3390", url: "http://localhost:3390/api/health", reuseExistingServer: false,
    env: { AUTH_SECRET: "isolated-browser-test-secret-not-for-deployment", APP_PUBLIC_BASE_URL: "http://localhost:3390", KUSHKI_MODE: "mock" },
  },
});
