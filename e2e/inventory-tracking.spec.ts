import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(
  !["127.0.0.1", "localhost"].includes(databaseUrl.hostname) ||
    !/^\/mesapay_.*validation$/.test(databaseUrl.pathname) ||
    !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""),
  "Isolated local app and validation database required",
);
const db = new PrismaClient();
async function login(page: Page, email: string, password: string) {
  await page.goto("/signin");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"));
}
async function selectRestaurant(page: Page, restaurantId: string) {
  await page.context().addCookies([{ name: "mesapay_act_as", value: restaurantId, domain: "localhost", path: "/" }]);
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

for (const width of [390, 1440]) {
  test(`ingredients and products can disable and restore tracking at ${width}px`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 1100 });
    await page.route(/^https?:\/\//, (route) => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    const token = randomUUID(), password = `Fixture-${token}`;
    const restaurant = await db.restaurant.create({ data: { name: "Inventario de prueba", slug: `tracking-${token}`, enabledModules: ["inventory", "recipes", "purchasing"] } });
    const user = await db.user.create({ data: { email: `tracking-${token}@example.test`, passwordHash: await bcrypt.hash(password, 10), role: "platform_admin" } });
    await db.category.create({ data: { restaurantId: restaurant.id, label: "Servicios", slug: "servicios" } });
    try {
      await login(page, user.email, password);
      await selectRestaurant(page, restaurant.id);
      await page.goto("/operator/settings/insumos");
      await page.getByRole("button", { name: "Nuevo insumo", exact: true }).click();
      await page.getByPlaceholder("Lomo de res, aceite de oliva…", { exact: true }).fill("Servicio de limpieza");
      const tracking = page.getByRole("checkbox", { name: "Llevar inventario", exact: true });
      await expect(tracking).toBeChecked();
      await tracking.uncheck();
      await noOverflow(page);
      await page.screenshot({ path: `/Users/nicolas/Documents/Codex/2026-09-08/files-mentioned-by-the-user-scr/UI-UX-MESAPAY/insumo-no-inventariable-${width}.png`, fullPage: true });
      await page.getByRole("button", { name: "Guardar", exact: true }).click();
      await expect.poll(() => db.ingredient.count({ where: { restaurantId: restaurant.id, name: "Servicio de limpieza", trackInventory: false } })).toBe(1);
      const ingredient = await db.ingredient.findFirstOrThrow({ where: { restaurantId: restaurant.id } });
      await page.reload();
      await expect(page.getByText(/No inventariable/)).toBeVisible();
      await page.getByRole("button", { name: /Servicio de limpieza/ }).click();
      await expect(tracking).not.toBeChecked();
      await tracking.check();
      await page.getByRole("button", { name: "Guardar", exact: true }).click();
      await expect.poll(async () => (await db.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).trackInventory).toBe(true);
      await page.reload();
      await page.getByRole("button", { name: /Servicio de limpieza/ }).click();
      await expect(tracking).toBeChecked();
      await page.getByRole("button", { name: "Cancelar", exact: true }).last().click();

      await page.goto("/operator/menu");
      await page.getByRole("button", { name: "+ Producto", exact: true }).click();
      await page.getByLabel("Nombre", { exact: true }).fill("Servicio para eventos");
      await page.getByLabel("Precio (COP)", { exact: true }).fill("25000");
      await expect(tracking).toBeChecked();
      await tracking.uncheck();
      await noOverflow(page);
      await page.screenshot({ path: `/Users/nicolas/Documents/Codex/2026-09-08/files-mentioned-by-the-user-scr/UI-UX-MESAPAY/producto-no-inventariable-${width}.png`, fullPage: true });
      await page.getByRole("button", { name: "Crear producto", exact: true }).click();
      await expect.poll(() => db.menuItem.count({ where: { restaurantId: restaurant.id, trackInventory: false } })).toBe(1);
      const product = await db.menuItem.findFirstOrThrow({ where: { restaurantId: restaurant.id } });
      await page.reload();
      await expect(page.getByText(/No inventariable/)).toBeVisible();
      await page.getByRole("button", { name: "Editar", exact: true }).first().click();
      await expect(tracking).not.toBeChecked();
      await tracking.check();
      await noOverflow(page);
      await page.getByRole("button", { name: "Guardar", exact: true }).click();
      await expect.poll(async () => (await db.menuItem.findUniqueOrThrow({ where: { id: product.id } })).trackInventory).toBe(true);
      await page.reload();
      await page.getByRole("button", { name: "Editar", exact: true }).first().click();
      await expect(tracking).toBeChecked();
      expect(await db.stockMovement.count({ where: { restaurantId: restaurant.id } })).toBe(0);
    } finally {
      await db.restaurant.delete({ where: { id: restaurant.id } });
      await db.user.delete({ where: { id: user.id } });
    }
  });
}

