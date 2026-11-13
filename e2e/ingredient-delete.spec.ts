import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { createTranslator } from "next-intl";
import es from "../messages/es.json";
import en from "../messages/en.json";
import pt from "../messages/pt.json";

// «Eliminar insumo»: solo los que nunca tuvieron movimientos ni están en
// uso. Corre contra una app LOCAL con una base de validación desechable.
const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!["localhost", "127.0.0.1"].includes(databaseUrl.hostname) || !/^\/mesapay_.*validation$/.test(databaseUrl.pathname) || !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""), "Isolated local app and validation database required");
const db = new PrismaClient();
const catalogs = { es, en, pt };
type Locale = keyof typeof catalogs;
type Values = Record<string, string | number>;
const translator = (locale: Locale) => {
  const t = createTranslator({ locale, messages: catalogs[locale], namespace: "opErp" }) as unknown as (key: string, values?: Values) => string;
  return t;
};

async function setup(page: Page, locale: Locale = "es") {
  const token = randomUUID(), password = `Delete-${token}`;
  const clientHeaders = { "x-real-ip": `127.2.${parseInt(token.slice(0, 2), 16)}.${parseInt(token.slice(2, 4), 16)}` };
  await page.setExtraHTTPHeaders(clientHeaders);
  await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: locale, url: process.env.PLAYWRIGHT_BASE_URL! }]);
  await page.route(/^https?:\/\//, route => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  const restaurant = await db.restaurant.create({ data: { name: "Eliminar de prueba", slug: `delete-${token}`, enabledModules: ["inventory", "purchasing", "recipes"] } });
  const user = await db.user.create({ data: { email: `delete-${token}@example.test`, passwordHash: await bcrypt.hash(password, 4), role: "operator", restaurantId: restaurant.id } });
  // Sin nada que lo referencie: un duplicado con dos códigos de barras.
  const junk = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Azúcar duplicada", measureKind: "mass", barcode: `770${token.slice(0, 10)}` } });
  await db.ingredientBarcode.create({ data: { restaurantId: restaurant.id, ingredientId: junk.id, barcode: `771${token.slice(0, 10)}` } });
  const archivedJunk = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Sal vieja", measureKind: "mass", active: false } });
  // Con existencias y un movimiento: es historia.
  const used = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Harina de prueba", measureKind: "mass", stockLevel: { create: { restaurantId: restaurant.id, qtyBase: 2000, totalValueCents: 1200000 } } } });
  const movement = await db.stockMovement.create({ data: { restaurantId: restaurant.id, ingredientId: used.id, kind: "adjust_in", qtyBase: 2000, valueCents: 1200000 } });
  // Sin movimientos, pero en la sub-receta de otro insumo: dependencia viva.
  const inRecipe = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Cilantro de prueba", measureKind: "mass" } });
  const sauce = await db.ingredient.create({ data: {
    restaurantId: restaurant.id, name: "Salsa de la casa", measureKind: "mass",
    recipe: { create: { restaurantId: restaurant.id, outputQtyBase: 1000, items: { create: { ingredientId: inRecipe.id, qtyBase: 50 } } } },
  } });
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const login = await page.request.post("/api/auth/callback/credentials", {
    headers: { ...clientHeaders, "X-Auth-Return-Redirect": "1" },
    form: { csrfToken: csrf.csrfToken, email: user.email, password, callbackUrl: `${process.env.PLAYWRIGHT_BASE_URL}/operator/settings/insumos` },
  });
  expect(login.ok()).toBe(true);
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(user.id);
  await page.goto("/operator/settings/insumos");
  return { restaurant, junk, archivedJunk, used, movement, inRecipe, sauce, cleanup: async () => {
    await db.recipe.deleteMany({ where: { restaurantId: restaurant.id } });
    await db.stockMovement.deleteMany({ where: { restaurantId: restaurant.id } });
    await db.auditEvent.deleteMany({ where: { restaurantId: restaurant.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.restaurant.delete({ where: { id: restaurant.id } });
  } };
}
// Las filas se buscan dentro del contenido ya montado: mientras la página
// termina de llegar, el HTML en tránsito trae una copia oculta de la lista.
const rowName = (page: Page, name: string) => page.locator("#operator-content").getByText(name, { exact: true });
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const exists = async (id: string) => (await db.ingredient.count({ where: { id } })) === 1;

for (const locale of ["es", "en", "pt"] as const) {
  test(`only unused ingredients offer delete; it removes them with their barcodes (${locale})`, async ({ page }) => {
    const f = await setup(page, locale), t = translator(locale);
    try {
      const deleteButton = (name: string) => page.getByRole("button", { name: t("deleteIngredientNamed", { name }), exact: true });
      await expect(deleteButton(f.junk.name)).toBeVisible();
      await expect(deleteButton(f.used.name)).toHaveCount(0);
      await expect(deleteButton(f.inRecipe.name)).toHaveCount(0);
      await expect(deleteButton(f.sauce.name)).toHaveCount(0);
      expect(await noOverflow(page)).toBe(true);

      // «Sin movimientos»: el número y la lista son los eliminables.
      const chip = page.getByRole("button", { name: new RegExp(`^${t("filterNoMovements")}`) });
      await expect(chip).toContainText("1");
      await chip.click();
      await expect(rowName(page, f.junk.name)).toBeVisible();
      await expect(rowName(page, f.used.name)).toHaveCount(0);
      await chip.click();

      await deleteButton(f.junk.name).click();
      const dialog = page.getByTestId("ingredient-delete-dialog");
      await expect(dialog).toContainText(t("deleteIngredientConfirmBody", { name: f.junk.name }));
      await page.screenshot({ animations: "disabled", path: test.info().outputPath(`delete-confirm-${locale}.png`) });
      await dialog.getByRole("button", { name: t("deleteIngredientConfirm"), exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: t("ingredientDeletedNotice", { name: f.junk.name }) })).toBeVisible();
      await expect(rowName(page, f.junk.name)).toHaveCount(0);
      expect(await exists(f.junk.id)).toBe(false);
      expect(await db.ingredientBarcode.count({ where: { restaurantId: f.restaurant.id } })).toBe(0);
      expect(await db.auditEvent.count({ where: { restaurantId: f.restaurant.id, kind: "ingredient.delete", targetId: f.junk.id } })).toBe(1);
      // Lo que tiene historia sigue intacto.
      expect(await db.stockMovement.findUniqueOrThrow({ where: { id: f.movement.id } })).toEqual(f.movement);
      expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: f.used.id } })).toMatchObject({ qtyBase: 2000, totalValueCents: 1200000 });
      await page.reload();
      await expect(rowName(page, f.junk.name)).toHaveCount(0);

      // La ficha de uno en uso dice por qué no y ofrece archivar.
      await rowName(page, f.inRecipe.name).click();
      const panel = page.getByTestId("ingredient-delete-panel");
      await expect(panel).toContainText(t("delReasonRecipes", { count: 1, list: f.sauce.name }));
      await expect(panel.getByRole("button", { name: t("deleteIngredient"), exact: true })).toHaveCount(0);
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ animations: "disabled", path: test.info().outputPath(`delete-blocked-${locale}.png`) });
      await panel.getByRole("button", { name: t("archiveIngredient"), exact: true }).click();
      await expect.poll(async () => (await db.ingredient.findUniqueOrThrow({ where: { id: f.inRecipe.id } })).active).toBe(false);
      expect(await db.recipeItem.count({ where: { ingredientId: f.inRecipe.id } })).toBe(1);
    } finally { await f.cleanup(); }
  });
}

