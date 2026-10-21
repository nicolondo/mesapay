import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!["127.0.0.1", "localhost"].includes(database.hostname) || !/^\/mesapay_.*validation$/.test(database.pathname) || !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""), "Isolated local app/database required");
const db = new PrismaClient();
const area = (page: Page, name: string) => page.getByRole("group", { name: `Códigos de barras de ${name}`, exact: true }).filter({ visible: true });
async function addCode(page: Page, name: string, barcode: string, additional = false) {
  const group = area(page, name);
  await group.getByRole("button", { name: additional ? "Agregar otro código" : "Agregar código de barras", exact: true }).click();
  await group.getByRole("textbox", { name: `Código de barras de ${name}`, exact: true }).fill(barcode);
  await group.getByRole("button", { name: "Guardar código", exact: true }).click();
  await expect(group.getByRole("status")).toHaveText("Código guardado");
}

test("multiple codes persist and scan without losing unsaved counts", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.route(/^https?:\/\//, (route) => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  const token = randomUUID(), password = `Barcode-${token}`;
  const restaurant = await db.restaurant.create({ data: { name: "Barcodes QA", slug: `barcode-${token}`, enabledModules: ["inventory"] } });
  const user = await db.user.create({ data: { email: `barcode-${token}@example.test`, passwordHash: await bcrypt.hash(password, 10), role: "operator", restaurantId: restaurant.id } });
  const water = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Agua", measureKind: "count" } });
  const rice = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Arroz", measureKind: "count", barcode: "Rice-001" } });
  const archived = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Archivado", measureKind: "count", active: false, stockLevel: { create: { restaurantId: restaurant.id, qtyBase: 1000 } } } });
  try {
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/auth/session") && response.ok()),
      page.goto("/signin"),
    ]);
    await page.getByLabel("Correo", { exact: true }).fill(user.email);
    await page.getByLabel("Contraseña", { exact: true }).fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => url.pathname === "/operator");
    await page.goto("/operator/inventario");
    await addCode(page, "Agua", "000123");
    await addCode(page, "Agua", "abC-002", true);
    await expect(area(page, "Archivado").getByRole("button")).toHaveCount(0);
    await page.reload();
    await expect(area(page, "Agua")).toContainText("000123");
    await expect(area(page, "Agua")).toContainText("abC-002");
    const group = area(page, "Arroz");
    await group.getByRole("button", { name: "Agregar otro código" }).click();
    await group.getByRole("textbox").fill("abC-002");
    await group.getByRole("button", { name: "Guardar código" }).click();
    await expect(group.getByRole("alert")).toContainText("otro producto");
    await expect(group.getByRole("textbox")).toHaveValue("abC-002");
    await group.getByRole("button", { name: "Cancelar", exact: true }).click();

    await page.getByRole("tab", { name: "Conteos", exact: true }).click();
    await page.getByRole("button", { name: "Nuevo conteo", exact: true }).click();
    await page.getByRole("button", { name: "Crear conteo", exact: true }).click();
    const waterQuantity = page.getByLabel("Conteo de Agua", { exact: true });
    const riceQuantity = page.getByLabel("Conteo de Arroz", { exact: true });
    await waterQuantity.fill("12");
    await riceQuantity.fill("7");
    const scanner = page.getByLabel("Escanear código de barras", { exact: true });
    await scanner.fill("New-003"); await scanner.press("Enter");
    await expect(page.getByText(/New-003.*no está/)).toBeVisible();
    await area(page, "Agua").getByRole("button", { name: "Agregar otro código" }).click();
    const newInput = area(page, "Agua").getByRole("textbox");
    await expect(newInput).toHaveValue("New-003");
    // Failure preserves barcode draft AND quantities; retry can use Enter (HID).
    await page.route(`**/api/operator/ingredients/${water.id}/barcode`, (route) => route.abort(), { times: 1 });
    await newInput.press("Enter");
    await expect(area(page, "Agua").getByRole("alert")).toContainText("No se pudo guardar");
    await expect(newInput).toHaveValue("New-003");
    await expect(waterQuantity).toHaveValue("12");
    await newInput.press("Enter");
    await expect(area(page, "Agua").getByRole("status")).toHaveText("Código guardado");
    for (const barcode of ["000123", "abC-002", "New-003"]) {
      await scanner.fill(barcode); await scanner.press("Enter");
      await expect(waterQuantity).toBeFocused();
      await expect(waterQuantity).toHaveValue("12");
      await expect(riceQuantity).toHaveValue("7");
    }
    await scanner.fill("Rice-001"); await scanner.press("Enter");
    await expect(riceQuantity).toBeFocused();
    await expect(area(page, "Agua").getByRole("alert")).toHaveCount(0);
    await expect(area(page, "Arroz").getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("multiple-barcodes.png"), fullPage: true });
    await page.getByRole("button", { name: "Guardar borrador", exact: true }).click();
    await expect.poll(async () => (await db.stockCountItem.findFirst({ where: { ingredientId: water.id } }))?.countedQty).toBe(12000);
    const count = await db.stockCount.findFirstOrThrow({ where: { restaurantId: restaurant.id }, include: { items: true } });
    expect(count.items.find((item) => item.ingredientId === water.id)?.countedQty).toBe(12000);
    expect(count.items.find((item) => item.ingredientId === rice.id)?.countedQty).toBe(7000);
    const saved = await db.ingredient.findUniqueOrThrow({ where: { id: water.id }, include: { barcodes: true } });
    expect(saved.barcode).toBe("000123");
    expect(saved.barcodes.map((item) => item.barcode).sort()).toEqual(["000123", "New-003", "abC-002"]);
    expect(await db.stockMovement.count({ where: { restaurantId: restaurant.id } })).toBe(0);
    expect(await db.ingredient.findUnique({ where: { id: archived.id } })).toMatchObject({ barcode: null });
    await page.goto("/operator/inventario");
    await addCode(page, "Agua", "0".repeat(64), true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("stock-barcodes.png"), fullPage: true });
    for (const [locale, groupLabel, addLabel] of [["en", "Barcodes for Agua", "Add another code"], ["pt", "Códigos de barras de Agua", "Adicionar outro código"]]) {
      await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: locale, domain: "localhost", path: "/" }]);
      await page.reload();
      const translated = page.getByRole("group", { name: groupLabel, exact: true }).filter({ visible: true });
      await expect(translated.getByRole("button", { name: addLabel, exact: true })).toBeVisible();
      await expect(translated).toContainText("abC-002");
    }
  } finally {
    await db.auditEvent.deleteMany({ where: { restaurantId: restaurant.id } });
    await db.restaurant.delete({ where: { id: restaurant.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  }
});
test.afterAll(async () => db.$disconnect());
