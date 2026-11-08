import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

const application = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3411");
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!["localhost", "127.0.0.1"].includes(application.hostname)
  || !["localhost", "127.0.0.1"].includes(database.hostname)
  || !/^\/mesapay_.*validation$/.test(database.pathname), "Bar regression requires isolated local services");
test.setTimeout(90_000);
test.use({ actionTimeout: 15_000, navigationTimeout: 60_000 });
const db = new PrismaClient();
const tenants = new Set<string>();

async function fixture(page: Page) {
  const uid = randomUUID();
  const restaurant = await db.restaurant.create({ data: {
    name: "Bar bulk serve validation", slug: `bar-serve-${uid}`, hasBar: true,
    barSubStations: ["Cocteles", "Cafetería"], barAutoFire: false, kitchenAutoFire: false,
    barPrintEnabled: false, kitchenPrintEnabled: false,
  } });
  tenants.add(restaurant.id);
  const foreign = await db.restaurant.create({ data: { name: "Other bar fixture", slug: `bar-other-${uid}` } });
  tenants.add(foreign.id);
  const user = await db.user.create({ data: {
    restaurantId: restaurant.id, email: `bar-serve-${uid}@example.test`, name: "Bar fixture user",
    role: "bar", passwordHash: await bcrypt.hash(uid, 4),
  } });
  const table = await db.table.create({ data: { restaurantId: restaurant.id, number: 1, qrToken: randomUUID() } });
  const otherTable = await db.table.create({ data: { restaurantId: foreign.id, number: 1, qrToken: randomUUID() } });
  const order = await db.order.create({ data: { restaurantId: restaurant.id, tableId: table.id, shortCode: `BAR-${uid}`, status: "ready" } });
  const otherOrder = await db.order.create({ data: { restaurantId: foreign.id, tableId: otherTable.id, shortCode: `OTHER-${uid}`, status: "ready" } });
  const round = await db.round.create({ data: { orderId: order.id, seq: 1, status: "ready" } });
  const otherRound = await db.round.create({ data: { orderId: otherOrder.id, seq: 1, status: "ready" } });
  const category = await db.category.create({ data: { restaurantId: restaurant.id, label: "Cocteles fixture", slug: "cocteles", barSubStation: "Cocteles" } });
  const cafeCategory = await db.category.create({ data: { restaurantId: restaurant.id, label: "Cafetería fixture", slug: "cafe", barSubStation: "Cafetería" } });
  const menuItem = await db.menuItem.create({ data: { restaurantId: restaurant.id, categoryId: category.id, name: "Cóctel fixture", priceCents: 100_000, prepStation: "bar" } });
  const cafe = await db.menuItem.create({ data: { restaurantId: restaurant.id, categoryId: cafeCategory.id, name: "Café fixture", priceCents: 100_000, prepStation: "bar" } });
  const base = { orderId: order.id, roundId: round.id, menuItemId: menuItem.id, qty: 1, priceCentsSnapshot: 100_000, station: "bar" as const, kitchenStatus: "ready" as const };
  const first = await db.orderItem.create({ data: { ...base, nameSnapshot: "Cóctel pendiente uno" } });
  const second = await db.orderItem.create({ data: { ...base, nameSnapshot: "Cóctel pendiente dos" } });
  const coffee = await db.orderItem.create({ data: { ...base, menuItemId: cafe.id, nameSnapshot: "Café pendiente" } });
  const kitchen = await db.orderItem.create({ data: { ...base, station: "kitchen", nameSnapshot: "Plato pendiente" } });
  const cancelled = await db.orderItem.create({ data: { ...base, nameSnapshot: "Cóctel rechazado", cancelledAt: new Date(), cancellationKind: "cancel" } });
  const served = await db.orderItem.create({ data: { ...base, nameSnapshot: "Cóctel servido", servedAt: new Date() } });
  const foreignItem = await db.orderItem.create({ data: { ...base, menuItemId: null, orderId: otherOrder.id, roundId: otherRound.id, nameSnapshot: "Otro comercio" } });

  await page.route(/^https?:\/\//, route => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  const headers = { "x-real-ip": `127.4.${parseInt(uid.slice(0, 2), 16)}.${parseInt(uid.slice(2, 4), 16)}` };
  await page.setExtraHTTPHeaders(headers);
  await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: "es", domain: application.hostname, path: "/" }]);
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const login = await page.request.post("/api/auth/callback/credentials", { headers: { ...headers, "X-Auth-Return-Redirect": "1" }, form: { csrfToken: csrf.csrfToken, email: user.email, password: uid, callbackUrl: `${application.origin}/bar` } });
  expect(login.ok()).toBe(true);
  expect((await (await page.request.get("/api/auth/session")).json()).user.role).toBe("bar");
  await page.goto("/bar?sub=Cocteles");
  return { restaurant, order, round, base, first, second, coffee, kitchen, cancelled, served, foreignItem };
}

