import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import es from "../messages/es.json";
import en from "../messages/en.json";
import pt from "../messages/pt.json";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!["localhost", "127.0.0.1"].includes(databaseUrl.hostname) || !/^\/mesapay_.*validation$/.test(databaseUrl.pathname) || !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""), "Isolated local app and validation database required");
const db = new PrismaClient();
test.setTimeout(120_000);

async function fixture() {
  const token = randomUUID(), password = `Move-${token}`;
  const restaurant = await db.restaurant.create({ data: { name: "Traslados de prueba", slug: `table-move-${token}` } });
  const passwordHash = await bcrypt.hash(password, 4);
  const admin = await db.user.create({ data: { email: `move-admin-${token}@example.test`, passwordHash, role: "operator", restaurantId: restaurant.id } });
  const waiter = await db.user.create({ data: { email: `move-waiter-${token}@example.test`, passwordHash, role: "mesero", restaurantId: restaurant.id, assignedTableNumbers: [1, 2, 3, 4] } });
  const tables = await Promise.all([1, 2, 3, 4].map((number) => db.table.create({ data: { restaurantId: restaurant.id, number, qrToken: `${token}-${number}` } })));
  const order = await db.order.create({ data: { restaurantId: restaurant.id, tableId: tables[0].id, shortCode: token, status: "placed", subtotalCents: 200000 } });
  const round = await db.round.create({ data: { orderId: order.id, seq: 1, status: "placed" } });
  const items = await Promise.all(["Arroz de prueba", "Agua de prueba"].map((nameSnapshot) => db.orderItem.create({ data: { orderId: order.id, roundId: round.id, nameSnapshot, priceCentsSnapshot: 100000, qty: 1 } })));
  return { restaurant, admin, waiter, password, tables, order, items,
    cleanup: async () => { await db.restaurant.delete({ where: { id: restaurant.id } }); await db.user.deleteMany({ where: { id: { in: [admin.id, waiter.id] } } }); } };
}

async function login(page: Page, email: string, password: string, width = 390) {
  await page.setViewportSize({ width, height: 1000 });
  await page.route(/^https?:\/\//, (route) => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.goto("/signin");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"));
}

async function policy(page: Page, value: boolean, restaurantId: string) {
  await page.goto("/operator/settings/staff-policies");
  const radio = page.locator(`input[name="adminOnlyTableMove"][value="${value ? "admin_only" : "admin_and_waiters"}"]`);
  await expect(radio).toBeVisible();
  await radio.check();
  await page.getByRole("button", { name: es.opSettings.policiesSave, exact: true }).click();
  await expect.poll(async () => (await db.restaurant.findUniqueOrThrow({ where: { id: restaurantId } })).adminOnlyTableMove).toBe(value);
  await page.reload();
  await expect(radio).toBeChecked();
}

for (const width of [390, 1440]) {
  test(`table move policy saves, protects waiter routes and preserves admin access at ${width}px`, async ({ page, browser }) => {
    const f = await fixture();
    const waiterContext = await browser.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL, locale: "es-CO" });
    try {
      await login(page, f.admin.email, f.password, width);
      await policy(page, true, f.restaurant.id);
      await page.locator('input[name="adminOnlyTableMove"][value="admin_only"]').scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ animations: "disabled", path: test.info().outputPath(`table-move-policy-${width}.png`) });
      const waiter = await waiterContext.newPage();
      await login(waiter, f.waiter.email, f.password, width);
      await waiter.goto(`/mesero/mesas?open=${f.tables[0].id}`);
      await expect(waiter.getByText(f.items[0].nameSnapshot, { exact: true })).toBeVisible();
      await expect(waiter.getByRole("button", { name: es.opTables.moveToTable, exact: true })).toHaveCount(0);
      await expect(waiter.getByRole("button", { name: es.opTables.moveItem, exact: true })).toHaveCount(0);
      await waiter.screenshot({ animations: "disabled", path: test.info().outputPath(`table-move-waiter-blocked-${width}.png`) });
      const endpoints = [`/api/operator/orders/${f.order.id}/move`, `/api/operator/order-items/${f.items[0].id}/move`];
      for (const endpoint of endpoints) {
        const response = await waiter.request.post(endpoint, { data: { targetTableId: f.tables[1].id } });
        expect(response.status()).toBe(403);
        expect(await response.json()).toMatchObject({ error: "table_move_admin_only" });
      }
      expect((await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).tableId).toBe(f.tables[0].id);
      expect((await db.orderItem.findUniqueOrThrow({ where: { id: f.items[0].id } })).orderId).toBe(f.order.id);
      expect(await db.order.count({ where: { restaurantId: f.restaurant.id } })).toBe(1);
      expect((await page.request.post(endpoints[0], { data: { targetTableId: f.tables[1].id } })).ok()).toBe(true);
      expect((await page.request.post(endpoints[1], { data: { targetTableId: f.tables[2].id } })).ok()).toBe(true);
      expect((await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).tableId).toBe(f.tables[1].id);
      const moved = await db.orderItem.findUniqueOrThrow({ where: { id: f.items[0].id }, include: { order: true } });
      expect(moved.order.tableId).toBe(f.tables[2].id);
      await policy(page, false, f.restaurant.id);
      await waiter.goto(`/mesero/mesas?open=${f.tables[1].id}`);
      await expect(waiter.getByRole("button", { name: es.opTables.moveToTable, exact: true })).toBeVisible();
      await expect(waiter.getByRole("button", { name: es.opTables.moveItem, exact: true })).toBeVisible();
      expect((await waiter.request.post(endpoints[0], { data: { targetTableId: f.tables[3].id } })).ok()).toBe(true);
      expect((await waiter.request.post(`/api/operator/order-items/${f.items[1].id}/move`, { data: { targetTableId: f.tables[0].id } })).ok()).toBe(true);
      expect((await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).tableId).toBe(f.tables[3].id);
    } finally { await waiterContext.close(); await f.cleanup(); }
  });
}

