import { test, expect, type Locator, type Page } from "@playwright/test";
import { PrismaClient, type Ingredient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(
  !["127.0.0.1", "localhost"].includes(database.hostname)
    || !/^\/mesapay_.*validation$/.test(database.pathname)
    || !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""),
  "An isolated local app and validation database are required",
);
const db = new PrismaClient();
const quantity = (page: Page, item: Ingredient, part = 1) => page.getByLabel(
  part === 1 ? `Conteo de ${item.name}` : `Cantidad ${part} de ${item.name}`, { exact: true },
);
const unit = (page: Page, item: Ingredient, part = 1) => page.getByLabel(
  part === 1 ? `Unidad de ${item.name}` : `Unidad de cantidad ${part} de ${item.name}`, { exact: true },
);
const total = (page: Page, item: Ingredient) => page.getByRole("status", { name: `Total contado de ${item.name}`, exact: true });

async function fixture(size: number) {
  const token = randomUUID();
  const password = `Count-parts-${token}`;
  const restaurant = await db.restaurant.create({ data: {
    name: "Cantidades acumuladas QA", slug: `count-parts-${token}`, enabledModules: ["inventory"],
  } });
  const user = await db.user.create({ data: {
    email: `count-parts-${token}@example.test`, passwordHash: await bcrypt.hash(password, 10),
    role: "operator", restaurantId: restaurant.id,
  } });
  const ingredients = await Promise.all(Array.from({ length: size }, (_, index) => db.ingredient.create({ data: {
    restaurantId: restaurant.id, name: `Insumo ${String(index).padStart(2, "0")}`,
    measureKind: index === 1 ? "mass" : "count", barcode: `PART-${String(index).padStart(3, "0")}`,
    stockLevel: { create: { restaurantId: restaurant.id, qtyBase: 10000, totalValueCents: 100000 } },
  } })));
  const last = ingredients.at(-1)!;
  await db.ingredientBarcode.create({ data: { restaurantId: restaurant.id, ingredientId: last.id, barcode: "PART-ALIAS" } });
  return {
    restaurant, user, password, ingredients,
    cleanup: async () => {
      await db.auditEvent.deleteMany({ where: { restaurantId: restaurant.id } });
      await db.restaurant.delete({ where: { id: restaurant.id } });
      await db.user.deleteMany({ where: { id: user.id } });
    },
  };
}

async function loginAndCreateCount(page: Page, seed: Awaited<ReturnType<typeof fixture>>) {
  await page.route(/^https?:\/\//, (route) => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/auth/session") && response.ok()),
    page.goto("/signin"),
  ]);
  await page.getByLabel("Correo", { exact: true }).fill(seed.user.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(seed.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname === "/operator");
  await page.goto("/operator/inventario");
  await page.getByRole("tab", { name: "Conteos", exact: true }).click();
  await page.getByRole("button", { name: "Nuevo conteo", exact: true }).click();
  await page.getByRole("button", { name: "Crear conteo", exact: true }).click();
  const scanner = page.getByLabel("Escanear código de barras", { exact: true });
  await expect(scanner).toBeFocused();
  return scanner;
}

async function scan(page: Page, scanner: Locator, barcode: string, input: Locator) {
  await expect(scanner).toBeFocused();
  await page.keyboard.type(barcode);
  await page.keyboard.press("Enter");
  await expect(input).toBeFocused();
  await expect(input).toBeInViewport({ ratio: 1 });
  await expect(scanner).toBeInViewport({ ratio: 1 });
  await expect(scanner).toHaveValue("");
}

async function enterQuantity(input: Locator, scanner: Locator, raw: string) {
  await input.fill(raw);
  await input.press("Enter");
  await expect(scanner).toBeFocused();
  await expect(scanner).toHaveValue("");
}