test("bulk delete removes the deletable ones and reports the rest with their reason", async ({ page }) => {
  const f = await setup(page), t = translator("es");
  try {
    await page.getByRole("tab", { name: es.opErp.filterAll, exact: true }).click();
    await page.getByRole("checkbox", { name: es.opErp.bulkSelectAll, exact: true }).check();
    await page.getByRole("button", { name: es.opErp.bulkDelete, exact: true }).click();
    const dialog = page.getByTestId("ingredient-bulk-delete-dialog");
    await expect(dialog).toContainText(t("bulkDeleteBody", { count: 2 }));
    await expect(dialog).toContainText(t("bulkDeleteSkipNote", { count: 3 }));
    await expect(dialog.getByTestId("ingredient-bulk-delete-skipped")).toContainText(`«${f.used.name}» (tiene existencias y tiene 1 movimiento de inventario)`);
    expect(await noOverflow(page)).toBe(true);
    await dialog.getByRole("button", { name: t("bulkDeleteConfirm", { count: 2 }), exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "2 insumos eliminados, 3 no se pudieron:" })).toBeVisible();
    expect(await Promise.all([f.junk, f.archivedJunk, f.used, f.inRecipe, f.sauce].map((row) => exists(row.id)))).toEqual([false, false, true, true, true]);
    // Los que no se eliminan quedan como estaban: ni siquiera se archivan.
    expect(await db.ingredient.findUniqueOrThrow({ where: { id: f.used.id } })).toMatchObject({ active: true });
    await expect(page.getByRole("button", { name: new RegExp(`^${es.opErp.filterNoMovements}`) })).toHaveCount(0);
  } finally { await f.cleanup(); }
});