test("HTTP guards reject nonempty stock, wrong tenants and unauthorized roles", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const token = randomUUID(), password = `Fixture-${token}`;
  const passwordHash = await bcrypt.hash(password, 10);
  const first = await db.restaurant.create({ data: { name: "Inventario A", slug: `tracking-a-${token}`, enabledModules: ["inventory"] } });
  const second = await db.restaurant.create({ data: { name: "Inventario B", slug: `tracking-b-${token}`, enabledModules: ["inventory"] } });
  const admin = await db.user.create({ data: { email: `tracking-admin-${token}@example.test`, passwordHash, role: "platform_admin" } });
  const waiter = await db.user.create({ data: { email: `tracking-waiter-${token}@example.test`, passwordHash, role: "mesero", restaurantId: first.id } });
  const waiterContext = await browser.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL, locale: "es-CO" });
  try {
    await login(page, admin.email, password);
    await selectRestaurant(page, first.id);
    const response = await page.request.post("/api/operator/ingredients", { data: { name: "Con saldo", measureKind: "count", trackInventory: true } });
    expect(response.status()).toBe(201);
    const { ingredient } = await response.json();
    await db.stockLevel.create({ data: { restaurantId: first.id, ingredientId: ingredient.id, qtyBase: 1000, totalValueCents: 500 } });
    const blocked = await page.request.patch(`/api/operator/ingredients/${ingredient.id}`, { data: { trackInventory: false } });
    expect(blocked.status()).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: "inventory_balance_remaining" });
    await selectRestaurant(page, second.id);
    const foreign = await page.request.patch(`/api/operator/ingredients/${ingredient.id}`, { data: { trackInventory: false } });
    expect(foreign.status()).toBe(404);
    const category = await db.category.create({ data: { restaurantId: first.id, label: "Privado", slug: "privado" } });
    const product = await db.menuItem.create({ data: { restaurantId: first.id, categoryId: category.id, name: "Privado", priceCents: 100 } });
    const foreignProduct = await page.request.patch(`/api/operator/menu-items/${product.id}`, { data: { trackInventory: false } });
    expect(foreignProduct.status()).toBe(403);
    const waiterPage = await waiterContext.newPage();
    await login(waiterPage, waiter.email, password);
    for (const path of [`ingredients/${ingredient.id}`, `menu-items/${product.id}`]) {
      expect([401, 403]).toContain((await waiterPage.request.patch(`/api/operator/${path}`, { data: { trackInventory: false } })).status());
    }
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).trackInventory).toBe(true);
    expect((await db.menuItem.findUniqueOrThrow({ where: { id: product.id } })).trackInventory).toBe(true);
    expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: ingredient.id } })).toMatchObject({ qtyBase: 1000, totalValueCents: 500 });
  } finally {
    await waiterContext.close();
    await db.restaurant.deleteMany({ where: { id: { in: [first.id, second.id] } } });
    await db.user.delete({ where: { id: admin.id } });
  }
});

test.afterAll(() => db.$disconnect());
