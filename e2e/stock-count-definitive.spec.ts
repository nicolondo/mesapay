import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";

// El conteo definitivo solo pide recontar lo que lo necesita: lo que tuvo
// diferencia, lo que no se contó y lo que tuvo movimientos desde que se abrió
// el conteo. Lo que cuadró queda confirmado del preliminar.
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(
  !["127.0.0.1", "localhost"].includes(database.hostname)
    || !/^\/mesapay_.*validation$/.test(database.pathname)
    || !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""),
  "An isolated local app and validation database are required",
);
const db = new PrismaClient();
const quantity = (page: Page, name: string) => page.getByLabel(`Conteo de ${name}`, { exact: true });
const rows = (page: Page) => page.locator("[data-count-row]");
const row = (page: Page, name: string) => rows(page).filter({ has: page.getByText(name, { exact: true }) });

test("the definitive count asks to recount only differences, uncounted and moved items", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  page.on("dialog", (dialog) => dialog.accept());
  await page.route(/^https?:\/\//, (route) => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  const token = randomUUID();
  const password = `Definitive-${token}`;
  const restaurant = await db.restaurant.create({ data: { name: "Definitivo QA", slug: `definitive-${token}`, enabledModules: ["inventory"] } });
  const user = await db.user.create({ data: { email: `definitive-${token}@example.test`, passwordHash: await bcrypt.hash(password, 10), role: "operator", restaurantId: restaurant.id } });
  const seed = [["Arroz", 10_000], ["Azúcar", 4000], ["Café", 3000], ["Harina", 6000], ["Leche", 8000], ["Sal", 2000]] as const;
  const ingredients = Object.fromEntries(await Promise.all(seed.map(async ([name, qty], index) => [name, await db.ingredient.create({ data: {
    restaurantId: restaurant.id, name, measureKind: "count", barcode: `DEF-${index}`,
    stockLevel: { create: { restaurantId: restaurant.id, qtyBase: qty, totalValueCents: qty * 10 } },
  } })] as const)));
  const balances = async () => Object.fromEntries(await Promise.all(seed.map(async ([name]) => [name, (await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: ingredients[name].id } })).qtyBase])));
  try {
    await Promise.all([page.waitForResponse((response) => response.url().endsWith("/api/auth/session") && response.ok()), page.goto("/signin")]);
    await page.getByLabel("Correo", { exact: true }).fill(user.email);
    await page.getByLabel("Contraseña", { exact: true }).fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => url.pathname === "/operator");
    await page.goto("/operator/inventario?tab=conteos");
    await page.getByRole("button", { name: "Nuevo conteo", exact: true }).click();
    await page.getByRole("button", { name: "Crear conteo", exact: true }).click();
    const scanner = page.getByLabel("Escanear código de barras", { exact: true });
    await expect(scanner).toBeFocused();

    // Primer conteo: Arroz, Azúcar y Leche cuadran; Café tiene faltante; Harina queda sin contar; Sal cuadra.
    for (const [name, value] of [["Arroz", "10"], ["Azúcar", "4"], ["Café", "2"], ["Leche", "8"], ["Sal", "2"]]) await quantity(page, name).fill(value);
    await page.getByRole("button", { name: "Ver preliminar", exact: true }).click();
    await expect(page.getByRole("button", { name: "Iniciar conteo definitivo", exact: true })).toBeVisible();
    await expect(page.getByText(/solo tendrás que recontar lo que tuvo diferencia/)).toBeVisible();

    // Entre el preliminar y el definitivo: Leche se vende (saldo distinto) y a Sal le entra y sale lo mismo (saldo igual, pero se movió).
    const now = Date.now();
    await db.stockLevel.update({ where: { ingredientId: ingredients.Leche.id }, data: { qtyBase: 7000, totalValueCents: 70_000 } });
    await db.stockMovement.create({ data: { restaurantId: restaurant.id, ingredientId: ingredients.Leche.id, kind: "sale_consumption", qtyBase: -1000, valueCents: -10_000, createdAt: new Date(now) } });
    await db.stockMovement.create({ data: { restaurantId: restaurant.id, ingredientId: ingredients.Sal.id, kind: "adjust_in", qtyBase: 500, valueCents: 5000, createdAt: new Date(now) } });
    await db.stockMovement.create({ data: { restaurantId: restaurant.id, ingredientId: ingredients.Sal.id, kind: "adjust_out", qtyBase: -500, valueCents: -5000, createdAt: new Date(now + 1) } });

    await page.getByRole("button", { name: "Iniciar conteo definitivo", exact: true }).click();
    await expect(scanner).toBeFocused();
    // Por recontar: Café (diferencia), Harina (sin contar), Leche y Sal (movimientos). Confirmados: Arroz y Azúcar.
    await expect(page.getByRole("heading", { name: "Por recontar 4", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Con diferencia 1", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sin contar 1", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Con movimientos 2", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirmados 2", exact: true })).toBeVisible();
    await expect(row(page, "Café")).toContainText("Con diferencia");
    await expect(row(page, "Harina")).toContainText("Sin contar");
    await expect(row(page, "Leche")).toContainText("Con movimientos");
    await expect(row(page, "Sal")).toContainText("Con movimientos");
    for (const name of ["Café", "Harina", "Leche", "Sal"]) await expect(quantity(page, name)).toHaveValue("");
    const confirmedGroup = page.getByRole("button", { name: /^Confirmados del preliminar 2/ });
    await expect(confirmedGroup).toHaveAttribute("aria-expanded", "false");
    await expect(rows(page)).toHaveCount(4);
    expect(await db.stockCountItem.findFirstOrThrow({ where: { ingredientId: ingredients.Arroz.id } })).toMatchObject({ countedQty: 10_000, preliminaryQty: 10_000, finalExpectedQty: 10_000 });
    expect(await db.stockCountItem.findFirstOrThrow({ where: { ingredientId: ingredients.Leche.id } })).toMatchObject({ countedQty: null, preliminaryQty: 8000, finalExpectedQty: 7000 });
    await page.screenshot({ path: testInfo.outputPath("01-definitivo-por-recontar.png") });

    // El filtro por motivo deja ver solo lo que tuvo movimientos.
    await page.getByRole("button", { name: "Con movimientos 2", exact: true }).click();
    await expect(rows(page)).toHaveCount(2);
    await page.getByRole("button", { name: "Con movimientos 2", exact: true }).click();

    // Escanear un confirmado (aunque el grupo esté plegado) lo recuenta sobre lo
    // arrastrado: sube arriba con su cantidad seleccionada, sin sumarle otra.
    await scanner.focus();
    await page.keyboard.type("DEF-1");
    await page.keyboard.press("Enter");
    await expect(quantity(page, "Azúcar")).toBeFocused();
    await expect(quantity(page, "Azúcar")).toHaveValue("4");
    expect(await quantity(page, "Azúcar").evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([0, 1]);
    await page.keyboard.type("3");
    await page.keyboard.press("Enter");
    await expect(scanner).toBeFocused();
    await expect(quantity(page, "Azúcar")).toHaveValue("3");
    await expect(page.getByLabel("Cantidad 2 de Azúcar", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Confirmados del preliminar 1/ })).toBeVisible();
    // Abrir los confirmados: ya tienen su cantidad y se pueden corregir.
    await page.getByRole("button", { name: /^Confirmados del preliminar 1/ }).click();
    await expect(quantity(page, "Arroz")).toHaveValue("10");
    await expect(row(page, "Arroz")).toContainText("Confirmado");

    // Recuento de lo pendiente.
    for (const [name, value] of [["Café", "2"], ["Harina", "6"], ["Leche", "7"], ["Sal", "2"]]) await quantity(page, name).fill(value);
    await page.getByRole("button", { name: "Revisar ajuste definitivo", exact: true }).click();
    await expect(page.getByRole("button", { name: "Confirmar y ajustar inventario", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("02-revision-final.png") });
    await page.getByRole("button", { name: "Confirmar y ajustar inventario", exact: true }).click();
    const count = await db.stockCount.findFirstOrThrow({ where: { restaurantId: restaurant.id } });
    await expect.poll(async () => (await db.stockCount.findUniqueOrThrow({ where: { id: count.id } })).status).toBe("closed");
    // Solo dos ajustes: el faltante real de Café y la corrección de Azúcar. Lo confirmado (Arroz) no se toca.
    expect(await balances()).toEqual({ Arroz: 10_000, "Azúcar": 3000, "Café": 2000, Harina: 6000, Leche: 7000, Sal: 2000 });
    const adjustments = await db.stockMovement.findMany({ where: { stockCountId: count.id }, orderBy: { qtyBase: "asc" } });
    expect(adjustments.map((movement) => [movement.ingredientId, movement.qtyBase])).toEqual([[ingredients.Azúcar.id, -1000], [ingredients.Café.id, -1000]]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await db.auditEvent.deleteMany({ where: { restaurantId: restaurant.id } });
    await db.restaurant.delete({ where: { id: restaurant.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  }
});

test("«Recontar todo» clears the confirmed items and asks to count everything again", async ({ page }) => {
  test.setTimeout(120_000);
  page.on("dialog", (dialog) => dialog.accept());
  await page.route(/^https?:\/\//, (route) => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  const token = randomUUID();
  const password = `RecountAll-${token}`;
  const restaurant = await db.restaurant.create({ data: { name: "Recontar todo QA", slug: `recount-all-${token}`, enabledModules: ["inventory"] } });
  const user = await db.user.create({ data: { email: `recount-all-${token}@example.test`, passwordHash: await bcrypt.hash(password, 10), role: "operator", restaurantId: restaurant.id } });
  for (const [name, qty] of [["Arroz", 10_000], ["Café", 3000]] as const) {
    await db.ingredient.create({ data: { restaurantId: restaurant.id, name, measureKind: "count", stockLevel: { create: { restaurantId: restaurant.id, qtyBase: qty, totalValueCents: qty } } } });
  }
  try {
    await Promise.all([page.waitForResponse((response) => response.url().endsWith("/api/auth/session") && response.ok()), page.goto("/signin")]);
    await page.getByLabel("Correo", { exact: true }).fill(user.email);
    await page.getByLabel("Contraseña", { exact: true }).fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => url.pathname === "/operator");
    await page.goto("/operator/inventario?tab=conteos");
    await page.getByRole("button", { name: "Nuevo conteo", exact: true }).click();
    await page.getByRole("button", { name: "Crear conteo", exact: true }).click();
    await quantity(page, "Arroz").fill("10");
    await quantity(page, "Café").fill("2");
    await page.getByRole("button", { name: "Ver preliminar", exact: true }).click();
    await page.getByRole("button", { name: "Iniciar conteo definitivo", exact: true }).click();
    await expect(page.getByRole("button", { name: "Confirmados 1", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Recontar todo", exact: true }).click();
    await expect(page.getByRole("button", { name: "Confirmados 0", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Por recontar 2", exact: true })).toBeVisible();
    await expect(quantity(page, "Arroz")).toHaveValue("");
    await expect(page.getByRole("button", { name: "Revisar ajuste definitivo", exact: true })).toBeDisabled();
    expect(await db.stockCountItem.count({ where: { count: { restaurantId: restaurant.id }, countedQty: { not: null } } })).toBe(0);
    expect(await db.stockMovement.count({ where: { restaurantId: restaurant.id } })).toBe(0);
  } finally {
    await db.restaurant.delete({ where: { id: restaurant.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  }
});

test.afterAll(() => db.$disconnect());
