import bcrypt from "bcryptjs";
import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

const base = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3300");
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
const local = ["localhost", "127.0.0.1"].includes(base.hostname) && ["localhost", "127.0.0.1"].includes(database.hostname) && /^\/mesapay_.*(?:test|validation)$/.test(database.pathname);
test.skip(!local, "This suite requires an explicit isolated local database and local application");
const db = new PrismaClient();
const slug = `e2e-${randomUUID()}`;
let restaurantId: string;
let tableId: string;
let menuItemId: string;
const qrToken = randomUUID();
const email = `${slug}@example.test`;
const password = `Fixture-${randomUUID()}`;

test.beforeAll(async () => {
  restaurantId = (await db.restaurant.create({ data: { slug, name: "Restaurante de prueba", country: "CO", enabledPaymentMethods: ["cash"], serviceMode: "table" } })).id;
  await db.user.create({ data: { restaurantId, email, role: "operator", passwordHash: await bcrypt.hash(password, 10) } });
  tableId = (await db.table.create({ data: { restaurantId, number: 1, qrToken } })).id;
  const category = await db.category.create({ data: { restaurantId, slug: "pruebas", label: "Platos" } });
  menuItemId = (await db.menuItem.create({ data: { restaurantId, categoryId: category.id, name: "Plato de prueba", priceCents: 1000000, available: true } })).id;
});
test.afterAll(async () => {
  if (restaurantId) {
    await db.financialOperation.deleteMany({ where: { key: { startsWith: `${slug}:` } } });
    await db.restaurant.delete({ where: { id: restaurantId } });
    await db.platformEvent.deleteMany({ where: { restaurantId } });
  }
  await db.$disconnect();
});

test("QR guest can order; forged access, demo payment and closed-order edits are rejected", async ({ page, request, context }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  const payload = { tableId, items: [{ menuItemId, qty: 1 }], guestName: "Prueba" };
  const withoutQr = await request.post(`/api/tenant/${slug}/orders`, { data: payload });
  expect(withoutQr.status()).toBe(403);
  const wrongToken = await request.get(`/api/tenant/${slug}/guest?table=${tableId}`);
  expect(wrongToken.status()).toBe(404);

  await page.goto(`/t/${slug}/menu?table=${qrToken}`);
  await expect(page.getByText("Plato de prueba", { exact: true }).first()).toBeVisible();
  expect((await context.cookies()).some(c => c.name.startsWith("mesapay_guest_"))).toBe(true);
  const placed = await page.request.post(`/api/tenant/${slug}/orders`, { data: payload });
  expect(placed.status()).toBe(200);
  const { orderId } = await placed.json();
  const demo = await page.request.post(`/api/tenant/${slug}/pay`, { data: { orderId, method: "demo_card", amountCents: 1000000 } });
  expect(demo.status()).toBe(403);
  expect(await db.payment.count({ where: { orderId } })).toBe(0);

  const unauthorizedSettle = await page.request.post(`/api/tenant/${slug}/pay`, { data: { orderId, method: "demo_cash", amountCents: 1000000, settleNow: true } });
  expect(unauthorizedSettle.status()).toBe(403);
  await db.order.update({ where: { id: orderId }, data: { status: "paid", paidAt: new Date() } });
  const append = await page.request.post(`/api/tenant/${slug}/orders`, { data: { ...payload, orderId } });
  expect(append.status()).toBe(409);
  expect(await db.orderItem.count({ where: { orderId } })).toBe(1);
  expect(errors).toEqual([]);
});


test("operator records one verified reconciliation from the payment detail", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  const order = await db.order.create({ data: { restaurantId, tableId, shortCode: randomUUID(), subtotalCents: 1000000, totalCents: 1000000, status: "placed" } });
  const payment = await db.payment.create({ data: { orderId: order.id, method: "kushki_card", status: "approved", amountCents: 1000000, refundReservedCents: 500000, reconciliationRequired: true } });
  await db.financialOperation.create({ data: { key: `${slug}:refund`, paymentId: payment.id, kind: "refund", amountCents: 500000, status: "uncertain" } });
  await db.order.update({ where: { id: order.id }, data: { status: "paid", paidAt: new Date() } });
  await page.goto("/signin");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(u => !u.pathname.startsWith("/signin"));
  await page.goto(`/operator/orders/${order.id}`);
  await page.getByRole("button", { name: "Conciliar pago", exact: true }).click();
  const save = page.getByRole("button", { name: "Guardar conciliación", exact: true });
  await expect(save).toBeDisabled();
  await page.getByLabel("Referencia o caso de soporte").fill("fixture-refund-reference");
  await page.getByLabel("Evidencia de la verificación").fill("Confirmed with the isolated payment fixture; no real payment involved.");
  await page.getByLabel("Verifiqué el estado definitivo y el importe con el proveedor.").check();
  if (testInfo.project.name === "mobile") await page.screenshot({ path: testInfo.outputPath("reconcile-mobile.png"), fullPage: true });
  await save.click();
  await expect(page.getByRole("button", { name: "Conciliar pago", exact: true })).toHaveCount(0);
  const settled = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
  expect(settled.refundedCents).toBe(500000);
  expect(settled.refundReservedCents).toBe(0);
  expect(await db.auditEvent.count({ where: { targetId: payment.id, kind: "payment.reconciled" } })).toBe(1);
  expect(errors).toEqual([]);
});
