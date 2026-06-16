import { test, expect, type Page } from "@playwright/test";

/**
 * Authenticated smoke tests (operator + admin).
 *
 * SAFETY: these log in and must NEVER run against production. They auto-skip
 * unless PLAYWRIGHT_BASE_URL points at localhost. Run against a LOCAL instance
 * backed by a LOCAL database seeded with `npm run db:seed` (fixture accounts use
 * password `mesapay123`). One-time local DB (throwaway Docker Postgres):
 *
 *   docker run -d --name mesapay-e2e -e POSTGRES_USER=mesapay \
 *     -e POSTGRES_PASSWORD=mesapay -e POSTGRES_DB=mesapay -p 5544:5432 postgres:16-alpine
 *   DB=postgresql://mesapay:mesapay@127.0.0.1:5544/mesapay
 *   DATABASE_URL=$DB DIRECT_URL=$DB npx prisma db push && DATABASE_URL=$DB npm run db:seed
 *   DATABASE_URL=$DB DIRECT_URL=$DB KUSHKI_MODE=mock npm run dev   # app on :3300
 *   PLAYWRIGHT_BASE_URL=http://localhost:3300 npx playwright test   # in another shell
 *
 * The `mobile` project uses WebKit = the iOS Safari engine, so it also guards
 * the iOS app-shell fix (header stays visible after scroll) in the real engine.
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3300";
const IS_LOCAL = /localhost|127\.0\.0\.1/.test(BASE);

// Console noise that is NOT a real bug. The /api/version "access control"
// message only appears on the Next dev server under WebKit over http://localhost
// (Turbopack HMR artifact) — confirmed ABSENT on prod HTTPS, so we ignore it.
const NOISE = /favicon|web-vitals|ResizeObserver loop|\/api\/version|access control checks|Download the React DevTools|\[Fast Refresh\]/i;

async function login(page: Page, email: string, password: string) {
  await page.goto("/signin", { waitUntil: "domcontentloaded" });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await Promise.all([
    // dev cold-compile of /api/auth can be slow on first hit → generous timeout
    page.waitForURL((u) => !/\/signin/.test(u.pathname), { timeout: 45_000 }),
    page.locator('button[type="submit"]').first().click(),
  ]);
}

function assertNoConsoleErrors(path: string, errors: string[]) {
  const real = errors.filter((e) => !NOISE.test(e));
  expect(real, `console errors on ${path}:\n${real.join("\n")}`).toHaveLength(0);
}

async function visit(page: Page, path: string) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(`PAGEERROR ${e.message}`));
  const resp = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(resp?.status(), `${path} HTTP status`).toBeLessThan(400);
  await page.waitForTimeout(1500);
  const body = await page.evaluate(() => document.body?.innerText || "");
  expect(body, "no client crash").not.toMatch(/Application error|client-side exception/i);
  assertNoConsoleErrors(path, errors);
}

// WebKit refuses to persist the NextAuth session cookie over http://localhost
// (it treats `Secure` cookies strictly; Chromium special-cases localhost). So
// authenticated WebKit runs need HTTPS — skip them over plain http rather than
// fail. Prod (https) is unaffected. The diner/public WebKit crawl still runs.
function skipWebkitHttpAuth(browserName: string) {
  test.skip(
    browserName === "webkit" && BASE.startsWith("http://"),
    "WebKit won't keep the auth cookie over http://localhost — run authed WebKit against https",
  );
}

test.describe("operator (authenticated)", () => {
  test.skip(!IS_LOCAL, "authenticated E2E only runs against a LOCAL base URL (never prod)");
  test.beforeEach(async ({ page, browserName }) => {
    skipWebkitHttpAuth(browserName);
    await login(page, process.env.E2E_EMAIL || "mesero@casateresita.co", process.env.E2E_PASSWORD || "mesapay123");
  });

  const PAGES = [
    "/operator", "/operator/menu", "/operator/menus", "/operator/kitchen",
    "/operator/serve", "/operator/payments", "/operator/orders", "/operator/tables",
    "/operator/reservas", "/operator/facturas", "/operator/reports", "/operator/settings",
  ];
  for (const path of PAGES) {
    test(`${path} renders without console errors`, async ({ page }) => visit(page, path));
  }

  test("header stays visible after scrolling (app-shell regression guard)", async ({ page }) => {
    await page.goto("/operator/menu", { waitUntil: "domcontentloaded" });
    const header = page.locator("header").first();
    await expect(header).toBeVisible();
    await page.evaluate(() => {
      const main = document.querySelector("main");
      if (main) main.scrollTop = main.scrollHeight;
      else window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(400);
    await expect(header, "top bar must remain visible after scroll").toBeVisible();
  });
});

test.describe("admin (authenticated)", () => {
  test.skip(!IS_LOCAL, "authenticated E2E only runs against a LOCAL base URL (never prod)");
  test.beforeEach(async ({ page, browserName }) => {
    skipWebkitHttpAuth(browserName);
    await login(page, "admin@mesapay.co", "mesapay123");
  });

  const PAGES = [
    "/admin", "/admin/restaurants", "/admin/restaurants/new", "/admin/groups",
    "/admin/plans", "/admin/audit", "/admin/comisiones", "/admin/configuracion",
  ];
  for (const path of PAGES) {
    test(`${path} renders without console errors`, async ({ page }) => visit(page, path));
  }
});
