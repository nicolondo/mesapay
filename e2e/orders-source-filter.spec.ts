import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

const application = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3411");
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!["localhost", "127.0.0.1"].includes(application.hostname) || !["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname), "Source filters require isolated local services");
test.setTimeout(90_000); test.use({ actionTimeout: 15_000, navigationTimeout: 60_000 });
const db = new PrismaClient(); const tenantIds = new Set<string>();
async function fixture(page: Page) {
  const uid = randomUUID(); const errors: string[] = [];
  page.on("pageerror", error => {
    // WebKit labels cancelled background requests during Back/Reload as CORS
    // errors. Keep application/hydration exceptions, excluding only these
    // known local background paths; none are required by this filter feature.
    const cancelledBackground = error.message.endsWith(" due to access control checks.")
      && /\/(?:api\/(?:version|auth\/session|tenant\/orders-source-e2e-[^/]+\/events)|__nextjs_original-stack-frames) due/.test(error.message);
    if (!cancelledBackground) errors.push(error.message);
  });
  const headers = { "x-real-ip": `127.4.${parseInt(uid.slice(0, 2), 16)}.${parseInt(uid.slice(2, 4), 16)}` }; await page.setExtraHTTPHeaders(headers);
  await page.route(/^https?:\/\//, route => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  const tenant = await db.restaurant.create({ data: { name: "Prueba filtros de órdenes", slug: `orders-source-e2e-${uid}`, country: "CO", businessDayCutoffHour: 5 } }); tenantIds.add(tenant.id);
  const user = await db.user.create({ data: { restaurantId: tenant.id, email: `orders-source-${uid}@example.test`, role: "operator", passwordHash: await bcrypt.hash(uid, 4) } });
  const table1 = await db.table.create({ data: { restaurantId: tenant.id, number: 1, kind: "standard", label: "Terraza", qrToken: randomUUID() } });
  const table2 = await db.table.create({ data: { restaurantId: tenant.id, number: 2, kind: "standard", qrToken: randomUUID() } });
  const manual = await db.table.create({ data: { restaurantId: tenant.id, number: -100, kind: "manual", qrToken: randomUUID() } });
  const pickup = await db.table.create({ data: { restaurantId: tenant.id, number: -1, kind: "pickup", qrToken: randomUUID() } });
  const orders = [];
  for (const [index, table] of [table1, table2, manual, pickup].entries()) orders.push(await db.order.create({ data: { restaurantId: tenant.id, tableId: table.id, shortCode: `SOURCE-${uid}-${index}`, status: "paid", totalCents: (index + 1) * 10000, createdAt: new Date("2026-11-09T18:00:00Z"), paidAt: new Date("2026-11-09T19:00:00Z") } }));
  await db.simpleInvoice.create({ data: { restaurantId: tenant.id, orderId: orders[2].id, invoiceNumber: 7788, totalCents: 30000, snapshot: { invoicePrefix: "SYN" } } });
  await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: "es", domain: application.hostname, path: "/" }]);
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const login = await page.request.post("/api/auth/callback/credentials", { headers: { ...headers, "X-Auth-Return-Redirect": "1" }, form: { csrfToken: csrf.csrfToken, email: user.email, password: uid, callbackUrl: `${application.origin}/operator/orders` } }); expect(login.ok()).toBe(true);
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(user.id);
  await page.goto("/operator/orders?desde=2026-11-09&hasta=2026-11-09&status=paid");
  return { table1, table2, orders, errors };
}
const sourceGroup = (page: Page) => page.getByRole("group", { name: "Tipo de cuenta", exact: true });
const orderLink = (page: Page, id: string) => page.locator(`a[href="/operator/orders/${id}"]`).filter({ visible: true });
test.afterEach(async () => { for (const restaurantId of tenantIds) { await db.order.deleteMany({ where: { restaurantId } }); await db.user.deleteMany({ where: { restaurantId } }); await db.restaurant.delete({ where: { id: restaurantId } }); tenantIds.delete(restaurantId); } });
test.afterAll(() => db.$disconnect());

