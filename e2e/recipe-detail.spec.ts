import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import es from "../messages/es.json";

// Detalle de receta: franja de costos, tabla con teclado, costo faltante con
// corrección en línea, aviso de unidad, guardar y descartar. Solo contra una
// app local con una base de validación aislada (nunca producción).
const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!["localhost", "127.0.0.1"].includes(databaseUrl.hostname) || !/^\/mesapay_.*validation$/.test(databaseUrl.pathname) || !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""), "Isolated local app and validation database required");
const db = new PrismaClient();
const t = es.opErp;
const DISH = "Cazuela de prueba";
test.use({ actionTimeout: 10_000 });

async function setup(page: Page, width: number) {
  const token = randomUUID(), password = `Recipe-${token}`;
  const clientHeaders = { "x-real-ip": `127.4.${parseInt(token.slice(0, 2), 16)}.${parseInt(token.slice(2, 4), 16)}` };
  await page.setExtraHTTPHeaders(clientHeaders);
  // Comercio con impoconsumo del 8 % embebido en el precio de carta.
  const restaurant = await db.restaurant.create({ data: { name: "Recetas de prueba", slug: `recipe-detail-${token}`, enabledModules: ["recipes"], salesTaxKind: "inc", salesTaxPct: 8 } });
  const user = await db.user.create({ data: { email: `recipe-detail-${token}@example.test`, passwordHash: await bcrypt.hash(password, 4), role: "platform_admin" } });
  const category = await db.category.create({ data: { restaurantId: restaurant.id, slug: "principales", label: "Principales" } });
  const dish = await db.menuItem.create({ data: { restaurantId: restaurant.id, categoryId: category.id, name: DISH, priceCents: 4_290_000 } });
  // $4.000/kg → 200 g = $800.
  const arroz = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Arroz de prueba", measureKind: "mass", referencePriceCents: 400_000 } });
  // Sin fuente de costo y medido en «un» (el caso de la sal).
  const sal = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Sal de prueba", measureKind: "count", trackInventory: false } });
  await db.recipe.create({ data: { restaurantId: restaurant.id, menuItemId: dish.id, items: { create: [{ ingredientId: arroz.id, qtyBase: 200, wastePct: 0 }] } } });

  await page.setViewportSize({ width, height: 900 });
  await page.route(/^https?:\/\//, (route) => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  await page.request.post("/api/auth/callback/credentials", {
    headers: { ...clientHeaders, "X-Auth-Return-Redirect": "1" },
    form: { csrfToken: csrf.csrfToken, email: user.email, password, callbackUrl: `${process.env.PLAYWRIGHT_BASE_URL}/operator/recetas` },
  });
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(user.id);
  await page.context().addCookies([{ name: "mesapay_act_as", value: restaurant.id, domain: "localhost", path: "/" }]);
  return {
    dish, arroz, sal,
    cleanup: async () => {
      await db.recipe.deleteMany({ where: { restaurantId: restaurant.id } });
      await db.restaurant.delete({ where: { id: restaurant.id } });
      await db.user.delete({ where: { id: user.id } });
    },
  };
}