test("inventory row menu deletes an ingredient without movements and explains a blocked one", async ({ page }) => {
  const f = await setup(page), t = translator("es");
  try {
    await page.goto("/operator/inventario");
    const menuOf = (name: string) => page.getByRole("button", { name: t("rowActionsLabel", { name }), exact: true }).locator("visible=true");
    // Con movimientos: el menú no trae «Eliminar».
    await menuOf(f.used.name).click();
    await expect(page.getByRole("menuitem", { name: es.opErp.rowArchive, exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: es.opErp.deleteIngredient, exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Sin movimientos pero en una receta: explica por qué no y ofrece archivar.
    await menuOf(f.inRecipe.name).click();
    await page.getByRole("menuitem", { name: es.opErp.deleteIngredient, exact: true }).click();
    const dialog = page.getByTestId("ingredient-delete-dialog");
    await expect(dialog.getByTestId("ingredient-delete-blocked")).toHaveText(`No se puede eliminar «${f.inRecipe.name}»: está en 1 receta (${f.sauce.name}).`);
    await expect(dialog.getByRole("button", { name: es.opErp.archiveIngredient, exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: es.opErp.deleteIngredientConfirm, exact: true })).toHaveCount(0);
    expect(await noOverflow(page)).toBe(true);
    await dialog.getByRole("button", { name: es.opErp.closeSheet, exact: true }).click();
    expect(await exists(f.inRecipe.id)).toBe(true);

    await menuOf(f.junk.name).click();
    await page.getByRole("menuitem", { name: es.opErp.deleteIngredient, exact: true }).click();
    await dialog.getByRole("button", { name: es.opErp.deleteIngredientConfirm, exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: t("ingredientDeletedNotice", { name: f.junk.name }) })).toBeVisible();
    await expect(rowName(page, f.junk.name).locator("visible=true")).toHaveCount(0);
    expect(await exists(f.junk.id)).toBe(false);
  } finally { await f.cleanup(); }
});

test("a reference created after the page loaded stops the delete and is explained", async ({ page }) => {
  const f = await setup(page), t = translator("es");
  try {
    await page.getByRole("button", { name: t("deleteIngredientNamed", { name: f.junk.name }), exact: true }).click();
    const dialog = page.getByTestId("ingredient-delete-dialog");
    await expect(dialog).toContainText(t("deleteIngredientConfirmBody", { name: f.junk.name }));
    // Mientras el diálogo espera, el insumo entra a inventario en otra pestaña.
    await db.stockLevel.create({ data: { restaurantId: f.restaurant.id, ingredientId: f.junk.id, qtyBase: 500, totalValueCents: 1000 } });
    await db.stockMovement.create({ data: { restaurantId: f.restaurant.id, ingredientId: f.junk.id, kind: "adjust_in", qtyBase: 500, valueCents: 1000 } });
    await dialog.getByRole("button", { name: es.opErp.deleteIngredientConfirm, exact: true }).click();
    await expect(dialog.getByTestId("ingredient-delete-blocked")).toHaveText(`No se puede eliminar «${f.junk.name}»: tiene existencias y tiene 1 movimiento de inventario.`);
    expect(await exists(f.junk.id)).toBe(true);
    expect(await db.ingredientBarcode.count({ where: { ingredientId: f.junk.id } })).toBe(2);
    expect(await db.auditEvent.count({ where: { restaurantId: f.restaurant.id, kind: "ingredient.delete" } })).toBe(0);
  } finally { await f.cleanup(); }
});

test("permanent delete rejects other tenants, staff-less sessions and used ingredients", async ({ page }) => {
  const f = await setup(page);
  const other = await db.restaurant.create({ data: { name: "Otro comercio", slug: `delete-other-${randomUUID()}`, enabledModules: ["inventory"] } });
  try {
    const foreign = await db.ingredient.create({ data: { restaurantId: other.id, name: "Privado", measureKind: "mass" } });
    expect((await page.request.get(`/api/operator/ingredients/${foreign.id}/delete`)).status()).toBe(404);
    expect((await page.request.delete(`/api/operator/ingredients/${foreign.id}/delete`)).status()).toBe(404);
    expect((await page.request.post("/api/operator/ingredients/bulk-delete", { data: { ids: [foreign.id] } })).status()).toBe(404);
    expect(await exists(foreign.id)).toBe(true);

    const blocked = await page.request.delete(`/api/operator/ingredients/${f.used.id}/delete`);
    expect(blocked.status()).toBe(409);
    expect(await blocked.json()).toEqual({ error: "not_deletable", reasons: [{ code: "stock", count: 1 }, { code: "movements", count: 1 }] });
    expect(await exists(f.used.id)).toBe(true);

    // El DELETE de siempre sigue archivando, no borra.
    expect((await page.request.delete(`/api/operator/ingredients/${f.junk.id}`)).status()).toBe(200);
    expect(await db.ingredient.findUniqueOrThrow({ where: { id: f.junk.id } })).toMatchObject({ active: false });

    await page.context().clearCookies();
    expect((await page.request.delete(`/api/operator/ingredients/${f.archivedJunk.id}/delete`)).status()).toBe(401);
    expect(await exists(f.archivedJunk.id)).toBe(true);
  } finally { await db.restaurant.delete({ where: { id: other.id } }); await f.cleanup(); }
});

test.afterAll(async () => { await db.$disconnect(); });