test("filters tables and manual invoices, selecting one table without losing existing filters", async ({ page }, info) => {
  const f = await fixture(page);
  for (const order of f.orders) await expect(orderLink(page, order.id)).toBeVisible();
  await sourceGroup(page).getByRole("link", { name: "Mesas", exact: true }).click();
  await expect(orderLink(page, f.orders[0].id)).toBeVisible(); await expect(orderLink(page, f.orders[1].id)).toBeVisible(); await expect(orderLink(page, f.orders[2].id)).toHaveCount(0); await expect(orderLink(page, f.orders[3].id)).toHaveCount(0);
  await page.getByLabel("Mesa", { exact: true }).selectOption(f.table1.id);
  await expect(orderLink(page, f.orders[1].id)).toHaveCount(0);
  const params = new URL(page.url()).searchParams; expect(params.get("desde")).toBe("2026-11-09"); expect(params.get("status")).toBe("paid"); expect(params.get("tableId")).toBe(f.table1.id);
  await page.screenshot({ path: info.outputPath("orders-table-filter.png"), animations: "disabled" });
  await sourceGroup(page).getByRole("link", { name: "Facturas manuales", exact: true }).click();
  await expect(orderLink(page, f.orders[2].id)).toBeVisible(); await expect(orderLink(page, f.orders[0].id)).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("tableId")).toBeNull();
  await page.goBack(); await expect(page.getByLabel("Mesa", { exact: true })).toHaveValue(f.table1.id);
  await page.reload(); await expect(page.getByLabel("Mesa", { exact: true })).toHaveValue(f.table1.id);
  await expect(sourceGroup(page).getByRole("link", { name: "Mesas", exact: true })).toHaveAttribute("aria-current", "true");
  expect(f.errors).toEqual([]);
});

test("invoice search obeys source, and empty results offer clearing type and table", async ({ page }) => {
  const f = await fixture(page);
  await sourceGroup(page).getByRole("link", { name: "Mesas", exact: true }).click();
  await expect(sourceGroup(page).getByRole("link", { name: "Mesas", exact: true })).toHaveAttribute("aria-current", "true");
  const search = page.getByRole("search").filter({ has: page.locator('input[name="q"]') }); await search.locator('input[name="q"]').fill("SYN7788"); await search.getByRole("button", { name: "Buscar", exact: true }).click();
  await expect(orderLink(page, f.orders[2].id)).toHaveCount(0);
  await page.getByRole("link", { name: "Quitar filtro de tipo y mesa", exact: true }).click();
  await expect(orderLink(page, f.orders[2].id)).toBeVisible(); expect(new URL(page.url()).searchParams.get("q")).toBe("SYN7788");
  await sourceGroup(page).getByRole("link", { name: "Mesas", exact: true }).click();
  await expect(sourceGroup(page).getByRole("link", { name: "Mesas", exact: true })).toHaveAttribute("aria-current", "true");
  await search.locator('input[name="q"]').fill("SOURCE"); await search.getByRole("button", { name: "Buscar", exact: true }).click();
  await expect(orderLink(page, f.orders[0].id)).toBeVisible(); expect(new URL(page.url()).searchParams.get("source")).toBe("tables");
  expect(f.errors).toEqual([]);
});

test("unknown table fails closed and filters remain usable in all three languages", async ({ page }, info) => {
  const f = await fixture(page);
  await page.goto("/operator/orders?desde=2026-11-09&hasta=2026-11-09&source=tables&tableId=missing-table&fechas=todas");
  await expect(page.getByLabel("Mesa", { exact: true })).toHaveValue("missing-table");
  await expect(page.getByRole("option", { name: "Mesa no disponible", exact: true })).toHaveCount(1);
  for (const order of f.orders) await expect(orderLink(page, order.id)).toHaveCount(0);
  await page.getByLabel("Mesa", { exact: true }).selectOption(f.table2.id); await expect(orderLink(page, f.orders[1].id)).toBeVisible();
  expect(new URL(page.url()).searchParams.get("fechas")).toBe("todas");
  for (const [locale, label] of [["en", "Account type"], ["pt", "Tipo de conta"], ["es", "Tipo de cuenta"]]) {
    await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: locale, domain: application.hostname, path: "/" }]); await page.reload();
    await expect(page.getByRole("group", { name: label, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  }
  await page.screenshot({ path: info.outputPath("orders-source-filter-mobile.png"), animations: "disabled" });
  expect(f.errors).toEqual([]);
});
