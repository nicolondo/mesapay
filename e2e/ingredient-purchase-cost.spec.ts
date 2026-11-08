import { test, expect, type Locator, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import es from "../messages/es.json";

const application = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3411");
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!["localhost", "127.0.0.1"].includes(application.hostname)
  || !["localhost", "127.0.0.1"].includes(database.hostname)
  || !/^\/mesapay_.*validation$/.test(database.pathname), "Ingredient cost tests require isolated local services");
test.setTimeout(90_000);
test.use({ actionTimeout: 15_000, navigationTimeout: 60_000 });
const db = new PrismaClient();
const tenants = new Set<string>();
const t = es.opErp;

async function fixture(page: Page) {
  const uid = randomUUID();
  const headers = { "x-real-ip": `127.5.${parseInt(uid.slice(0, 2), 16)}.${parseInt(uid.slice(2, 4), 16)}` };
  await page.setExtraHTTPHeaders(headers);
  const restaurant = await db.restaurant.create({ data: { name: "Validación local de costos", slug: `ingredient-cost-${uid}`, country: "CO", enabledModules: ["inventory", "purchasing", "recipes"] } });
  tenants.add(restaurant.id);
  const user = await db.user.create({ data: { restaurantId: restaurant.id, email: `ingredient-cost-${uid}@example.test`, role: "operator", passwordHash: await bcrypt.hash(uid, 4) } });
  const supplier = await db.supplier.create({ data: { restaurantId: restaurant.id, name: "Proveedor de prueba de costos" } });
  const purchased = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Arroz recibido sin inventario", measureKind: "mass", trackInventory: false } });
  const manual = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Harina con referencia manual", measureKind: "mass", trackInventory: false, referencePriceCents: 900_000 } });
  const stocked = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Aceite con inventario valorado", measureKind: "volume", referencePriceCents: 200_000, stockLevel: { create: { restaurantId: restaurant.id, qtyBase: 1000, totalValueCents: 800_000 } } } });
  const unknown = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Sal pendiente de recibir", measureKind: "mass", trackInventory: false } });
  const partial = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Azúcar recibida parcialmente", measureKind: "mass", trackInventory: false } });
  const order = await db.purchaseOrder.create({ data: {
    restaurantId: restaurant.id, supplierId: supplier.id, number: 1, status: "received",
    createdAt: new Date("2026-10-03T15:00:00Z"), receivedAt: new Date("2026-10-04T15:00:00Z"),
    items: { create: [purchased, manual].map(ingredient => ({ ingredientId: ingredient.id, qtyOrderedBase: 2000, receivedQtyBase: 2000, expectedCostCents: 1_000_000, receivedCostCents: 1_000_000, nonInventoryReceivedCostCents: 1_000_000 })) },
  }, include: { items: true } });
  await db.purchaseOrder.create({ data: { restaurantId: restaurant.id, supplierId: supplier.id, number: 2, status: "draft", items: { create: { ingredientId: unknown.id, qtyOrderedBase: 1000, expectedCostCents: 1_500_000 } } } });
  await db.purchaseOrder.create({ data: {
    restaurantId: restaurant.id, supplierId: supplier.id, number: 3, status: "partially_received", createdAt: new Date("2026-10-02T15:00:00Z"),
    items: { create: { ingredientId: partial.id, qtyOrderedBase: 2000, expectedCostCents: 1_400_000, receivedQtyBase: 1000, receivedCostCents: 700_000, nonInventoryReceivedCostCents: 700_000 } },
  } });
  const category = await db.category.create({ data: { restaurantId: restaurant.id, slug: "prueba", label: "Prueba" } });
  const dish = await db.menuItem.create({ data: { restaurantId: restaurant.id, categoryId: category.id, name: "Arroz de prueba", priceCents: 2_000_000, recipe: { create: { restaurantId: restaurant.id, items: { create: { ingredientId: purchased.id, qtyBase: 200, wastePct: 0 } } } } } });
  await page.route(/^https?:\/\//, route => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: "es", domain: application.hostname, path: "/" }]);
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const login = await page.request.post("/api/auth/callback/credentials", { headers: { ...headers, "X-Auth-Return-Redirect": "1" }, form: { csrfToken: csrf.csrfToken, email: user.email, password: uid, callbackUrl: `${application.origin}/operator/settings/insumos` } });
  expect(login.ok()).toBe(true);
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(user.id);
  return { restaurant, purchased, manual, stocked, unknown, partial, order, dish };
}

const costCard = (page: Page | Locator, name: string) => page.getByRole("group", { name: `Costo de ${name}`, exact: true });

test.afterEach(async () => {
  for (const restaurantId of tenants) {
    await db.recipe.deleteMany({ where: { restaurantId } });
    await db.purchaseOrder.deleteMany({ where: { restaurantId } });
    await db.user.deleteMany({ where: { restaurantId } });
    await db.restaurant.deleteMany({ where: { id: restaurantId } });
    tenants.delete(restaurantId);
  }
});
test.afterAll(() => db.$disconnect());

test("ingredients distinguish effective costs, manual references, received purchases and drafts", async ({ page }, info) => {
  const f = await fixture(page);
  await page.goto("/operator/settings/insumos");
  const bought = costCard(page, f.purchased.name);
  await expect(bought).toContainText("Costo usado en recetas");
  await expect(bought).toContainText(/5[.,]000/);
  await expect(bought).toContainText("Compra recibida");
  await expect(bought).toContainText("Promedio de lo recibido en esta compra");
  await expect(bought.getByRole("link", { name: /OC-0001/ })).toHaveAttribute("href", `/operator/compras?oc=${f.order.id}`);
  await expect(bought).toContainText("Proveedor de prueba de costos");
  await expect(bought).toContainText("Recibida el");
  await expect(bought).toContainText(/4.*oct/i);
  await expect(costCard(page, f.manual.name)).toContainText(/9[.,]000/);
  await expect(costCard(page, f.manual.name)).toContainText("Referencia manual");
  await expect(costCard(page, f.stocked.name)).toContainText(/8[.,]000/);
  await expect(costCard(page, f.stocked.name)).toContainText("Promedio del inventario");
  await expect(costCard(page, f.unknown.name)).toContainText("Sin costo disponible");
  await expect(costCard(page, f.unknown.name)).not.toContainText(/\$\s*0/);
  await expect(costCard(page, f.unknown.name)).not.toContainText(/15[.,]000/);
  await expect(costCard(page, f.partial.name)).toContainText(/7[.,]000/);
  await expect(costCard(page, f.partial.name)).toContainText("Compra registrada el");
  await expect(costCard(page, f.partial.name)).not.toContainText("Recibida el");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await bought.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("ingredient-cost-sources.png"), animations: "disabled" });
  expect(await db.stockMovement.count({ where: { restaurantId: f.restaurant.id } })).toBe(0);
  expect((await db.ingredient.findUniqueOrThrow({ where: { id: f.purchased.id } })).referencePriceCents).toBeNull();
});

