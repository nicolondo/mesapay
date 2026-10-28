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
const scanLabel = "Escanear código de barras";
const quantityHint = "Pulsa Enter para escanear el siguiente código.";
const quantity = (page: Page, ingredient: Ingredient) => page.getByLabel(`Conteo de ${ingredient.name}`, { exact: true });

async function fixture(size: number) {
  const token = randomUUID();
  const password = `Scan-${token}`;
  const restaurant = await db.restaurant.create({ data: {
    name: "Conteo con lector QA", slug: `scan-flow-${token}`, enabledModules: ["inventory"],
  } });
  const user = await db.user.create({ data: {
    email: `scan-flow-${token}@example.test`, passwordHash: await bcrypt.hash(password, 10),
    role: "operator", restaurantId: restaurant.id,
  } });
  const ingredients = await Promise.all(Array.from({ length: size }, (_, index) => db.ingredient.create({ data: {
    restaurantId: restaurant.id, name: `Producto ${String(index).padStart(2, "0")}`,
    measureKind: index === size - 2 ? "mass" : "count",
    barcode: `QA-${String(index).padStart(3, "0")}`,
    stockLevel: { create: { restaurantId: restaurant.id, qtyBase: 10000, totalValueCents: 100000 } },
  } })));
  const last = ingredients.at(-1)!;
  await db.ingredientBarcode.create({ data: { restaurantId: restaurant.id, ingredientId: last.id, barcode: "QA-LAST-ALTERNATE" } });
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
  const scanner = page.getByLabel(scanLabel, { exact: true });
  await expect(scanner).toBeFocused();
  return scanner;
}

async function hidScan(page: Page, scanner: Locator, barcode: string, target: Locator) {
  await expect(scanner).toBeFocused();
  await page.keyboard.type(barcode);
  await page.keyboard.press("Enter");
  await expect(target).toBeFocused();
  await expect(target).toBeInViewport({ ratio: 1 });
  await expect(scanner).toHaveValue("");
}

test("long count keeps the scanner visible and Enter starts the next HID scan without saving", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const seed = await fixture(40);
  try {
    const scanner = await loginAndCreateCount(page, seed);
    const count = await db.stockCount.findFirstOrThrow({ where: { restaurantId: seed.restaurant.id } });
    const firstQuantity = quantity(page, seed.ingredients[0]);
    const massQuantity = quantity(page, seed.ingredients.at(-2)!);
    const lastQuantity = quantity(page, seed.ingredients.at(-1)!);
    const mutations: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes(`/api/operator/stock/counts/${count.id}`) && request.method() !== "GET") mutations.push(request.method());
    });
    const scannerTop = (await scanner.boundingBox())!.y;

    // This was the reported failure: focusing the last row scrolled the scanner out of sight.
    await hidScan(page, scanner, "QA-039", lastQuantity);
    await expect(scanner).toBeInViewport({ ratio: 1 });
    await expect.poll(async () => Math.abs((await scanner.boundingBox())!.y - scannerTop)).toBeLessThan(3);
    const region = page.getByRole("region", { name: "Detalle del conteo", exact: true });
    await expect(region).toBeVisible();
    expect((await lastQuantity.boundingBox())!.y).toBeGreaterThan((await scanner.boundingBox())!.y + (await scanner.boundingBox())!.height);
    await expect(lastQuantity).toHaveAccessibleDescription(quantityHint);
    await lastQuantity.fill("12");
    await lastQuantity.press("Enter");
    await expect(scanner).toBeFocused();
    await expect(scanner).toHaveValue("");

    for (const barcode of ["QA-039", "QA-LAST-ALTERNATE", "QA-039"]) {
      await hidScan(page, scanner, barcode, lastQuantity);
      await expect(lastQuantity).toHaveValue("12");
      await lastQuantity.press("Enter");
      await expect(scanner).toBeFocused();
    }
    await hidScan(page, scanner, "QA-038", massQuantity);
    await massQuantity.fill("1,25");
    await massQuantity.press("Enter");
    await expect(scanner).toBeFocused();
    await hidScan(page, scanner, "QA-000", firstQuantity);
    await firstQuantity.fill("0");
    await firstQuantity.press("Enter");
    await expect(scanner).toBeFocused();

    // Scrolling the list by hand also leaves the scan control and action buttons reachable.
    await region.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(scanner).toBeInViewport({ ratio: 1 });
    await expect.poll(async () => Math.abs((await scanner.boundingBox())!.y - scannerTop)).toBeLessThan(3);
    await expect(page.getByRole("button", { name: "Guardar borrador", exact: true })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("scanner-visible-at-list-bottom.png"), fullPage: true });
    expect(mutations).toEqual([]);
    expect(await db.stockCountItem.count({ where: { countId: count.id, countedQty: { not: null } } })).toBe(0);
    expect(await db.stockMovement.count({ where: { restaurantId: seed.restaurant.id } })).toBe(0);

    await page.getByRole("button", { name: "Guardar borrador", exact: true }).click();
    await expect.poll(() => db.stockCountItem.count({ where: { countId: count.id, countedQty: { not: null } } })).toBe(3);
    expect(mutations).toEqual(["PATCH"]);
    const saved = await db.stockCount.findUniqueOrThrow({ where: { id: count.id }, include: { items: true } });
    expect(saved.status).toBe("draft");
    expect(saved.items.find((item) => item.ingredientId === seed.ingredients[0].id)?.countedQty).toBe(0);
    expect(saved.items.find((item) => item.ingredientId === seed.ingredients.at(-2)!.id)?.countedQty).toBe(1250);
    expect(saved.items.find((item) => item.ingredientId === seed.ingredients.at(-1)!.id)?.countedQty).toBe(12000);
    expect(await db.stockMovement.count({ where: { restaurantId: seed.restaurant.id } })).toBe(0);

    await page.reload();
    await page.getByRole("tab", { name: "Conteos", exact: true }).click();
    await page.getByRole("button").filter({ hasText: "40 insumos" }).click();
    await expect(scanner).toBeFocused();
    await hidScan(page, scanner, "QA-LAST-ALTERNATE", lastQuantity);
    await expect(lastQuantity).toHaveValue("12");
    await lastQuantity.press("Enter");
    await hidScan(page, scanner, "QA-038", massQuantity);
    await expect(massQuantity).toHaveValue("1.25");
    await expect(firstQuantity).toHaveValue("0");
    await page.screenshot({ path: testInfo.outputPath("quantity-hint-and-reopened-count.png"), fullPage: true });
  } finally { await seed.cleanup(); }
});