test.afterEach(async ({ page }) => {
  await page.goto("about:blank");
  for (const restaurantId of tenants) {
    await db.auditEvent.deleteMany({ where: { restaurantId } });
    await db.restaurant.deleteMany({ where: { id: restaurantId } });
    await db.platformEvent.deleteMany({ where: { restaurantId } });
    tenants.delete(restaurantId);
  }
});
test.afterAll(() => db.$disconnect());

test("bar staff can confirm the visible substation once without serving new arrivals or other stations", async ({ page }, info) => {
  const f = await fixture(page);
  const serveAll = page.getByRole("button", { name: "Servir todo", exact: true });
  await expect(serveAll).toBeVisible();
  await expect(page.getByText("Cóctel rechazado", { exact: false })).toHaveCount(0);
  await serveAll.click();
  const dialog = page.getByRole("dialog", { name: "¿Servir todo lo pendiente?", exact: true });
  await expect(dialog).toContainText("2 productos");
  await expect(dialog).toContainText("Solo lo de Cocteles");
  // The confirmation contains a snapshot. A later arrival remains pending.
  const late = await db.orderItem.create({ data: { ...f.base, nameSnapshot: "Cóctel llegado después" } });
  await page.screenshot({ path: info.outputPath("bar-serve-all-confirm.png"), animations: "disabled" });
  const responsePromise = page.waitForResponse(response => response.url().endsWith("/order-items/serve-all") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Sí, servir todo", exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ ok: true, served: 2, skipped: 0 });
  await expect(dialog).toHaveCount(0);
  const read = (id: string) => db.orderItem.findUniqueOrThrow({ where: { id } });
  const first = await read(f.first.id);
  expect(first.servedAt).not.toBeNull();
  expect((await read(f.second.id)).servedAt).not.toBeNull();
  for (const id of [late.id, f.coffee.id, f.kitchen.id, f.cancelled.id, f.foreignItem.id]) {
    expect((await read(id)).servedAt).toBeNull();
  }
  expect((await read(f.served.id)).servedAt).toEqual(f.served.servedAt);
  expect((await db.round.findUniqueOrThrow({ where: { id: f.round.id } })).status).not.toBe("served");
  const retry = await page.request.post("/api/operator/order-items/serve-all", { data: { station: "bar", barSubStation: "Cocteles", itemIds: [f.first.id, f.second.id] } });
  expect(await retry.json()).toEqual({ ok: true, served: 0, skipped: 2 });
  expect((await read(f.first.id)).servedAt).toEqual(first.servedAt);
  expect(await db.auditEvent.count({ where: { restaurantId: f.restaurant.id, kind: "order_item.serve_all", actorRole: "bar" } })).toBe(1);
});

test("cancelling the confirmation changes nothing and the server rejects kitchen access from bar", async ({ page }) => {
  const f = await fixture(page);
  await page.getByRole("button", { name: "Servir todo", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "¿Servir todo lo pendiente?", exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect((await db.orderItem.findUniqueOrThrow({ where: { id: f.first.id } })).servedAt).toBeNull();
  const denied = await page.request.post("/api/operator/order-items/serve-all", { data: { station: "kitchen", itemIds: [f.kitchen.id] } });
  expect(denied.status()).toBe(403);
  expect(await denied.json()).toMatchObject({ error: "forbidden" });
  const scoped = await page.request.post("/api/operator/order-items/serve-all", { data: { station: "bar", barSubStation: "Cocteles", itemIds: [f.first.id, f.coffee.id, f.kitchen.id, f.foreignItem.id, f.cancelled.id, f.served.id] } });
  expect(await scoped.json()).toEqual({ ok: true, served: 1, skipped: 5 });
  for (const id of [f.coffee.id, f.kitchen.id, f.foreignItem.id, f.cancelled.id]) {
    expect((await db.orderItem.findUniqueOrThrow({ where: { id } })).servedAt).toBeNull();
  }
});