test("editing a manual reference changes its source and removing it restores the received cost", async ({ page }) => {
  const f = await fixture(page);
  await page.goto(`/operator/settings/insumos?editar=${f.purchased.id}`);
  const dialog = page.getByRole("dialog", { name: t.editIngredient, exact: true });
  await expect(costCard(dialog, f.purchased.name)).toContainText("Compra recibida");
  const reference = dialog.getByRole("textbox", { name: "Precio de referencia (COP/kg)", exact: true });
  await expect(reference).toHaveValue("");
  await reference.fill("3000");
  const [purchasePage] = await Promise.all([
    page.waitForEvent("popup", { timeout: 5000 }),
    dialog.getByRole("link", { name: /OC-0001/ }).click(),
  ]);
  await expect(purchasePage).toHaveURL(new RegExp(`/operator/compras\\?oc=${f.order.id}`));
  await purchasePage.close();
  await expect(dialog).toBeVisible();
  await expect(reference).toHaveValue("3.000");
  await dialog.getByRole("button", { name: t.save, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(costCard(page, f.purchased.name)).toContainText("Referencia manual");
  await expect(costCard(page, f.purchased.name)).toContainText(/3[.,]000/);
  await page.getByRole("button", { name: t.editIngredientNamed.replace("{name}", f.purchased.name), exact: true }).click();
  await reference.fill("");
  await dialog.getByRole("button", { name: t.save, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(costCard(page, f.purchased.name)).toContainText("Compra recibida");
  await expect(costCard(page, f.purchased.name)).toContainText(/5[.,]000/);
  expect((await db.ingredient.findUniqueOrThrow({ where: { id: f.purchased.id } })).referencePriceCents).toBeNull();
  expect(await db.stockMovement.count({ where: { restaurantId: f.restaurant.id } })).toBe(0);
});

test("returning to a recipe refreshes purchase costs without replacing unsaved quantities", async ({ page }) => {
  const f = await fixture(page);
  await page.goto("/operator/recetas");
  await page.getByRole("button", { name: new RegExp(f.dish.name) }).click();
  const dialog = page.getByRole("dialog", { name: f.dish.name, exact: true });
  const summary = dialog.getByTestId("recipe-cost-summary");
  await expect(summary).toContainText(/1[.,]000/);
  const desktopQty = dialog.getByRole("textbox", { name: `${t.fieldNetQty} · ${f.purchased.name}`, exact: true });
  if (page.viewportSize()!.width >= 1024) {
    await desktopQty.fill("350");
  } else {
    await dialog.getByRole("button", { name: t.rdEditLineOf.replace("{name}", f.purchased.name), exact: true }).click();
    const sheet = page.getByTestId("recipe-line-sheet");
    await expect(sheet).toContainText("Compra recibida");
    await sheet.getByLabel(t.fieldNetQty, { exact: true }).fill("350");
    await sheet.getByRole("button", { name: t.rdLineDone }).last().click();
  }
  await expect(summary).toContainText(/1[.,]750/);
  const item = f.order.items.find(item => item.ingredientId === f.purchased.id)!;
  await db.purchaseOrderItem.update({ where: { id: item.id }, data: { expectedCostCents: 2_000_000, receivedCostCents: 2_000_000, nonInventoryReceivedCostCents: 2_000_000 } });
  // The same browser event generated when returning from another tab.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(summary).toContainText(/3[.,]500/);
  await expect(dialog).toContainText(t.rdUnsaved);
  if (page.viewportSize()!.width >= 1024) await expect(desktopQty).toHaveValue("350");
  else {
    await dialog.getByRole("button", { name: t.rdEditLineOf.replace("{name}", f.purchased.name), exact: true }).click();
    await expect(page.getByTestId("recipe-line-sheet").getByLabel(t.fieldNetQty, { exact: true })).toHaveValue("350");
  }
  expect((await db.recipe.findUniqueOrThrow({ where: { menuItemId: f.dish.id }, include: { items: true } })).items[0].qtyBase).toBe(200);
});
