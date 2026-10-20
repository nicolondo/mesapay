import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { bogotaBusinessTodayIso, bogotaDayRange } from "../src/lib/bogota";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(
  !["localhost", "127.0.0.1"].includes(database.hostname)
    || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)
    || !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""),
  "Dashboard regressions require an isolated local application and database",
);
const db = new PrismaClient();
const tenants: string[] = [];
test.setTimeout(90_000);

async function fixture(page: Page, locale = "es") {
  const token = randomUUID();
  const password = `Sales-${token}`;
  const restaurant = await db.restaurant.create({ data: {
    name: "Restaurante de ventas", slug: `net-sales-${token}`, businessDayCutoffHour: 5,
    salesTaxKind: "inc", salesTaxPct: 8,
  } });
  tenants.push(restaurant.id);
  const user = await db.user.create({ data: {
    restaurantId: restaurant.id, role: "operator", email: `net-sales-${token}@example.test`,
    passwordHash: await bcrypt.hash(password, 4),
  } });
  const table = await db.table.create({ data: { restaurantId: restaurant.id, number: 1, qrToken: token } });
  const today = bogotaDayRange(bogotaBusinessTodayIso(5), 5).start;
  const yesterday = new Date(today.getTime() - 86400000);
  const order = await db.order.create({ data: {
    restaurantId: restaurant.id, tableId: table.id, shortCode: randomUUID(), status: "paid",
    createdAt: yesterday, paidAt: new Date(today.getTime() + 3600000),
    subtotalCents: 158_000_00, taxCents: 9_500_00, tipCents: 15_000_00,
    discountCents: 10_000_00, totalCents: 172_500_00,
  } });
  await db.simpleInvoice.create({ data: {
    restaurantId: restaurant.id, orderId: order.id, invoiceNumber: 1, totalCents: order.totalCents,
    snapshot: { salesTaxKind: "inc", salesTaxPct: 8, embeddedTaxCents: 8_000_00, embeddedBaseCents: 100_000_00 },
  } });
  await db.order.create({ data: {
    restaurantId: restaurant.id, tableId: table.id, shortCode: randomUUID(), status: "paid",
    paidAt: new Date(today.getTime() + 7200000), subtotalCents: 54_000_00, tipCents: 5_000_00, totalCents: 59_000_00,
    items: { create: { nameSnapshot: "Plato", qty: 1, priceCentsSnapshot: 54_000_00 } },
  } });
  for (const invoiceNumber of [2, 3]) {
    const previous = await db.order.create({ data: {
      restaurantId: restaurant.id, tableId: table.id, shortCode: randomUUID(), status: "paid",
      paidAt: new Date(today.getTime() - 1), subtotalCents: 10_800_000_00,
      tipCents: 1_080_000_00, totalCents: 11_880_000_00,
    } });
    await db.simpleInvoice.create({ data: {
      restaurantId: restaurant.id, orderId: previous.id, invoiceNumber, totalCents: previous.totalCents,
      snapshot: { salesTaxKind: "inc", salesTaxPct: 8, embeddedTaxCents: 800_000_00, embeddedBaseCents: 10_000_000_00 },
    } });
  }
  await page.route(/^https?:\/\//, route =>
    ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: locale, domain: "localhost", path: "/" }]);
  const headers = { "x-real-ip": `127.3.${parseInt(token.slice(0, 2), 16)}.${parseInt(token.slice(2, 4), 16)}` };
  await page.setExtraHTTPHeaders(headers);
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const login = await page.request.post("/api/auth/callback/credentials", {
    headers: { ...headers, "X-Auth-Return-Redirect": "1" },
    form: { csrfToken: csrf.csrfToken, email: user.email, password, callbackUrl: `${process.env.PLAYWRIGHT_BASE_URL}/operator` },
  });
  expect(login.ok()).toBe(true);
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(user.id);
  return { today, yesterday };
}

test.afterEach(async () => {
  if (!tenants.length) return;
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.platformEvent.deleteMany({ where: { restaurantId: { in: tenants } } });
  tenants.splice(0);
});
test.afterAll(async () => db.$disconnect());

test("sales chart, daily detail and KPIs exclude both taxes and tips", async ({ page }, info) => {
  await fixture(page);
  const response = await page.goto("/operator");
  expect(response?.status()).toBe(200);
  const sales = page.locator(".mp-panel").filter({ has: page.locator("#sales-title") });
  // Before the fix the dashboard counted $23.991.500, including tips and taxes.
  await expect(sales.locator(".mp-panel-heading")).toContainText("$20.190.000");
  await expect(sales.getByRole("heading")).toHaveText("Ventas sin impuestos ni propina");
  await expect(sales).toContainText("Últimos 7 días");
  await expect(sales.getByRole("table")).toBeVisible();
  const amounts = await sales.locator("tbody td").allTextContents();
  expect(amounts).toEqual(["$0", "$0", "$0", "$0", "$0", "$20.000.000", "$190.000"]);
  const today = page.locator(".mp-kpi").filter({ hasText: "Ventas hoy" });
  await expect(today).toContainText("$190.000");
  await expect(today).toContainText("Sin impuestos ni propina");
  const ticket = page.locator(".mp-kpi").filter({ hasText: "Ticket promedio" });
  await expect(ticket).toContainText("$95.000");
  await expect(ticket).toContainText("Sin impuestos ni propina");
  const count = page.locator(".mp-kpi").filter({ hasText: "Órdenes pagadas" });
  await expect(count.locator(".mp-kpi-value")).toHaveText("2");
  await sales.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const valuesFit = await sales.locator(".mp-sales-value").evaluateAll(elements => elements.every(el => {
    if (getComputedStyle(el).display === "none") return true;
    return el.scrollWidth <= el.clientWidth;
  }));
  expect(valuesFit).toBe(true);
  await sales.screenshot({ path: info.outputPath("net-sales-chart.png") });
  await page.locator(".mp-kpis").screenshot({ path: info.outputPath("net-sales-kpis.png") });
});

for (const [locale, title, hint] of [
  ["en", "Sales excluding taxes and tips", "Excluding taxes and tips"],
  ["pt", "Vendas sem impostos nem gorjeta", "Sem impostos nem gorjeta"],
] as const) {
  test(`the net sales basis is explicit in ${locale}`, async ({ page }) => {
    await fixture(page, locale);
    await page.goto("/operator");
    await expect(page.locator("#sales-title")).toHaveText(title);
    await expect(page.locator(".mp-kpi").first()).toContainText(hint);
    await expect(page.locator(".mp-chart-details table")).toBeVisible();
  });
}
