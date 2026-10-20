import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(
  !["localhost", "127.0.0.1"].includes(database.hostname)
    || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)
    || !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""),
  "Shift regressions require an isolated local application and database",
);
const db = new PrismaClient();
const tenants: string[] = [];
test.setTimeout(90_000);

async function fixture(page: Page, locale = "es") {
  const token = randomUUID();
  const password = `Shift-${token}`;
  const restaurant = await db.restaurant.create({ data: {
    name: "Restaurante de jornadas", slug: `shift-days-${token}`, businessDayCutoffHour: 5,
  } });
  tenants.push(restaurant.id);
  const user = await db.user.create({ data: {
    restaurantId: restaurant.id, role: "operator", email: `shift-days-${token}@example.test`,
    passwordHash: await bcrypt.hash(password, 4),
  } });
  const shifts = [];
  for (const [openedAt, closedAt] of [
    ["2026-10-17T17:10:00Z", "2026-10-18T06:18:00Z"],
    ["2026-10-11T16:07:00Z", "2026-10-12T06:01:00Z"],
  ]) {
    shifts.push(await db.shift.create({ data: {
      restaurantId: restaurant.id, openedById: user.id, closedById: user.id,
      status: "closed", openedAt: new Date(openedAt), closedAt: new Date(closedAt),
      openingCashCents: 40_000_000, expectedCashCents: 40_000_000,
      declaredCashCents: 40_000_000, cashDiffCents: 0,
    } }));
  }
  await page.route(/^https?:\/\//, route =>
    ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname)
      ? route.continue() : route.abort());
  await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: locale, domain: "localhost", path: "/" }]);
  const headers = { "x-real-ip": `127.2.${parseInt(token.slice(0, 2), 16)}.${parseInt(token.slice(2, 4), 16)}` };
  await page.setExtraHTTPHeaders(headers);
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const login = await page.request.post("/api/auth/callback/credentials", {
    headers: { ...headers, "X-Auth-Return-Redirect": "1" },
    form: { csrfToken: csrf.csrfToken, email: user.email, password, callbackUrl: `${process.env.PLAYWRIGHT_BASE_URL}/operator/reports` },
  });
  expect(login.ok()).toBe(true);
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(user.id);
  return { restaurant, shifts };
}

test.afterEach(async () => {
  if (!tenants.length) return;
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.platformEvent.deleteMany({ where: { restaurantId: { in: tenants } } });
  tenants.splice(0);
});
test.afterAll(async () => db.$disconnect());

test("recent closings keep the service day and the true next-day closing time", async ({ page }, info) => {
  const { shifts } = await fixture(page);
  await page.goto("/operator/reports");
  const table = page.getByRole("table").filter({ has: page.getByRole("columnheader", { name: "Jornada", exact: true }) }).filter({ visible: true });
  await expect(table).toBeVisible();
  for (const [index, day, closed] of [
    [0, "2026-10-17", "Cerró: 2026-10-18 · 01:18"],
    [1, "2026-10-11", "Cerró: 2026-10-12 · 01:01"],
  ] as const) {
    const row = table.getByRole("row").filter({ has: page.locator(`a[href="/operator/shifts/${shifts[index].id}"]`) });
    await expect(row.locator("time").first()).toHaveText(day);
    await expect(row).toContainText(closed);
    await expect(row).toContainText("$400.000");
  }
  await table.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("recent-closings.png") });
});

test("history and printed report preserve the business day after a policy change", async ({ page }, info) => {
  const { restaurant, shifts } = await fixture(page);
  await db.restaurant.update({ where: { id: restaurant.id }, data: { businessDayCutoffHour: 15 } });
  await page.goto("/operator/shifts");
  const item = page.locator(`a[href="/operator/shifts/${shifts[0].id}"]`).filter({ visible: true });
  await expect(item).toContainText("Jornada");
  await expect(item.locator("time").first()).toHaveText("2026-10-17");
  await expect(item).toContainText("Cerró: 2026-10-18 · 01:18");
  await item.click();
  await expect(page).toHaveURL(new RegExp(`/operator/shifts/${shifts[0].id}$`));
  const report = page.locator(".shift-report").filter({ visible: true });
  await expect(report.getByText("Jornada del 2026-10-17", { exact: true })).toBeVisible();
  await expect(report).toContainText("2026-10-17 · 12:10");
  await expect(report).toContainText("2026-10-18 · 01:18");
  await expect(report).toContainText("13h 8m");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("shift-report.png"), fullPage: true });
  await page.emulateMedia({ media: "print" });
  await expect(page.getByText("Jornada del 2026-10-17", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Restaurante de jornadas", exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Imprimir", exact: true })).toBeHidden();
  const printBounds = await report.boundingBox();
  expect(printBounds?.width).toBeGreaterThan(page.viewportSize()!.width * 0.7);
  await page.screenshot({ path: info.outputPath("shift-report-print.png"), fullPage: true });
});

for (const [locale, label, dayLabel] of [
  ["en", "Business day", "Business day: 2026-10-17"],
  ["pt", "Jornada", "Jornada de 2026-10-17"],
] as const) {
  test(`business-day labels are available in ${locale}`, async ({ page }) => {
    const { shifts } = await fixture(page, locale);
    await page.goto("/operator/shifts");
    const item = page.locator(`a[href="/operator/shifts/${shifts[0].id}"]`).filter({ visible: true });
    await expect(item).toContainText(label);
    await item.click();
    await expect(page.getByText(dayLabel, { exact: true }).filter({ visible: true })).toBeVisible();
  });
}
