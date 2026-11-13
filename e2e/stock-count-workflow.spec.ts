import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!["127.0.0.1", "localhost"].includes(databaseUrl.hostname) || !/^\/mesapay_.*validation$/.test(databaseUrl.pathname) || !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""), "Isolated local app and validation database required");
const db = new PrismaClient();
async function login(page: Page, email: string, password: string) {
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/auth/session") && response.ok()),
    page.goto("/signin"),
  ]);
  await page.getByLabel("Correo", { exact: true }).fill(email); await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.locator('button[type="submit"]').click(); await page.waitForURL((url) => url.pathname === "/admin/restaurants");
}
async function quantities(page: Page, a: string, b: string, c: string) {
  await page.getByLabel("Conteo de Botellas", { exact: true }).fill(a);
  await page.getByLabel("Conteo de Vasos", { exact: true }).fill(b);
  await page.getByLabel("Conteo de Cucharas", { exact: true }).fill(c);
}

for (const width of [390, 1440]) {
  test(`preliminary differences and confirmed recount at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(120_000); await page.setViewportSize({ width, height: 1000 });
    await page.route(/^https?:\/\//, (route) => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    const token = randomUUID(), password = `Count-${token}`;
    const restaurant = await db.restaurant.create({ data: { name: "Inventario de prueba", slug: `count-${token}`, enabledModules: ["inventory"] } });
    const user = await db.user.create({ data: { email: `count-${token}@example.test`, passwordHash: await bcrypt.hash(password, 10), role: "platform_admin" } });
    const ingredients = await Promise.all([["Botellas", 10000], ["Vasos", 5000], ["Cucharas", 3000]].map(([name, qty]) => db.ingredient.create({ data: { restaurantId: restaurant.id, name: String(name), measureKind: "count", stockLevel: { create: { restaurantId: restaurant.id, qtyBase: Number(qty), totalValueCents: Number(qty) * 10 } } } })));
    await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Servicio no inventariable", measureKind: "count", trackInventory: false } });
    const balances = async () => Promise.all(ingredients.map(async (item) => (await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: item.id } })).qtyBase));
    try {
      await login(page, user.email, password);
      await page.context().addCookies([{ name: "mesapay_act_as", value: restaurant.id, domain: "localhost", path: "/" }]);
      await page.goto("/operator/inventario");
      await page.getByRole("tab", { name: "Conteos", exact: true }).click();
      await page.getByRole("button", { name: "Nuevo conteo", exact: true }).click();
      await page.getByRole("button", { name: "Crear conteo", exact: true }).click();
      await expect(page.getByLabel("Conteo de Botellas", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Conteo de Servicio no inventariable", { exact: true })).toHaveCount(0);
      // Los filtros llevan su contador: «Pendientes 3».
      await page.getByRole("button", { name: /^Pendientes \d+$/ }).click();
      const firstQuantity = page.getByLabel("Conteo de Botellas", { exact: true });
      await firstQuantity.pressSequentially("18");
      await expect(firstQuantity).toBeVisible(); await expect(firstQuantity).toHaveValue("18");
      await quantities(page, "8", "6", "3");
      await page.getByRole("button", { name: /^Todos \d+$/ }).click();

      // «Guardar borrador» guarda, CIERRA la hoja y avisa en la página; el
      // borrador se retoma con «Continuar» con lo guardado y sin preguntar nada.
      let asked = 0;
      page.on("dialog", (dialog) => { asked++; void dialog.accept(); });
      await page.getByRole("button", { name: "Guardar borrador", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Conteo físico", exact: true })).toHaveCount(0);
      await expect(page.getByRole("status").filter({ hasText: "Borrador guardado." })).toBeVisible();
      expect(asked).toBe(0);
      expect((await db.stockCountItem.findFirstOrThrow({ where: { ingredientId: ingredients[0].id } })).countedQty).toBe(8000);
      expect(await db.stockMovement.count({ where: { restaurantId: restaurant.id } })).toBe(0);
      await page.locator("#inv-panel-counts").getByRole("button", { name: /Abrir el conteo|3 insumos/ }).filter({ visible: true }).first().click();
      await expect(page.getByLabel("Conteo de Botellas", { exact: true })).toHaveValue("8");
      await expect(page.getByLabel("Conteo de Vasos", { exact: true })).toHaveValue("6");
      await page.getByRole("button", { name: "Ver preliminar", exact: true }).click();
      await expect(page.getByRole("button", { name: "Iniciar conteo definitivo", exact: true })).toBeVisible();
      for (const label of ["Faltantes", "Sobrantes", "Sin diferencias", "Pendientes"]) await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
      expect(await balances()).toEqual([10000, 5000, 3000]);
      expect(await db.stockMovement.count({ where: { restaurantId: restaurant.id } })).toBe(0);
      const count = await db.stockCount.findFirstOrThrow({ where: { restaurantId: restaurant.id }, include: { items: true } });
      expect(count.preliminaryAt).not.toBeNull();
      expect(count.items.find((item) => item.ingredientId === ingredients[0].id)?.preliminaryQty).toBe(8000);
      await page.screenshot({ path: testInfo.outputPath(`conteo-preliminar-${width}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      // Resume a persisted preliminary report after navigating away.
      await page.reload(); await page.getByRole("tab", { name: "Conteos", exact: true }).click();
      await page.locator("#inv-panel-counts").getByRole("button", { name: /Abrir el conteo|3 insumos/ }).filter({ visible: true }).first().click();
      await page.getByRole("button", { name: "Iniciar conteo definitivo", exact: true }).click();
      await expect(page.getByLabel("Conteo de Botellas", { exact: true })).toHaveValue("");
      await expect(page.getByLabel("Conteo de Vasos", { exact: true })).toHaveValue("");
      // Solo se recuenta lo que tuvo diferencia: Cucharas cuadró (3 = 3) y no se
      // movió, así que queda confirmada con su cantidad, plegada al final.
      await expect(page.getByRole("heading", { name: "Por recontar 2", exact: true })).toBeVisible();
      const confirmedGroup = page.getByRole("button", { name: /^Confirmados del preliminar 1/ });
      await expect(confirmedGroup).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByLabel("Conteo de Cucharas", { exact: true })).toHaveCount(0);
      await confirmedGroup.click();
      await expect(page.getByLabel("Conteo de Cucharas", { exact: true })).toHaveValue("3");
      await page.getByLabel("Conteo de Botellas", { exact: true }).fill("9");
      await page.getByLabel("Conteo de Vasos", { exact: true }).fill("0");
      await page.getByRole("button", { name: "Revisar ajuste definitivo", exact: true }).click();
      await expect(page.getByRole("button", { name: "Confirmar y ajustar inventario", exact: true })).toBeVisible();
      expect(await balances()).toEqual([10000, 5000, 3000]);
      expect(await db.stockMovement.count({ where: { restaurantId: restaurant.id } })).toBe(0);
      await page.getByRole("button", { name: "Corregir conteo definitivo", exact: true }).click();
      await expect(page.getByLabel("Conteo de Botellas", { exact: true })).toHaveValue("9");
      await page.getByLabel("Conteo de Botellas", { exact: true }).fill("9.25");
      await expect(page.getByRole("button", { name: "Confirmar y ajustar inventario", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Revisar ajuste definitivo", exact: true }).click();
      await expect(page.getByRole("button", { name: "Confirmar y ajustar inventario", exact: true })).toBeVisible();
      expect(await balances()).toEqual([10000, 5000, 3000]);
      await page.screenshot({ path: testInfo.outputPath(`conteo-definitivo-${width}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.getByRole("button", { name: "Confirmar y ajustar inventario", exact: true }).click();
      await expect.poll(async () => (await db.stockCount.findUniqueOrThrow({ where: { id: count.id } })).status).toBe("closed");
      expect(await balances()).toEqual([9250, 0, 3000]);
      expect(await db.stockMovement.count({ where: { stockCountId: count.id } })).toBe(2);
      const items = await db.stockCountItem.findMany({ where: { countId: count.id } });
      expect(items.find((item) => item.ingredientId === ingredients[0].id)).toMatchObject({ expectedQty: 10000, preliminaryQty: 8000, finalExpectedQty: 10000, countedQty: 9250 });
      await expect(page.getByRole("button", { name: "Confirmar y ajustar inventario", exact: true })).toHaveCount(0);
    } finally { await db.restaurant.delete({ where: { id: restaurant.id } }); await db.user.delete({ where: { id: user.id } }); }
  });
}

test.afterAll(async () => { await db.$disconnect(); });