for (const kind of ["order", "item"] as const) {
  test(`a stale waiter ${kind} picker cannot bypass a newly restricted policy`, async ({ page }) => {
    const f = await fixture();
    try {
      await login(page, f.waiter.email, f.password);
      await page.goto(`/mesero/mesas?open=${f.tables[0].id}`);
      if (kind === "order") await page.getByRole("button", { name: es.opTables.moveToTable, exact: true }).click();
      else await page.getByRole("listitem").filter({ has: page.getByText(f.items[0].nameSnapshot, { exact: true }) }).getByRole("button", { name: es.opTables.moveItem, exact: true }).click();
      const title = kind === "order" ? es.opTables.movePickTitle : f.items[0].nameSnapshot;
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
      await db.restaurant.update({ where: { id: f.restaurant.id }, data: { adminOnlyTableMove: true } });
      const endpoint = kind === "order" ? `/api/operator/orders/${f.order.id}/move` : `/api/operator/order-items/${f.items[0].id}/move`;
      const rejected = page.waitForResponse((response) => response.url().endsWith(endpoint) && response.request().method() === "POST");
      await page.getByRole("button", { name: kind === "order" ? "2" : `2 ${es.opTables.moveItemTableFree}`, exact: true }).click();
      expect((await rejected).status()).toBe(403);
      await expect(page.getByText(es.opTables.moveAdminOnly, { exact: true })).toBeVisible();
      expect((await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).tableId).toBe(f.tables[0].id);
      expect((await db.orderItem.findUniqueOrThrow({ where: { id: f.items[0].id } })).orderId).toBe(f.order.id);
      expect(await db.order.count({ where: { restaurantId: f.restaurant.id } })).toBe(1);
      await page.screenshot({ animations: "disabled", path: test.info().outputPath(`table-move-stale-${kind}-390.png`) });
    } finally { await f.cleanup(); }
  });
}

test("waiter source and destination scope are reread after login", async ({ page }) => {
  const f = await fixture();
  try {
    await login(page, f.waiter.email, f.password);
    const endpoints = [`/api/operator/orders/${f.order.id}/move`, `/api/operator/order-items/${f.items[0].id}/move`];
    for (const [scope, error] of [[[2], "source_out_of_scope"], [[1], "target_out_of_scope"]] as const) {
      await db.user.update({ where: { id: f.waiter.id }, data: { assignedTableNumbers: [...scope] } });
      for (const endpoint of endpoints) {
        const response = await page.request.post(endpoint, { data: { targetTableId: f.tables[1].id } });
        expect(response.status()).toBe(403);
        expect(await response.json()).toMatchObject({ error });
      }
    }
    expect((await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).tableId).toBe(f.tables[0].id);
    expect((await db.orderItem.findUniqueOrThrow({ where: { id: f.items[0].id } })).orderId).toBe(f.order.id);
    expect(await db.order.count({ where: { restaurantId: f.restaurant.id } })).toBe(1);
  } finally { await f.cleanup(); }
});

for (const [locale, catalog] of [["en", en], ["pt", pt]] as const) {
  test(`table move policy is translated in ${locale}`, async ({ page }) => {
    const f = await fixture();
    try {
      await login(page, f.admin.email, f.password);
      await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: locale, domain: "localhost", path: "/" }]);
      await page.goto("/operator/settings/staff-policies");
      await expect(page.getByRole("heading", { name: catalog.opSettings.policiesTableMoveQuestion, exact: true })).toBeVisible();
      await expect(page.getByText(catalog.opSettings.policiesTableMoveAdminTitle, { exact: true })).toBeVisible();
      await expect(page.getByText(catalog.opSettings.policiesTableMoveWaitersTitle, { exact: true })).toBeVisible();
      await expect(page.locator('input[name="adminOnlyTableMove"][value="admin_and_waiters"]')).toBeChecked();
    } finally { await f.cleanup(); }
  });
}

test("policy can be saved in both directions without reload and retried after network failure", async ({ page }) => {
  const f = await fixture();
  try {
    await login(page, f.admin.email, f.password);
    await page.goto("/operator/settings/staff-policies");
    const restricted = page.locator('input[name="adminOnlyTableMove"][value="admin_only"]');
    const shared = page.locator('input[name="adminOnlyTableMove"][value="admin_and_waiters"]');
    const save = page.getByRole("button", { name: es.opSettings.policiesSave, exact: true });
    for (const value of [true, false]) {
      await (value ? restricted : shared).check();
      await expect(save).toBeEnabled();
      await save.click();
      await expect.poll(async () => (await db.restaurant.findUniqueOrThrow({ where: { id: f.restaurant.id } })).adminOnlyTableMove).toBe(value);
      await expect(save).toBeDisabled();
    }
    await restricted.check();
    const endpoint = "**/api/operator/settings/staff-policies";
    await page.route(endpoint, (route) => route.request().method() === "PUT" ? route.abort("failed") : route.continue());
    await save.click();
    await expect(page.getByText(es.opSettings.policiesSaveFailed, { exact: true })).toBeVisible();
    await expect(save).toBeEnabled();
    expect((await db.restaurant.findUniqueOrThrow({ where: { id: f.restaurant.id } })).adminOnlyTableMove).toBe(false);
    await page.unroute(endpoint);
    await save.click();
    await expect.poll(async () => (await db.restaurant.findUniqueOrThrow({ where: { id: f.restaurant.id } })).adminOnlyTableMove).toBe(true);
    await expect(save).toBeDisabled();
  } finally { await f.cleanup(); }
});

test.afterAll(() => db.$disconnect());
