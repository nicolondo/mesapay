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
const catalogs = { es, en, pt };
const copy = {
  es: { active: "Activos", archived: "Archivados", archive: "Archivar", restore: "Restaurar" },
  en: { active: "Active", archived: "Archived", archive: "Archive", restore: "Restore" },
  pt: { active: "Ativos", archived: "Arquivados", archive: "Arquivar", restore: "Restaurar" },
};

async function setup(page: Page, locale: keyof typeof copy = "es") {
  const token = randomUUID(), password = `Archive-${token}`;
  const clientHeaders = { "x-real-ip": `127.1.${parseInt(token.slice(0, 2), 16)}.${parseInt(token.slice(2, 4), 16)}` };
  await page.setExtraHTTPHeaders(clientHeaders);
  await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: locale, url: process.env.PLAYWRIGHT_BASE_URL! }]);
  await page.route(/^https?:\/\//, route => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  const restaurant = await db.restaurant.create({ data: { name: "Archivo de prueba", slug: `archive-${token}`, enabledModules: ["inventory", "purchasing", "recipes"] } });
  const user = await db.user.create({ data: { email: `archive-${token}@example.test`, passwordHash: await bcrypt.hash(password, 4), role: "operator", restaurantId: restaurant.id } });
  const active = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Harina de prueba", measureKind: "mass", stockLevel: { create: { restaurantId: restaurant.id, qtyBase: 2000, totalValueCents: 1200000 } } } });
  const archived = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Aceite anterior", measureKind: "volume", active: false, stockLevel: { create: { restaurantId: restaurant.id, qtyBase: 1000, totalValueCents: 500000 } } } });
  const movement = await db.stockMovement.create({ data: { restaurantId: restaurant.id, ingredientId: active.id, kind: "adjust_in", qtyBase: 2000, valueCents: 1200000 } });
  const supplier = await db.supplier.create({ data: { restaurantId: restaurant.id, name: "Proveedor de prueba" } });
  const presentation = await db.supplierIngredient.create({ data: { supplierId: supplier.id, ingredientId: active.id, presentationLabel: "Bolsa", contentQty: 1000 } });
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const login = await page.request.post("/api/auth/callback/credentials", {
    headers: { ...clientHeaders, "X-Auth-Return-Redirect": "1" },
    form: { csrfToken: csrf.csrfToken, email: user.email, password, callbackUrl: `${process.env.PLAYWRIGHT_BASE_URL}/operator/settings/insumos` },
  });
  expect(login.ok()).toBe(true);
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(user.id);
  await page.goto("/operator/settings/insumos");
  return { restaurant, active, archived, movement, presentation, cleanup: async () => {
    await db.stockMovement.deleteMany({ where: { restaurantId: restaurant.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.restaurant.delete({ where: { id: restaurant.id } });
  } };
}

for (const locale of ["es", "en", "pt"] as const) {
  test(`archive and restore persist without deleting balances or history (${locale})`, async ({ page }) => {
    const f = await setup(page, locale), t = copy[locale];
    try {
      await expect(page.getByRole("tab", { name: t.active, exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByText(f.archived.name, { exact: true })).toHaveCount(0);
      const checkboxes = page.getByRole("checkbox");
      await checkboxes.last().check();
      await expect(page.getByRole("button", { name: catalogs[locale].opErp.bulkChangeCategory, exact: true })).toBeVisible();
      await page.getByRole("button", { name: `${t.archive} ${f.active.name}`, exact: true }).click();
      await expect(page.getByText(f.active.name, { exact: true })).toHaveCount(0);
      // Hidden rows must no longer be part of a pending bulk action.
      await expect(page.getByRole("button", { name: catalogs[locale].opErp.bulkChangeCategory, exact: true })).toHaveCount(0);
      await expect.poll(async () => (await db.ingredient.findUniqueOrThrow({ where: { id: f.active.id } })).active).toBe(false);
      expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: f.active.id } })).toMatchObject({ qtyBase: 2000, totalValueCents: 1200000 });
      expect(await db.stockMovement.findUniqueOrThrow({ where: { id: f.movement.id } })).toEqual(f.movement);
      expect(await db.supplierIngredient.findUniqueOrThrow({ where: { id: f.presentation.id } })).toEqual(f.presentation);
      await page.reload();
      await expect(page.getByText(f.active.name, { exact: true })).toHaveCount(0);
      await page.getByRole("tab", { name: t.archived, exact: true }).click();
      await expect(page.getByText(f.active.name, { exact: true })).toBeVisible();
      await page.screenshot({ animations: "disabled", fullPage: true, path: test.info().outputPath(`archived-${locale}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await page.getByRole("button", { name: `${t.restore} ${f.active.name}`, exact: true }).click();
      await expect(page.getByText(f.active.name, { exact: true })).toHaveCount(0);
      await page.getByRole("tab", { name: t.active, exact: true }).click();
      await expect(page.getByText(f.active.name, { exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByText(f.active.name, { exact: true })).toBeVisible();
      expect((await db.ingredient.findUniqueOrThrow({ where: { id: f.active.id } })).active).toBe(true);
    } finally { await f.cleanup(); }
  });
}

test("network failure keeps the ingredient visible and releases the archive action for retry", async ({ page }) => {
  const f = await setup(page);
  try {
    const endpoint = `**/api/operator/ingredients/${f.active.id}`;
    await page.route(endpoint, route => route.abort("failed"));
    const button = page.getByRole("button", { name: `Archivar ${f.active.name}`, exact: true });
    await button.click();
    await expect(page.getByRole("alert").filter({ hasText: es.opErp.errSaveFailed })).toBeVisible();
    await expect(button).toBeEnabled();
    await expect(page.getByText(f.active.name, { exact: true })).toBeVisible();
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: f.active.id } })).active).toBe(true);
    await page.unroute(endpoint);
    await button.click();
    await expect(page.getByText(f.active.name, { exact: true })).toHaveCount(0);
  } finally { await f.cleanup(); }
});

test("inventory hides archived stock by default and can explicitly reveal its preserved balance", async ({ page }) => {
  const f = await setup(page);
  try {
    await page.goto("/operator/inventario");
    await expect(page.getByText(f.archived.name, { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Mostrar archivados", exact: true }).click();
    await expect(page.getByText(f.archived.name, { exact: true }).locator("visible=true")).toHaveCount(1);
    expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: f.archived.id } })).toMatchObject({ qtyBase: 1000, totalValueCents: 500000 });
    await page.getByRole("tab", { name: es.opErp.tabMovements, exact: true }).click();
    await expect(page.getByText(f.active.name, { exact: true }).first()).toBeVisible();
  } finally { await f.cleanup(); }
});

test("archive rejects cross-tenant and malformed changes", async ({ page }) => {
  const f = await setup(page);
  const other = await db.restaurant.create({ data: { name: "Otro comercio", slug: `archive-other-${randomUUID()}` } });
  try {
    const privateIngredient = await db.ingredient.create({ data: { restaurantId: other.id, name: "Privado", measureKind: "mass" } });
    const response = await page.request.patch(`/api/operator/ingredients/${privateIngredient.id}`, { data: { active: false } });
    expect(response.status()).toBe(404);
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: privateIngredient.id } })).active).toBe(true);
    expect((await page.request.patch(`/api/operator/ingredients/${f.active.id}`, { data: { active: "false" } })).status()).toBe(400);
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: f.active.id } })).active).toBe(true);
  } finally { await db.restaurant.delete({ where: { id: other.id } }); await f.cleanup(); }
});

test("production only offers active prepared ingredients while retaining archived recipes", async ({ page }) => {
  const f = await setup(page);
  try {
    await db.restaurant.update({ where: { id: f.restaurant.id }, data: { enabledModules: ["inventory", "purchasing", "recipes", "production"] } });
    const base = await db.ingredient.create({ data: { restaurantId: f.restaurant.id, name: "Materia prima", measureKind: "mass" } });
    for (const output of [f.active, f.archived]) {
      await db.recipe.create({ data: { restaurantId: f.restaurant.id, outputIngredientId: output.id, outputQtyBase: 1000, items: { create: { ingredientId: base.id, qtyBase: 1000 } } } });
    }
    await page.goto("/operator/produccion");
    await page.getByRole("button", { name: es.opErp.productionProduceButton, exact: true }).click();
    await expect(page.getByText(f.active.name, { exact: true })).toBeVisible();
    await expect(page.getByText(f.archived.name, { exact: true })).toHaveCount(0);
    expect(await db.recipe.count({ where: { restaurantId: f.restaurant.id } })).toBe(2);
  } finally {
    await db.recipe.deleteMany({ where: { restaurantId: f.restaurant.id } });
    await f.cleanup();
  }
});

test.afterAll(async () => { await db.$disconnect(); });