test("each repeated or alias scan adds an editable quantity and explicit save preserves the sum and parts", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const seed = await fixture(40);
  const item = seed.ingredients.at(-1)!;
  try {
    const scanner = await loginAndCreateCount(page, seed);
    const count = await db.stockCount.findFirstOrThrow({ where: { restaurantId: seed.restaurant.id } });
    const mutations: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes(`/api/operator/stock/counts/${count.id}`) && request.method() !== "GET") mutations.push(request.method());
    });
    const scanTop = (await scanner.boundingBox())!.y;
    await scan(page, scanner, item.barcode!, quantity(page, item));
    await enterQuantity(quantity(page, item), scanner, "12");
    await scan(page, scanner, item.barcode!, quantity(page, item, 2));
    await expect(quantity(page, item)).toHaveValue("12");
    await expect(quantity(page, item, 2)).toHaveValue("");
    await enterQuantity(quantity(page, item, 2), scanner, "3");
    await scan(page, scanner, "PART-ALIAS", quantity(page, item, 3));
    await enterQuantity(quantity(page, item, 3), scanner, "5");
    await expect(total(page, item)).toContainText("20 un");

    // Correcting or removing a previous amount recalculates, rather than adding it twice.
    await quantity(page, item).fill("10");
    await expect(total(page, item)).toContainText("18 un");
    await page.getByRole("button", { name: `Quitar cantidad 2 de ${item.name}`, exact: true }).click();
    await expect(quantity(page, item, 2)).toHaveValue("5");
    await expect(quantity(page, item, 3)).toHaveCount(0);
    await expect(total(page, item)).toContainText("15 un");
    await scanner.focus();
    await scan(page, scanner, item.barcode!, quantity(page, item, 3));
    // A scan without entering a quantity reuses the empty field, avoiding phantom amounts.
    await scanner.focus();
    await scan(page, scanner, "PART-ALIAS", quantity(page, item, 3));
    await expect(quantity(page, item, 4)).toHaveCount(0);
    await enterQuantity(quantity(page, item, 3), scanner, "2");
    await expect(total(page, item)).toContainText("17 un");
    await expect(quantity(page, item, 3)).toHaveAccessibleDescription("Pulsa Enter para escanear el siguiente código.");
    await expect.poll(async () => Math.abs((await scanner.boundingBox())!.y - scanTop)).toBeLessThan(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("separate-quantities-and-total.png"), fullPage: true });
    expect(mutations).toEqual([]);
    expect(await db.stockCountItem.count({ where: { countId: count.id, countedQty: { not: null } } })).toBe(0);
    expect(await db.stockMovement.count({ where: { restaurantId: seed.restaurant.id } })).toBe(0);

    await page.getByRole("button", { name: "Guardar borrador", exact: true }).click();
    await expect.poll(async () => (await db.stockCountItem.findFirstOrThrow({ where: { countId: count.id, ingredientId: item.id } })).countedQty).toBe(17000);
    expect(mutations).toEqual(["PATCH"]);
    expect(await db.stockCountItem.findFirstOrThrow({ where: { countId: count.id, ingredientId: item.id } })).toMatchObject({ countedQty: 17000, countedParts: [10000, 5000, 2000] });
    await page.reload();
    await page.getByRole("tab", { name: "Conteos", exact: true }).click();
    await page.getByRole("button").filter({ hasText: "40 insumos" }).click();
    await expect(quantity(page, item)).toHaveValue("10");
    await expect(quantity(page, item, 2)).toHaveValue("5");
    await expect(quantity(page, item, 3)).toHaveValue("2");
    await expect(scanner).toBeFocused();
    await scan(page, scanner, "PART-ALIAS", quantity(page, item, 4));
    await enterQuantity(quantity(page, item, 4), scanner, "1");
    await expect(total(page, item)).toContainText("18 un");
    expect((await db.stockCountItem.findFirstOrThrow({ where: { countId: count.id, ingredientId: item.id } })).countedQty).toBe(17000);
    expect(await db.stockMovement.count({ where: { restaurantId: seed.restaurant.id } })).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("fourth-scan-after-reopening.png"), fullPage: true });
  } finally { await seed.cleanup(); }
});

test("mixed units, zero and blank counts persist distinctly while an overflowing sum blocks Enter and saving", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const seed = await fixture(3);
  const [zero, mass, blank] = seed.ingredients;
  try {
    const scanner = await loginAndCreateCount(page, seed);
    const count = await db.stockCount.findFirstOrThrow({ where: { restaurantId: seed.restaurant.id } });
    await scan(page, scanner, zero.barcode!, quantity(page, zero));
    await enterQuantity(quantity(page, zero), scanner, "0");
    await scan(page, scanner, mass.barcode!, quantity(page, mass));
    await expect(unit(page, mass)).toHaveValue("kg");
    await enterQuantity(quantity(page, mass), scanner, "1,25");
    await scan(page, scanner, mass.barcode!, quantity(page, mass, 2));
    await unit(page, mass, 2).selectOption("g");
    await enterQuantity(quantity(page, mass, 2), scanner, "500");
    await expect(total(page, mass)).toContainText("1,75 kg");
    await scan(page, scanner, blank.barcode!, quantity(page, blank));
    await quantity(page, blank).press("Enter");
    await expect(quantity(page, blank)).toBeFocused();
    await expect(quantity(page, blank)).toHaveAttribute("aria-invalid", "true");
    await page.getByRole("button", { name: "Guardar borrador", exact: true }).click();
    await expect.poll(async () => (await db.stockCountItem.findFirstOrThrow({ where: { countId: count.id, ingredientId: mass.id } })).countedQty).toBe(1750);
    expect(await db.stockCountItem.findFirstOrThrow({ where: { countId: count.id, ingredientId: mass.id } })).toMatchObject({ countedParts: [1250, 500] });
    expect(await db.stockCountItem.findFirstOrThrow({ where: { countId: count.id, ingredientId: zero.id } })).toMatchObject({ countedQty: 0, countedParts: [0] });
    expect(await db.stockCountItem.findFirstOrThrow({ where: { countId: count.id, ingredientId: blank.id } })).toMatchObject({ countedQty: null, countedParts: [] });

    await enterQuantity(quantity(page, zero), scanner, "1999999");
    await scan(page, scanner, zero.barcode!, quantity(page, zero, 2));
    await quantity(page, zero, 2).fill("2");
    await quantity(page, zero, 2).press("Enter");
    await expect(quantity(page, zero, 2)).toBeFocused();
    await expect(quantity(page, zero, 2)).toHaveAttribute("aria-invalid", "true");
    await expect(scanner).not.toBeFocused();
    await page.getByRole("button", { name: "Guardar borrador", exact: true }).click();
    await expect(page.getByText("Hay cantidades contadas inválidas: revisa los valores marcados.", { exact: true })).toBeVisible();
    expect((await db.stockCountItem.findFirstOrThrow({ where: { countId: count.id, ingredientId: zero.id } })).countedQty).toBe(0);
    expect(await db.stockMovement.count({ where: { restaurantId: seed.restaurant.id } })).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("overflow-keeps-count-unsaved.png"), fullPage: true });
    await quantity(page, zero).fill("1");
    await quantity(page, zero, 2).press("Enter");
    await expect(scanner).toBeFocused();
    await expect(total(page, zero)).toContainText("3 un");
  } finally { await seed.cleanup(); }
});