async function openDish(page: Page) {
  await page.goto("/operator/recetas");
  await page.getByRole("button", { name: new RegExp(DISH) }).click();
  const dialog = page.getByRole("dialog", { name: DISH, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

const recipeItems = async (menuItemId: string) =>
  (await db.recipe.findUnique({ where: { menuItemId }, select: { items: { select: { ingredientId: true, qtyBase: true, wastePct: true } } } }))?.items ?? [];

test("desktop: cost strip, keyboard entry, inline missing-cost fix, unit hint and save", async ({ page }) => {
  const f = await setup(page, 1440);
  try {
    const dialog = await openDish(page);
    const summary = dialog.getByTestId("recipe-cost-summary");
    // Precio neto del INC: $42.900 → $39.722; costo $800 → food cost 2 %.
    await expect(summary).toContainText(t.rdNetOfTax.replace("{tax}", t.rdTaxShortInc).replace("{amount}", "$ 39.722"));
    await expect(summary).toContainText("$ 800");
    await expect(summary).toContainText("2%");

    // Buscador: Enter agrega y salta a la cantidad; Enter vuelve al buscador.
    const add = dialog.getByRole("combobox", { name: t.rdAddPlaceholder });
    await add.click();
    await page.keyboard.type("sal de");
    await page.keyboard.press("Enter");
    const salQty = dialog.getByRole("textbox", { name: `${t.fieldNetQty} · Sal de prueba` });
    await expect(salQty).toBeFocused();
    await page.keyboard.type("0,002");
    await page.keyboard.press("Enter");
    await expect(add).toBeFocused();
    await page.keyboard.press("Escape");

    // Un solo aviso de costo faltante + aviso suave de unidad (sin párrafo por línea).
    await expect(dialog.getByTestId("recipe-missing-banner")).toContainText("1 insumo no tiene costo");
    await expect(dialog.getByTestId("recipe-unit-hint")).toBeVisible();
    await expect(dialog.getByText(t.noCostHint)).toHaveCount(0);

    // «Poner precios» abre la corrección en línea con el foco en el precio.
    await dialog.getByRole("button", { name: t.rdBannerAction }).click();
    const fix = dialog.getByTestId("recipe-cost-fix");
    await expect(fix.locator("input")).toBeFocused();
    await fix.locator("input").fill("4000");
    await fix.getByRole("button", { name: t.rdFixSave }).click();
    await expect.poll(async () => (await db.ingredient.findUniqueOrThrow({ where: { id: f.sal.id } })).referencePriceCents).toBe(400_000);
    await expect(dialog.getByTestId("recipe-missing-banner")).toHaveCount(0);
    // 0,002 un × $4.000/un = $8 → total $808.
    await expect(summary).toContainText("$ 808");

    // Esc con cambios pide confirmación; «Seguir editando» conserva todo.
    await page.keyboard.press("Escape");
    const confirm = page.getByTestId("recipe-confirm");
    await expect(confirm).toContainText(t.rdDiscardTitle);
    await confirm.getByRole("button", { name: t.rdDiscardKeep }).click();
    await expect(confirm).toHaveCount(0);
    await expect(salQty).toHaveValue("0,002");

    await page.screenshot({ animations: "disabled", path: test.info().outputPath("recipe-detail-1440.png") });

    // Ctrl/⌘ + Enter guarda (el PUT de siempre) y cierra.
    await salQty.focus();
    await page.keyboard.press("Control+Enter");
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await recipeItems(f.dish.id)).length).toBe(2);
    expect(await recipeItems(f.dish.id)).toEqual(expect.arrayContaining([
      { ingredientId: f.arroz.id, qtyBase: 200, wastePct: 0 },
      { ingredientId: f.sal.id, qtyBase: 2, wastePct: 0 },
    ]));
  } finally { await f.cleanup(); }
});

test("desktop: closing with unsaved changes can discard them", async ({ page }) => {
  const f = await setup(page, 1280);
  try {
    const dialog = await openDish(page);
    await dialog.getByRole("textbox", { name: `${t.fieldNetQty} · Arroz de prueba` }).fill("350");
    await expect(dialog).toContainText(t.rdUnsaved);
    await dialog.getByRole("button", { name: t.rdClose }).click();
    await page.getByTestId("recipe-confirm").getByRole("button", { name: t.rdDiscardConfirm }).click();
    await expect(dialog).toHaveCount(0);
    expect(await recipeItems(f.dish.id)).toEqual([{ ingredientId: f.arroz.id, qtyBase: 200, wastePct: 0 }]);
  } finally { await f.cleanup(); }
});

test("mobile: line cards open a sheet to edit quantity and waste, then save", async ({ page }) => {
  const f = await setup(page, 390);
  try {
    const dialog = await openDish(page);
    await expect(dialog.getByTestId("recipe-cost-summary")).toBeVisible();
    await dialog.getByRole("button", { name: t.rdEditLineOf.replace("{name}", "Arroz de prueba") }).click();
    const sheet = page.getByTestId("recipe-line-sheet");
    await sheet.getByLabel(t.fieldNetQty, { exact: true }).fill("180");
    await sheet.getByLabel(t.fieldWastePct, { exact: true }).fill("20");
    // 180 g netos con 20 % de merma se costean como 225 g brutos.
    await expect(sheet).toContainText("225 g");
    await sheet.getByRole("button", { name: t.rdLineDone }).last().click();
    await expect(sheet).toHaveCount(0);
    await expect(dialog).toContainText(t.rdWasteShort.replace("{pct}", "20"));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ animations: "disabled", path: test.info().outputPath("recipe-detail-390.png") });
    await dialog.getByTestId("recipe-save").click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => recipeItems(f.dish.id)).toEqual([{ ingredientId: f.arroz.id, qtyBase: 180, wastePct: 20 }]);
  } finally { await f.cleanup(); }
});