test("blank or invalid quantity keeps focus until corrected; zero is an explicit valid count", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const seed = await fixture(3);
  try {
    const scanner = await loginAndCreateCount(page, seed);
    const input = quantity(page, seed.ingredients[0]);
    await hidScan(page, scanner, "QA-000", input);
    for (const raw of ["", "0.0001", "2147483648"]) {
      await input.fill(raw);
      await input.press("Enter");
      await expect(input).toBeFocused();
      await expect(input).toHaveAttribute("aria-invalid", "true");
      await expect(scanner).not.toBeFocused();
      expect(await db.stockCountItem.count({ where: { count: { restaurantId: seed.restaurant.id }, countedQty: { not: null } } })).toBe(0);
      expect(await db.stockMovement.count({ where: { restaurantId: seed.restaurant.id } })).toBe(0);
    }
    await page.screenshot({ path: testInfo.outputPath("invalid-quantity-retains-focus.png"), fullPage: true });
    // A quantity entered manually must also clear any unfinished scan before returning focus.
    await scanner.fill("UNFINISHED-CODE");
    await input.fill("0");
    await input.press("Enter");
    await expect(scanner).toBeFocused();
    await expect(scanner).toHaveValue("");
    await expect(input).not.toHaveAttribute("aria-invalid", "true");
    await page.getByRole("button", { name: "Guardar borrador", exact: true }).click();
    await expect.poll(async () => (await db.stockCountItem.findFirstOrThrow({ where: { ingredientId: seed.ingredients[0].id } })).countedQty).toBe(0);
  } finally { await seed.cleanup(); }
});

