import { test, expect, type Page } from "@playwright/test";
import { PrismaClient, type MeasureKind } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import es from "../messages/es.json";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!["localhost", "127.0.0.1"].includes(databaseUrl.hostname) || !/^\/mesapay_.*validation$/.test(databaseUrl.pathname) || !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""), "Isolated local app and validation database required");
const db = new PrismaClient();
const t = es.opErp;
const labelStartingWith = (label: string) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
test.use({ actionTimeout: 10_000 });

async function setup(page: Page, measureKind: MeasureKind = "mass") {
  const token = randomUUID(), password = `Prices-${token}`;
  const clientHeaders = { "x-real-ip": `127.2.${parseInt(token.slice(0, 2), 16)}.${parseInt(token.slice(2, 4), 16)}` };
  await page.setExtraHTTPHeaders(clientHeaders);
  await page.route(/^https?:\/\//, route => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  const restaurant = await db.restaurant.create({ data: { name: "Precios de prueba", slug: `prices-${token}`, enabledModules: ["inventory", "purchasing", "recipes"] } });
  const user = await db.user.create({ data: { email: `prices-${token}@example.test`, passwordHash: await bcrypt.hash(password, 4), role: "operator", restaurantId: restaurant.id } });
  const ingredient = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Insumo de prueba", measureKind, stockLevel: { create: { restaurantId: restaurant.id, qtyBase: 2000, totalValueCents: 1200000 } } } });
  const movement = await db.stockMovement.create({ data: { restaurantId: restaurant.id, ingredientId: ingredient.id, kind: "adjust_in", qtyBase: 2000, valueCents: 1200000 } });
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  await page.request.post("/api/auth/callback/credentials", {
    headers: { ...clientHeaders, "X-Auth-Return-Redirect": "1" },
    form: { csrfToken: csrf.csrfToken, email: user.email, password, callbackUrl: `${process.env.PLAYWRIGHT_BASE_URL}/operator/settings/insumos` },
  });
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(user.id);
  return { restaurant, ingredient, movement, cleanup: async () => {
    await db.auditEvent.deleteMany({ where: { restaurantId: restaurant.id } });
    await db.stockMovement.deleteMany({ where: { restaurantId: restaurant.id } });
    await db.purchaseOrder.deleteMany({ where: { restaurantId: restaurant.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.restaurant.delete({ where: { id: restaurant.id } });
  } };
}

async function openEditor(page: Page, name: string) {
  await page.goto("/operator/settings/insumos");
  await page.getByRole("button", { name: t.editIngredientNamed.replace("{name}", name), exact: true }).click();
  return page.getByRole("dialog", { name: t.editIngredient, exact: true });
}

for (const [kind, unit] of [["mass", "kg"], ["volume", "L"], ["count", "un"]] as const) {
  test(`editable price persists for ${kind} without revaluing stock`, async ({ page }) => {
    const f = await setup(page, kind);
    try {
      const dialog = await openEditor(page, f.ingredient.name);
      const field = dialog.getByRole("textbox", { name: `Precio de referencia (COP/${unit})`, exact: true });
      await expect(field).toBeVisible();
      await field.fill("25000,75");
      await expect(field).toHaveValue("25.000,75");
      await dialog.getByRole("button", { name: t.save, exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByText(new RegExp(`^Referencia: \\$\\s*25\\.000,75/${unit}$`))).toBeVisible();
      const saved = (await (await page.request.get("/api/operator/ingredients")).json()).ingredients.find((i: { id: string }) => i.id === f.ingredient.id);
      expect(saved.referencePriceCents).toBe(2500075);
      expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: f.ingredient.id } })).toMatchObject({ qtyBase: 2000, totalValueCents: 1200000 });
      expect(await db.stockMovement.findUniqueOrThrow({ where: { id: f.movement.id } })).toEqual(f.movement);
      const reopened = await openEditor(page, f.ingredient.name);
      await expect(reopened.getByRole("textbox", { name: `Precio de referencia (COP/${unit})`, exact: true })).toHaveValue("25.000,75");
      await page.screenshot({ animations: "disabled", path: test.info().outputPath(`price-${kind}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    } finally { await f.cleanup(); }
  });
}

test("price changes remain editable after a failed request and can be cleared", async ({ page }) => {
  const f = await setup(page);
  try {
    const dialog = await openEditor(page, f.ingredient.name);
    const field = dialog.getByRole("textbox", { name: "Precio de referencia (COP/kg)", exact: true });
    await field.fill("18000");
    const endpoint = `**/api/operator/ingredients/${f.ingredient.id}`;
    await page.route(endpoint, route => route.abort("failed"));
    await dialog.getByRole("button", { name: t.save, exact: true }).click();
    await expect(dialog.getByRole("alert")).toHaveText(t.errSaveFailed);
    await expect(field).toHaveValue("18.000");
    await expect(dialog.getByRole("button", { name: t.save, exact: true })).toBeEnabled();
    await page.unroute(endpoint);
    await dialog.getByRole("button", { name: t.save, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const reopened = await openEditor(page, f.ingredient.name);
    await reopened.getByRole("textbox", { name: "Precio de referencia (COP/kg)", exact: true }).fill("");
    await reopened.getByRole("button", { name: t.save, exact: true }).click();
    await expect(reopened).toHaveCount(0);
    const saved = (await (await page.request.get("/api/operator/ingredients")).json()).ingredients.find((i: { id: string }) => i.id === f.ingredient.id);
    expect(saved.referencePriceCents).toBeNull();
  } finally { await f.cleanup(); }
});

test("new purchase suggests the reference price and respects a manual cost", async ({ page }) => {
  const f = await setup(page);
  try {
    expect((await page.request.patch(`/api/operator/ingredients/${f.ingredient.id}`, { data: { referencePriceCents: 2500000 } })).ok()).toBe(true);
    const supplier = await db.supplier.create({ data: { restaurantId: f.restaurant.id, name: "Proveedor sin presentación" } });
    await page.goto("/operator/compras");
    await page.locator("#operator-content").getByRole("button", { name: t.newOrder, exact: true }).click();
    await page.getByPlaceholder(t.supplierSearchPlaceholder).fill(supplier.name);
    await page.getByRole("button", { name: supplier.name, exact: true }).click();
    await page.getByPlaceholder(t.ingredientSearchPlaceholder).fill(f.ingredient.name);
    await page.getByRole("button", { name: new RegExp(f.ingredient.name) }).click();
    const qty = page.getByRole("textbox", { name: labelStartingWith(t.fieldQty) });
    const cost = page.getByRole("textbox", { name: labelStartingWith(`${t.fieldExpectedCost} (COP)`) });
    await qty.fill("2,5");
    await expect(cost).toHaveValue("62.500");
    await cost.fill("60000");
    await qty.fill("3");
    await expect(cost).toHaveValue("60.000");
    await page.getByRole("button", { name: t.addLine, exact: true }).click();
    await page.getByRole("button", { name: t.createOrder, exact: true }).click();
    await expect.poll(async () => db.purchaseOrder.count({ where: { restaurantId: f.restaurant.id } })).toBe(1);
    const order = await db.purchaseOrder.findFirstOrThrow({ where: { restaurantId: f.restaurant.id }, include: { items: true } });
    expect(order.items[0]).toMatchObject({ ingredientId: f.ingredient.id, qtyOrderedBase: 3000, expectedCostCents: 6000000 });
    expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: f.ingredient.id } })).toMatchObject({ qtyBase: 2000, totalValueCents: 1200000 });
  } finally { await f.cleanup(); }
});

test("bulk dimension changes clear the displayed price before reopening the editor", async ({ page }) => {
  const f = await setup(page);
  try {
    // A new unused ingredient can change dimensions; stocked ingredients cannot.
    const unused = await db.ingredient.create({ data: { restaurantId: f.restaurant.id, name: "Insumo nuevo sin movimientos", measureKind: "mass", referencePriceCents: 1800000 } });
    await page.goto("/operator/settings/insumos");
    await page.getByRole("checkbox", { name: t.bulkSelectRow.replace("{name}", unused.name), exact: true }).check();
    await page.getByRole("button", { name: t.bulkChangeMeasure, exact: true }).click();
    await page.locator("#operator-content").getByRole("combobox").filter({ has: page.locator('option[value="volume"]') }).selectOption("volume");
    const changed = page.waitForResponse(response => response.url().endsWith("/api/operator/ingredients/bulk") && response.request().method() === "POST");
    await page.getByRole("button", { name: t.bulkApply, exact: true }).click();
    expect((await changed).ok()).toBe(true);
    await page.getByRole("button", { name: t.editIngredientNamed.replace("{name}", unused.name), exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("textbox", { name: "Precio de referencia (COP/L)", exact: true })).toHaveValue("");
    expect(await db.ingredient.findUniqueOrThrow({ where: { id: unused.id } })).toMatchObject({ measureKind: "volume", referencePriceCents: null });
  } finally { await f.cleanup(); }
});

test("the inventory average disappears after a confirmed stock reset", async ({ page }) => {
  const f = await setup(page);
  try {
    const dialog = await openEditor(page, f.ingredient.name);
    await expect(dialog.getByText(/^Costo promedio actual del inventario:/)).toBeVisible();
    await dialog.getByRole("checkbox").uncheck();
    await dialog.getByRole("button", { name: t.save, exact: true }).click();
    await page.getByRole("region", { name: t.stockResetTitle, exact: true }).getByRole("button", { name: t.stockResetConfirm, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: t.editIngredientNamed.replace("{name}", f.ingredient.name), exact: true }).click();
    await expect(page.getByRole("dialog").getByText(/^Costo promedio actual del inventario:/)).toHaveCount(0);
  } finally { await f.cleanup(); }
});

test("supplier presentations keep their own price instead of the ingredient reference", async ({ page }) => {
  const f = await setup(page);
  try {
    await db.ingredient.update({ where: { id: f.ingredient.id }, data: { referencePriceCents: 2500000 } });
    const supplier = await db.supplier.create({ data: { restaurantId: f.restaurant.id, name: "Proveedor con presentación" } });
    await db.supplierIngredient.create({ data: { supplierId: supplier.id, ingredientId: f.ingredient.id, presentationLabel: "Bolsa de 1 kg", contentQty: 1000, lastPriceCents: 1000000 } });
    await page.goto("/operator/compras");
    await page.locator("#operator-content").getByRole("button", { name: t.newOrder, exact: true }).click();
    await page.getByPlaceholder(t.supplierSearchPlaceholder).fill(supplier.name);
    await page.getByRole("button", { name: supplier.name, exact: true }).click();
    await page.getByPlaceholder(t.priceListSearchPlaceholder).fill(f.ingredient.name);
    await page.getByRole("button", { name: new RegExp(`${f.ingredient.name}.*Bolsa de 1 kg`) }).click();
    await page.getByRole("spinbutton", { name: labelStartingWith(t.fieldPresentationsCount) }).fill("2");
    await expect(page.getByRole("textbox", { name: labelStartingWith(`${t.fieldExpectedCost} (COP)`) })).toHaveValue("20.000");
  } finally { await f.cleanup(); }
});

test.afterAll(async () => { await db.$disconnect(); });
