import { test, expect, type Page } from "@playwright/test";

/**
 * Authenticated operator smoke test.
 *
 * SAFETY: this logs in and must NEVER run against production. It auto-skips
 * unless PLAYWRIGHT_BASE_URL points at localhost. Run it against a LOCAL
 * instance backed by a LOCAL database seeded with `npm run db:seed`
 * (fixture accounts use password `mesapay123`):
 *
 *   # 1. start the app against a LOCAL db (override the prod URL in .env.local)
 *   DATABASE_URL=postgresql://localhost:5433/mesapay npm run dev
 *   # 2. in another shell:
 *   PLAYWRIGHT_BASE_URL=http://localhost:3300 npx playwright test operator-smoke
 *
 * It verifies the operator panel renders without console errors AND that the
 * top bar stays visible after scrolling (regression guard for the iOS
 * app-shell fix in src/app/operator/layout.tsx).
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3300";
const IS_LOCAL = /localhost|127\.0\.0\.1/.test(BASE);

const EMAIL = process.env.E2E_EMAIL || "mesero@casateresita.co"; // seed: role=operator
const PASSWORD = process.env.E2E_PASSWORD || "mesapay123";

const OPERATOR_PAGES = [
  "/operator",
  "/operator/menu",
  "/operator/menus",
  "/operator/kitchen",
  "/operator/serve",
  "/operator/payments",
  "/operator/orders",
  "/operator/tables",
  "/operator/reservas",
  "/operator/facturas",
  "/operator/reports",
  "/operator/settings",
];

test.describe("operator (authenticated)", () => {
  test.skip(!IS_LOCAL, "authenticated E2E only runs against a LOCAL base URL (never prod)");

  test.beforeEach(async ({ page }) => {
    await page.goto("/signin");
    await page.locator('input[type="email"]').fill(EMAIL);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await Promise.all([
      page.waitForURL((u) => !/\/signin/.test(u.pathname), { timeout: 15_000 }),
      page.locator('button[type="submit"], button:has-text("Entrar"), button:has-text("Ingresar")').first().click(),
    ]);
  });

  for (const path of OPERATOR_PAGES) {
    test(`${path} renders without console errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      page.on("pageerror", (e) => errors.push(String(e.message)));

      const resp = await page.goto(path, { waitUntil: "domcontentloaded" });
      expect(resp?.status(), `${path} HTTP status`).toBeLessThan(400);
      await page.waitForTimeout(1500);

      const body = await page.evaluate(() => document.body?.innerText || "");
      expect(body, "no client crash").not.toMatch(/Application error|client-side exception/i);

      const real = errors.filter((e) => !/favicon|web-vitals|ResizeObserver loop/i.test(e));
      expect(real, `console errors on ${path}:\n${real.join("\n")}`).toHaveLength(0);
    });
  }

  test("header stays visible after scrolling (app-shell regression guard)", async ({ page }) => {
    await page.goto("/operator/menu", { waitUntil: "domcontentloaded" });
    const header = page.locator("header").first();
    await expect(header).toBeVisible();
    // The operator shell scrolls <main>, not the window.
    await scrollMainToBottom(page);
    await page.waitForTimeout(400);
    await expect(header, "top bar must remain visible after scroll").toBeVisible();
  });
});

async function scrollMainToBottom(page: Page) {
  await page.evaluate(() => {
    const main = document.querySelector("main");
    if (main) main.scrollTop = main.scrollHeight;
    else window.scrollTo(0, document.body.scrollHeight);
  });
}