test("scanner only appears in editable initial and final counts, never on reports or closed counts", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const seed = await fixture(3);
  try {
    const scanner = await loginAndCreateCount(page, seed);
    const balances = () => db.stockLevel.findMany({ where: { restaurantId: seed.restaurant.id }, orderBy: { ingredientId: "asc" }, select: { ingredientId: true, qtyBase: true } });
    const initialBalances = await balances();
    for (const item of seed.ingredients) {
      const input = quantity(page, item);
      await hidScan(page, scanner, item.barcode!, input);
      await input.fill(item.measureKind === "mass" ? "9.5" : "9");
      await input.press("Enter");
      await expect(scanner).toBeFocused();
    }
    await page.getByRole("button", { name: "Ver preliminar", exact: true }).click();
    await expect(page.getByRole("button", { name: "Iniciar conteo definitivo", exact: true })).toBeVisible();
    await expect(scanner).toHaveCount(0);
    expect(await balances()).toEqual(initialBalances);
    expect(await db.stockMovement.count({ where: { restaurantId: seed.restaurant.id } })).toBe(0);
    await page.getByRole("button", { name: "Iniciar conteo definitivo", exact: true }).click();
    await expect(scanner).toBeFocused();
    for (const item of seed.ingredients) {
      const input = quantity(page, item);
      await hidScan(page, scanner, item.barcode!, input);
      await expect(input).toHaveValue("");
      await input.fill(item.measureKind === "mass" ? "9.75" : "9.5");
      await input.press("Enter");
      await expect(scanner).toBeFocused();
    }
    await page.getByRole("button", { name: "Revisar ajuste definitivo", exact: true }).click();
    await expect(page.getByRole("button", { name: "Confirmar y ajustar inventario", exact: true })).toBeVisible();
    await expect(scanner).toHaveCount(0);
    expect(await balances()).toEqual(initialBalances);
    expect(await db.stockMovement.count({ where: { restaurantId: seed.restaurant.id } })).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("final-review-without-scanner.png"), fullPage: true });
    await page.getByRole("button", { name: "Confirmar y ajustar inventario", exact: true }).click();
    await expect.poll(async () => (await db.stockCount.findFirstOrThrow({ where: { restaurantId: seed.restaurant.id } })).status).toBe("closed");
    await expect(scanner).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Guardar borrador", exact: true })).toHaveCount(0);
    expect(await db.stockMovement.count({ where: { restaurantId: seed.restaurant.id } })).toBe(3);
    const finalBalances = await balances();
    for (const item of seed.ingredients) expect(finalBalances.find((balance) => balance.ingredientId === item.id)?.qtyBase).toBe(item.measureKind === "mass" ? 9750 : 9500);
  } finally { await seed.cleanup(); }
});

test("short and landscape viewports keep scanned quantities clear of the footer", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const seed = await fixture(20);
  try {
    await page.setViewportSize({ width: 390, height: 430 });
    const scanner = await loginAndCreateCount(page, seed);
    const region = page.getByRole("region", { name: "Detalle del conteo", exact: true });
    for (const viewport of [{ width: 390, height: 430 }, { width: 320, height: 480 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      for (const index of [10, 19]) {
        const input = quantity(page, seed.ingredients[index]);
        await hidScan(page, scanner, seed.ingredients[index].barcode!, input);
        await expect(scanner).toBeInViewport({ ratio: 1 });
        // IntersectionObserver alone cannot detect a sticky footer covering the input.
        await expect.poll(() => input.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const points = [
            [rect.x + rect.width / 2, rect.y + rect.height / 2],
            [rect.x + 6, rect.y + 6], [rect.right - 6, rect.y + 6],
            [rect.x + 6, rect.bottom - 6], [rect.right - 6, rect.bottom - 6],
          ];
          return points.every(([x, y]) => document.elementFromPoint(x, y) === element);
        })).toBe(true);
        await input.fill(String(index));
        if (index === 19) await page.screenshot({
          path: testInfo.outputPath(`short-viewport-${viewport.width}x${viewport.height}.png`), fullPage: true,
        });
        await input.press("Enter");
        await expect(scanner).toBeFocused();
        await expect(scanner).toHaveValue("");
      }
      await region.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect(page.getByRole("button", { name: "Guardar borrador", exact: true })).toBeInViewport({ ratio: 1 });
      await expect(scanner).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    expect(await db.stockCountItem.count({ where: { count: { restaurantId: seed.restaurant.id }, countedQty: { not: null } } })).toBe(0);
    await page.getByRole("button", { name: "Guardar borrador", exact: true }).click();
    await expect.poll(async () => (await db.stockCountItem.findFirstOrThrow({ where: { ingredientId: seed.ingredients[19].id } })).countedQty).toBe(19000);
    expect(await db.stockMovement.count({ where: { restaurantId: seed.restaurant.id } })).toBe(0);
  } finally { await seed.cleanup(); }
});

test.afterAll(() => db.$disconnect());