test("preliminary keeps its parts, final recount starts empty and confirmation creates one adjustment", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const seed = await fixture(1);
  const item = seed.ingredients[0];
  try {
    const scanner = await loginAndCreateCount(page, seed);
    const count = await db.stockCount.findFirstOrThrow({ where: { restaurantId: seed.restaurant.id } });
    for (const [index, amount] of ["12", "3", "5"].entries()) {
      await scan(page, scanner, index === 1 ? "PART-ALIAS" : item.barcode!, quantity(page, item, index + 1));
      await enterQuantity(quantity(page, item, index + 1), scanner, amount);
    }
    await page.getByRole("button", { name: "Ver preliminar", exact: true }).click();
    await expect(page.getByRole("button", { name: "Iniciar conteo definitivo", exact: true })).toBeVisible();
    await expect(scanner).toHaveCount(0);
    expect(await db.stockCountItem.findFirstOrThrow({ where: { countId: count.id, ingredientId: item.id } })).toMatchObject({ preliminaryQty: 20000, preliminaryParts: [12000, 3000, 5000] });
    expect((await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: item.id } })).qtyBase).toBe(10000);
    expect(await db.stockMovement.count({ where: { stockCountId: count.id } })).toBe(0);
    await page.getByRole("button", { name: "Iniciar conteo definitivo", exact: true }).click();
    await expect(scanner).toBeFocused();
    await expect(quantity(page, item)).toHaveValue("");
    await expect(quantity(page, item, 2)).toHaveCount(0);
    expect(await db.stockCountItem.findFirstOrThrow({ where: { countId: count.id, ingredientId: item.id } })).toMatchObject({ countedQty: null, countedParts: [], preliminaryParts: [12000, 3000, 5000] });
    for (const [index, amount] of ["4", "5"].entries()) {
      await scan(page, scanner, item.barcode!, quantity(page, item, index + 1));
      await enterQuantity(quantity(page, item, index + 1), scanner, amount);
    }
    await page.getByRole("button", { name: "Revisar ajuste definitivo", exact: true }).click();
    await expect(page.getByRole("button", { name: "Confirmar y ajustar inventario", exact: true })).toBeVisible();
    await expect(scanner).toHaveCount(0);
    expect(await db.stockMovement.count({ where: { stockCountId: count.id } })).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("preliminary-and-final-part-totals.png"), fullPage: true });
    await page.getByRole("button", { name: "Confirmar y ajustar inventario", exact: true }).click();
    await expect.poll(async () => (await db.stockCount.findUniqueOrThrow({ where: { id: count.id } })).status).toBe("closed");
    expect((await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: item.id } })).qtyBase).toBe(9000);
    expect(await db.stockMovement.count({ where: { stockCountId: count.id } })).toBe(1);
    expect(await db.stockCountItem.findFirstOrThrow({ where: { countId: count.id, ingredientId: item.id } })).toMatchObject({ countedQty: 9000, countedParts: [4000, 5000], preliminaryQty: 20000, preliminaryParts: [12000, 3000, 5000] });
    await expect(page.getByRole("button", { name: "Confirmar y ajustar inventario", exact: true })).toHaveCount(0);
  } finally { await seed.cleanup(); }
});

test.afterAll(() => db.$disconnect());
