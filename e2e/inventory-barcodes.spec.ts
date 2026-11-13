import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!["127.0.0.1", "localhost"].includes(database.hostname) || !/^\/mesapay_.*validation$/.test(database.pathname) || !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""), "Isolated local app/database required");
const db = new PrismaClient();
// Dentro del conteo, cada fila abre la misma hoja «Códigos de barras» con su botón ▥.
async function openRowCodes(page: Page, name: string) {
  await page.getByRole("button", { name: `Códigos de barras de ${name}`, exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Códigos de barras", exact: true });
  await expect(sheet).toBeVisible();
  return sheet;
}

// Existencias: los códigos se administran en la hoja «Códigos de barras»,
// que se abre desde el menú ⋯ de la fila.
const labels = {
  es: { actions: "Acciones de", item: "Códigos de barras", title: "Códigos de barras", input: "Código de barras de", close: "Cerrar" },
  en: { actions: "Actions for", item: "Barcodes", title: "Barcodes", input: "Barcode for", close: "Close" },
  pt: { actions: "Ações de", item: "Códigos de barras", title: "Códigos de barras", input: "Código de barras de", close: "Fechar" },
} as const;
async function openCodes(page: Page, name: string, locale: keyof typeof labels = "es") {
  const l = labels[locale];
  await page.getByRole("button", { name: `${l.actions} ${name}`, exact: true }).filter({ visible: true }).click();
  await page.getByRole("menuitem", { name: l.item, exact: true }).click();
  const sheet = page.getByRole("dialog", { name: l.title, exact: true });
  await expect(sheet).toBeVisible();
  return sheet;
}
async function addCode(page: Page, name: string, barcode: string) {
  const sheet = await openCodes(page, name);
  await sheet.getByRole("textbox", { name: `Código de barras de ${name}`, exact: true }).fill(barcode);
  await sheet.getByRole("button", { name: "Guardar código", exact: true }).click();
  await expect(sheet.getByRole("status")).toHaveText("Código guardado");
  await sheet.getByRole("button", { name: "Cerrar", exact: true }).click();
  await expect(sheet).toHaveCount(0);
}

test("multiple codes persist and scan without losing unsaved counts", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.route(/^https?:\/\//, (route) => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  page.on("dialog", (dialog) => dialog.accept());
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
    await addCode(page, "Agua", "abC-002");
    // La fila muestra cuántos códigos tiene.
    await expect(page.getByRole("button", { name: "2 códigos de barras · Agua", exact: true }).filter({ visible: true })).toHaveCount(page.viewportSize()!.width >= 768 ? 1 : 0);
    // Un insumo archivado no admite códigos nuevos (solo quitar).
    await page.getByRole("button", { name: /^Archivados/ }).click();
    const archivedSheet = await openCodes(page, "Archivado");
    await expect(archivedSheet.getByRole("textbox")).toHaveCount(0);
    await expect(archivedSheet).toContainText("archivado");
    await archivedSheet.getByRole("button", { name: "Cerrar", exact: true }).click();
    await page.reload();
    const saved = await openCodes(page, "Agua");
    await expect(saved).toContainText("000123");
    await expect(saved).toContainText("abC-002");
    await expect(saved.locator("li", { hasText: "000123" })).toContainText("Principal");
    await saved.getByRole("button", { name: "Cerrar", exact: true }).click();
    const group = await openCodes(page, "Arroz");
    await group.getByRole("textbox").fill("abC-002");
    await group.getByRole("button", { name: "Guardar código" }).click();
    // El aviso dice QUIÉN tiene el código y ofrece pasárselo a este insumo.
    await expect(group.getByRole("alert")).toContainText("ya lo tiene «Agua»");
    await expect(group.getByRole("button", { name: "Pasárselo a este insumo", exact: true })).toBeVisible();
    await expect(group.getByRole("textbox")).toHaveValue("abC-002");
    await group.getByRole("button", { name: "Cerrar", exact: true }).click();

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
    await expect(page.getByRole("button", { name: "Vincular a un insumo", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Crear insumo con este código", exact: true })).toBeVisible();
    // El código leído llega escrito en la hoja de códigos de la fila.
    const codes = await openRowCodes(page, "Agua");
    const newInput = codes.getByRole("textbox", { name: "Código de barras de Agua", exact: true });
    await expect(newInput).toHaveValue("New-003");
    // Failure preserves barcode draft AND quantities; retry can use Enter (HID).
    await page.route(`**/api/operator/ingredients/${water.id}/barcode`, (route) => route.abort(), { times: 1 });
    await newInput.press("Enter");
    await expect(codes.getByRole("alert")).toContainText("No se pudo guardar");
    await expect(newInput).toHaveValue("New-003");
    await expect(waterQuantity).toHaveValue("12");
    await newInput.press("Enter");
    await expect(codes.getByRole("status")).toHaveText("Código guardado");
    await codes.getByRole("button", { name: "Cerrar", exact: true }).click();
    await expect(codes).toHaveCount(0);
    // Al cerrar, el insumo queda listo para contar y se puede deshacer o corregir el vínculo.
    await expect(page.getByLabel("Cantidad 2 de Agua", { exact: true })).toBeFocused();
    await expect(page.getByText("El código New-003 quedó en «Agua».", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Deshacer", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Corregir", exact: true })).toBeVisible();
    for (const barcode of ["000123", "abC-002", "New-003"]) {
      await scanner.fill(barcode); await scanner.press("Enter");
      await expect(page.getByLabel("Cantidad 2 de Agua", { exact: true })).toBeFocused();
      await expect(page.getByLabel("Cantidad 2 de Agua", { exact: true })).toHaveValue("");
      await expect(page.getByLabel("Cantidad 3 de Agua", { exact: true })).toHaveCount(0);
      await expect(waterQuantity).toHaveValue("12");
      await expect(riceQuantity).toHaveValue("7");
    }
    await scanner.fill("Rice-001"); await scanner.press("Enter");
    await expect(page.getByLabel("Cantidad 2 de Arroz", { exact: true })).toBeFocused();
    await expect(riceQuantity).toHaveValue("7");
    await expect(page.getByRole("dialog", { name: "Conteo físico", exact: true }).getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("multiple-barcodes.png"), fullPage: true });
    await page.getByRole("button", { name: "Guardar borrador", exact: true }).click();
    await expect.poll(async () => (await db.stockCountItem.findFirst({ where: { ingredientId: water.id } }))?.countedQty).toBe(12000);
    const count = await db.stockCount.findFirstOrThrow({ where: { restaurantId: restaurant.id }, include: { items: true } });
    expect(count.items.find((item) => item.ingredientId === water.id)?.countedQty).toBe(12000);
    expect(count.items.find((item) => item.ingredientId === rice.id)?.countedQty).toBe(7000);
    const stored = await db.ingredient.findUniqueOrThrow({ where: { id: water.id }, include: { barcodes: true } });
    expect(stored.barcode).toBe("000123");
    expect(stored.barcodes.map((item) => item.barcode).sort()).toEqual(["000123", "New-003", "abC-002"]);
    expect(await db.stockMovement.count({ where: { restaurantId: restaurant.id } })).toBe(0);
    expect(await db.ingredient.findUnique({ where: { id: archived.id } })).toMatchObject({ barcode: null });

    await page.goto("/operator/inventario");
    await addCode(page, "Agua", "0".repeat(64));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("stock-barcodes.png"), fullPage: true });

    // Quitar el principal: asciende el código más antiguo que queda y el
    // quitado deja de identificar al insumo.
    const removal = await openCodes(page, "Agua");
    await removal.getByRole("button", { name: "Quitar el código 000123", exact: true }).click();
    await expect(removal.getByRole("status")).toHaveText("Código quitado");
    await expect(removal).not.toContainText("000123");
    const afterRemoval = await db.ingredient.findUniqueOrThrow({ where: { id: water.id }, include: { barcodes: true } });
    expect(afterRemoval.barcode).not.toBe("000123");
    expect(afterRemoval.barcode).not.toBeNull();
    expect(afterRemoval.barcodes.map((item) => item.barcode)).not.toContain("000123");
    expect(afterRemoval.barcodes.map((item) => item.barcode)).toContain(afterRemoval.barcode);
    await removal.getByRole("button", { name: "Cerrar", exact: true }).click();

    for (const locale of ["en", "pt"] as const) {
      await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: locale, domain: "localhost", path: "/" }]);
      await page.reload();
      const translated = await openCodes(page, "Agua", locale);
      await expect(translated.getByRole("textbox", { name: `${labels[locale].input} Agua`, exact: true })).toBeVisible();
      await expect(translated).toContainText("abC-002");
      await translated.getByRole("button", { name: labels[locale].close, exact: true }).click();
    }
  } finally {
    await db.auditEvent.deleteMany({ where: { restaurantId: restaurant.id } });
    await db.restaurant.delete({ where: { id: restaurant.id } });
    await db.user.deleteMany({ where: { id: user.id } });
  }
});
test.afterAll(async () => db.$disconnect());
