import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import es from "../messages/es.json";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
const application = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3300");
test.skip(
  !["localhost", "127.0.0.1"].includes(database.hostname) ||
  !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname) ||
  !["localhost", "127.0.0.1"].includes(application.hostname),
  "Cancellation regression requires an isolated local database and app",
);
const db = new PrismaClient();

async function login(page: Page, email: string, password: string) {
  await page.route(/^https?:\/\//, (route) =>
    ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname)
      ? route.continue() : route.abort());
  await page.goto("/signin");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"));
}

for (const width of [390, 1440]) {
  test(`waiters cannot cancel prepared or served dishes, administrators retain controls at ${width}px`, async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    const token = randomUUID();
    const password = `Local-fixture-${token}`;
    const passwordHash = await bcrypt.hash(password, 10);
    const restaurant = await db.restaurant.create({ data: {
      slug: `cancellation-${token}`, name: "Cancelaciones de prueba",
      country: "CO", serviceMode: "table", enabledPaymentMethods: ["cash"],
      compEnabled: true, compAllowedRoles: ["operator", "mesero"],
      kitchenAutoFire: false, barAutoFire: false, kitchenPrintEnabled: false, barPrintEnabled: false,
    } });
    const table = await db.table.create({ data: { restaurantId: restaurant.id, number: 1, qrToken: randomUUID() } });
    const category = await db.category.create({ data: { restaurantId: restaurant.id, slug: "prueba", label: "Platos" } });
    const menu = await db.menuItem.create({ data: { restaurantId: restaurant.id, categoryId: category.id, name: "Plato de prueba", priceCents: 1_000_000 } });
    const waiter = await db.user.create({ data: { restaurantId: restaurant.id, role: "mesero", email: `waiter-${token}@example.test`, passwordHash } });
    const admin = await db.user.create({ data: { restaurantId: restaurant.id, role: "operator", email: `admin-${token}@example.test`, passwordHash } });
    const order = await db.order.create({ data: { restaurantId: restaurant.id, tableId: table.id, shortCode: randomUUID(), status: "placed", subtotalCents: 4_000_000, totalCents: 4_000_000 } });
    const round = await db.round.create({ data: { orderId: order.id, seq: 1, status: "placed" } });
    const firstStartedAt = new Date(Date.now() - 120_000);
    const makeItem = (name: string, kitchenStatus: "placed" | "in_kitchen" | "ready", started: boolean, served: boolean) => db.orderItem.create({ data: {
      orderId: order.id, roundId: round.id, menuItemId: menu.id,
      nameSnapshot: name, qty: 1, priceCentsSnapshot: 1_000_000, kitchenStatus,
      preparationStartedAt: kitchenStatus === "in_kitchen" ? firstStartedAt : null,
      preparationFirstStartedAt: started ? firstStartedAt : null,
      servedAt: served ? firstStartedAt : null,
    } });
    await makeItem("Sin preparar", "placed", false, false);
    const preparing = await makeItem("En preparación", "in_kitchen", true, false);
    const served = await makeItem("Plato servido", "ready", true, true);
    await makeItem("Devuelto a pendiente", "placed", true, false);
    const waiterContext = await browser.newContext({ baseURL: application.origin, viewport: { width, height: 1000 }, locale: "es-CO" });
    const adminContext = await browser.newContext({ baseURL: application.origin, viewport: { width, height: 1000 }, locale: "es-CO" });
    try {
      const page = await waiterContext.newPage();
      await login(page, waiter.email, password);
      await page.goto(`/mesero/mesas?open=${table.id}`);
      const row = (name: string) => page.locator("li").filter({ has: page.getByText(name, { exact: true }) });
      await expect(row("Sin preparar").getByRole("button", { name: es.opTables.cancelItem, exact: true })).toBeEnabled();
      for (const name of ["En preparación", "Devuelto a pendiente"]) {
        await expect(row(name).getByRole("button", { name: es.opTables.cancelItem, exact: true })).toBeDisabled();
        await expect(row(name).getByText(es.opTables.preparedCancellationAdminOnly, { exact: true })).toBeVisible();
      }
      await expect(row("Plato servido").getByRole("button", { name: es.opTables.compItem, exact: true })).toBeDisabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`waiter-${width}.png`), fullPage: true });
      const before = await db.order.findUniqueOrThrow({ where: { id: order.id } });
      const forbidden = await page.request.patch(`/api/operator/order-items/${served.id}`, {
        data: { cancel: { reason: "No debe permitirse", kind: "comp" } },
      });
      expect(forbidden.status()).toBe(403);
      expect(await forbidden.json()).toMatchObject({ error: "cancellation_admin_required" });
      expect((await db.orderItem.findUniqueOrThrow({ where: { id: served.id } })).cancelledAt).toBeNull();
      expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).totalCents).toBe(before.totalCents);
      await page.goto(`/t/${restaurant.slug}/pay/${order.id}?op=1`);
      await expect(page.getByText(es.pay.preparedCancellationAdminOnly, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: es.pay.representacion, exact: true })).toHaveCount(0);

      const adminPage = await adminContext.newPage();
      await login(adminPage, admin.email, password);
      await adminPage.goto(`/operator/tables?open=${table.id}`);
      const adminRow = (name: string) => adminPage.locator("li").filter({ has: adminPage.getByText(name, { exact: true }) });
      await expect(adminRow("En preparación").getByRole("button", { name: es.opTables.cancelItem, exact: true })).toBeEnabled();
      await expect(adminRow("Plato servido").getByRole("button", { name: es.opTables.compItem, exact: true })).toBeEnabled();
      expect(await adminPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await adminPage.screenshot({ path: testInfo.outputPath(`administrator-${width}.png`), fullPage: true });
      await adminRow("En preparación").getByRole("button", { name: es.opTables.cancelItem, exact: true }).click();
      await adminPage.getByPlaceholder(es.opTables.reasonPlaceholder).fill("Corrección autorizada de prueba");
      await adminPage.getByRole("button", { name: es.opTables.cancelCtaIdle, exact: true }).click();
      await expect.poll(async () => (await db.orderItem.findUniqueOrThrow({ where: { id: preparing.id } })).cancelledAt !== null).toBe(true);
      await adminRow("Plato servido").getByRole("button", { name: es.opTables.compItem, exact: true }).click();
      await adminPage.getByPlaceholder(es.opTables.reasonPlaceholder).fill("Cortesía autorizada de prueba");
      await adminPage.getByRole("button", { name: es.opTables.compCtaIdle, exact: true }).click();
      await expect.poll(async () => (await db.orderItem.findUniqueOrThrow({ where: { id: served.id } })).cancellationKind).toBe("comp");
      expect(await db.payment.count({ where: { orderId: order.id } })).toBe(0);
      expect(await db.simpleInvoice.count({ where: { orderId: order.id } })).toBe(0);
    } finally {
      await waiterContext.close();
      await adminContext.close();
      await db.restaurant.delete({ where: { id: restaurant.id } });
      await db.platformEvent.deleteMany({ where: { restaurantId: restaurant.id } });
    }
  });
}

test.afterAll(() => db.$disconnect());
