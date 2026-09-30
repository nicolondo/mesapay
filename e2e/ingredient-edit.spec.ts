import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import es from "../messages/es.json";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!["localhost", "127.0.0.1"].includes(databaseUrl.hostname) || !/^\/mesapay_.*validation$/.test(databaseUrl.pathname) || !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""), "Isolated local app and validation database required");
const db = new PrismaClient();

async function setup(page: Page, width = 390) {
  const token = randomUUID(), password = `Ingredient-${token}`;
  const restaurant = await db.restaurant.create({ data: { name: "Edición de prueba", slug: `ingredient-edit-${token}`, enabledModules: ["inventory", "purchasing", "recipes"] } });
  const user = await db.user.create({ data: { email: `ingredient-edit-${token}@example.test`, passwordHash: await bcrypt.hash(password, 4), role: "platform_admin" } });
  await page.setViewportSize({ width, height: 1000 });
  await page.route(/^https?:\/\//, (route) => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.goto("/signin");
  await page.getByLabel("Correo", { exact: true }).fill(user.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"));
  await page.context().addCookies([{ name: "mesapay_act_as", value: restaurant.id, domain: "localhost", path: "/" }]);
  return { restaurant, cleanup: async () => { await db.restaurant.delete({ where: { id: restaurant.id } }); await db.user.delete({ where: { id: user.id } }); } };
}

async function openIngredient(page: Page, name: string) {
  await page.goto("/operator/settings/insumos");
  const edit = page.getByRole("button", { name: es.opErp.editIngredientNamed.replace("{name}", name), exact: true });
  await expect(edit).toHaveText(es.opErp.editIngredientAction);
  await edit.click();
  await expect(page.getByRole("dialog", { name: es.opErp.editIngredient, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: es.opErp.editIngredient, exact: true })).toBeVisible();
}

for (const width of [390, 1440]) {
  test(`edits tracked and untracked ingredients, supplier references and reorder at ${width}px`, async ({ page }) => {
    const f = await setup(page, width);
    try {
      const supplier = await db.supplier.create({ data: { restaurantId: f.restaurant.id, name: "Proveedor de prueba" } });
      const tracked = await db.ingredient.create({ data: { restaurantId: f.restaurant.id, name: "Arroz de prueba", measureKind: "mass", reorderPointBase: 1000, reorderQtyBase: 2000, supplierItems: { create: { supplierId: supplier.id, presentationLabel: "Bolsa", contentQty: 1000 } } } });
      const untracked = await db.ingredient.create({ data: { restaurantId: f.restaurant.id, name: "Servicio de prueba", measureKind: "count", trackInventory: false } });
      await openIngredient(page, tracked.name);
      await page.getByPlaceholder(es.opErp.namePlaceholder, { exact: true }).fill("Arroz editado");
      await page.getByPlaceholder(es.opErp.categoryPlaceholder, { exact: true }).fill("Granos");
      await page.getByPlaceholder(es.opErp.skuPlaceholder, { exact: true }).fill("ARROZ-EDITADO");
      const quantities = page.locator('input[inputmode="decimal"]');
      await quantities.nth(0).fill("2.5");
      await quantities.nth(1).fill("4");
      await page.screenshot({ animations: "disabled", path: test.info().outputPath(`ingredient-edit-${width}.png`) });
      await page.getByRole("button", { name: es.opErp.save, exact: true }).click();
      await expect.poll(async () => (await db.ingredient.findUniqueOrThrow({ where: { id: tracked.id } })).name).toBe("Arroz editado");
      expect(await db.ingredient.findUniqueOrThrow({ where: { id: tracked.id } })).toMatchObject({ category: "Granos", sku: "ARROZ-EDITADO", trackInventory: true, measureKind: "mass", reorderPointBase: 2500, reorderQtyBase: 4000 });
      expect(await db.supplierIngredient.count({ where: { ingredientId: tracked.id } })).toBe(1);
      await openIngredient(page, untracked.name);
      await page.getByPlaceholder(es.opErp.namePlaceholder, { exact: true }).fill("Servicio editado");
      await page.getByRole("button", { name: es.opErp.save, exact: true }).click();
      await expect.poll(async () => (await db.ingredient.findUniqueOrThrow({ where: { id: untracked.id } })).name).toBe("Servicio editado");
      expect(await db.ingredient.findUniqueOrThrow({ where: { id: untracked.id } })).toMatchObject({ trackInventory: false, reorderPointBase: null, reorderQtyBase: null });
      await page.reload();
      await expect(page.getByRole("button", { name: es.opErp.editIngredientNamed.replace("{name}", "Servicio editado"), exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ animations: "disabled", path: test.info().outputPath(`ingredient-edit-list-${width}.png`) });
      expect(await db.stockMovement.count({ where: { restaurantId: f.restaurant.id } })).toBe(0);
    } finally { await f.cleanup(); }
  });
}

for (const failure of ["network", "invalid-json", "missing-ingredient"] as const) {
test(`a ${failure} PATCH releases save and preserves the draft for retry`, async ({ page }) => {
  const f = await setup(page);
  try {
    const ingredient = await db.ingredient.create({ data: { restaurantId: f.restaurant.id, name: "Insumo recuperable", measureKind: "count" } });
    await openIngredient(page, ingredient.name);
    await page.getByPlaceholder(es.opErp.namePlaceholder, { exact: true }).fill("Edición recuperada");
    const endpoint = `**/api/operator/ingredients/${ingredient.id}`;
    await page.route(endpoint, (route) => route.request().method() !== "PATCH" ? route.continue() : failure === "network" ? route.abort("failed") : route.fulfill({ status: 200, contentType: failure === "invalid-json" ? "text/html" : "application/json", body: failure === "invalid-json" ? "<html>Temporary upstream failure</html>" : "{}" }));
    await page.getByRole("button", { name: es.opErp.save, exact: true }).click();
    await expect(page.getByRole("button", { name: es.opErp.save, exact: true })).toBeEnabled();
    await expect(page.getByRole("dialog").getByRole("alert")).toHaveText(es.opErp.errSaveFailed);
    await expect(page.getByPlaceholder(es.opErp.namePlaceholder, { exact: true })).toHaveValue("Edición recuperada");
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).name).toBe("Insumo recuperable");
    await page.unroute(endpoint);
    await page.getByRole("button", { name: es.opErp.save, exact: true }).click();
    await expect.poll(async () => (await db.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).name).toBe("Edición recuperada");
  } finally { await f.cleanup(); }
});
}

test("creation retries the failed reorder PATCH without creating a duplicate", async ({ page }) => {
  const f = await setup(page);
  try {
    await page.goto("/operator/settings/insumos");
    await page.getByRole("button", { name: es.opErp.newIngredient, exact: true }).click();
    await page.getByPlaceholder(es.opErp.namePlaceholder, { exact: true }).fill("Creación recuperable");
    const quantities = page.locator('input[inputmode="decimal"]');
    await quantities.nth(0).fill("2.5");
    await quantities.nth(1).fill("4");
    const endpoint = /\/api\/operator\/ingredients\/[^/]+$/;
    await page.route(endpoint, (route) => route.request().method() === "PATCH" ? route.abort("failed") : route.continue());
    await page.getByRole("button", { name: es.opErp.save, exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toHaveText(es.opErp.errSaveFailed);
    await expect(page.getByRole("button", { name: es.opErp.save, exact: true })).toBeEnabled();
    expect(await db.ingredient.count({ where: { restaurantId: f.restaurant.id } })).toBe(1);
    const created = await db.ingredient.findFirstOrThrow({ where: { restaurantId: f.restaurant.id } });
    expect(created.reorderPointBase).toBeNull();
    await page.unroute(endpoint);
    const retry = page.waitForResponse((response) => response.url().endsWith(`/api/operator/ingredients/${created.id}`) && response.request().method() === "PATCH");
    await page.getByRole("button", { name: es.opErp.save, exact: true }).click();
    expect((await retry).ok()).toBe(true);
    await expect.poll(async () => (await db.ingredient.findUniqueOrThrow({ where: { id: created.id } })).reorderPointBase).toBe(2500);
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: created.id } })).reorderQtyBase).toBe(4000);
    expect(await db.ingredient.count({ where: { restaurantId: f.restaurant.id } })).toBe(1);
    expect(await db.stockMovement.count({ where: { restaurantId: f.restaurant.id } })).toBe(0);
  } finally { await f.cleanup(); }
});

test.afterAll(() => db.$disconnect());
