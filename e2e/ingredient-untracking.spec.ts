import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import es from "../messages/es.json";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!["localhost", "127.0.0.1"].includes(databaseUrl.hostname) || !/^\/mesapay_.*validation$/.test(databaseUrl.pathname) || !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""), "Isolated local app and validation database required");
const db = new PrismaClient();

async function setup(page: Page, width: number) {
  const token = randomUUID(), password = `Untracking-${token}`;
  const restaurant = await db.restaurant.create({ data: { name: "Inventario de prueba", slug: `untracking-${token}`, enabledModules: ["inventory"] } });
  const user = await db.user.create({ data: { email: `untracking-${token}@example.test`, passwordHash: await bcrypt.hash(password, 4), role: "platform_admin" } });
  const ingredient = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Arroz para desactivar", measureKind: "mass", stockLevel: { create: { restaurantId: restaurant.id, qtyBase: 2500, totalValueCents: 120000 } } } });
  await page.setViewportSize({ width, height: 1000 });
  await page.route(/^https?:\/\//, (route) => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.goto("/signin");
  await page.getByLabel("Correo", { exact: true }).fill(user.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"));
  await page.context().addCookies([{ name: "mesapay_act_as", value: restaurant.id, domain: "localhost", path: "/" }]);
  await page.goto("/operator/settings/insumos");
  await page.getByRole("button", { name: es.opErp.editIngredientNamed.replace("{name}", ingredient.name), exact: true }).click();
  await page.getByPlaceholder(es.opErp.namePlaceholder, { exact: true }).fill("Arroz sin inventario");
  await page.getByRole("checkbox", { name: "Llevar inventario", exact: true }).uncheck();
  return { restaurant, user, ingredient, cleanup: async () => { await db.restaurant.delete({ where: { id: restaurant.id } }); await db.user.delete({ where: { id: user.id } }); } };
}

for (const width of [390, 1440]) {
  test(`a nonzero ingredient requires explicit zeroing confirmation at ${width}px`, async ({ page }) => {
    const f = await setup(page, width);
    try {
      await page.getByRole("button", { name: es.opErp.save, exact: true }).click();
      const panel = page.getByRole("region", { name: es.opErp.stockResetTitle, exact: true });
      await expect(panel).toBeVisible();
      await expect(panel).toContainText(es.opErp.stockResetQuantity);
      await expect(panel).toContainText(es.opErp.stockResetValue);
      await expect(panel).toContainText(/2[.,]5\s*kg/);
      await expect(panel).toContainText(/1[.,]200/);
      expect(await db.ingredient.findUniqueOrThrow({ where: { id: f.ingredient.id } })).toMatchObject({ name: f.ingredient.name, trackInventory: true });
      expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: f.ingredient.id } })).toMatchObject({ qtyBase: 2500, totalValueCents: 120000 });
      expect(await db.stockMovement.count({ where: { ingredientId: f.ingredient.id } })).toBe(0);
      await panel.getByRole("button", { name: es.opErp.stockResetCancel, exact: true }).click();
      await expect(panel).toHaveCount(0);
      await expect(page.getByRole("dialog", { name: es.opErp.editIngredient, exact: true })).toBeVisible();
      await expect(page.getByPlaceholder(es.opErp.namePlaceholder, { exact: true })).toHaveValue("Arroz sin inventario");
      await expect(page.getByRole("checkbox", { name: "Llevar inventario", exact: true })).not.toBeChecked();
      expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: f.ingredient.id } })).toMatchObject({ qtyBase: 2500, totalValueCents: 120000 });
      await page.getByRole("button", { name: es.opErp.save, exact: true }).click();
      await expect(panel).toBeVisible();
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ animations: "disabled", path: test.info().outputPath(`ingredient-zero-confirm-${width}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const response = page.waitForResponse((res) => res.url().endsWith(`/api/operator/ingredients/${f.ingredient.id}`) && res.request().method() === "PATCH");
      await panel.getByRole("button", { name: es.opErp.stockResetConfirm, exact: true }).click();
      const saved = await response;
      expect(saved.ok()).toBe(true);
      await expect(page.getByRole("dialog", { name: es.opErp.editIngredient, exact: true })).toHaveCount(0);
      expect(await db.ingredient.findUniqueOrThrow({ where: { id: f.ingredient.id } })).toMatchObject({ name: "Arroz sin inventario", trackInventory: false });
      expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: f.ingredient.id } })).toMatchObject({ qtyBase: 0, totalValueCents: 0 });
      const movements = await db.stockMovement.findMany({ where: { ingredientId: f.ingredient.id } });
      expect(movements).toHaveLength(1);
      expect(movements[0]).toMatchObject({ qtyBase: -2500, valueCents: -120000, createdById: f.user.id });
      // Replay a completed request: retries must never duplicate the adjustment.
      await page.request.patch(`/api/operator/ingredients/${f.ingredient.id}`, { data: saved.request().postDataJSON() });
      expect(await db.stockMovement.count({ where: { ingredientId: f.ingredient.id } })).toBe(1);
      await page.goto("/operator/inventario");
      await page.getByRole("tab", { name: es.opErp.tabMovements, exact: true }).click();
      await expect(page.getByText(es.opErp.stockResetMovementNote, { exact: true })).toBeVisible();
      await expect(page.getByText("inventory_tracking_disabled", { exact: true })).toHaveCount(0);
    } finally { await f.cleanup(); }
  });
}

test("stock changed after preview requires a new explicit confirmation", async ({ page }) => {
  const f = await setup(page, 390);
  try {
    await page.getByRole("button", { name: es.opErp.save, exact: true }).click();
    const panel = page.getByRole("region", { name: es.opErp.stockResetTitle, exact: true });
    await expect(panel).toBeVisible();
    // Emulate a simultaneous stock receipt in this fixture, atomically updating
    // both the materialized balance and the immutable stock ledger.
    await db.$transaction([
      db.stockLevel.update({ where: { ingredientId: f.ingredient.id }, data: { qtyBase: 3500, totalValueCents: 168000 } }),
      db.stockMovement.create({ data: { restaurantId: f.restaurant.id, ingredientId: f.ingredient.id, kind: "adjust_in", qtyBase: 1000, valueCents: 48000, createdById: f.user.id, note: "Concurrent fixture receipt" } }),
    ]);
    const stale = page.waitForResponse((res) => res.url().endsWith(`/api/operator/ingredients/${f.ingredient.id}`) && res.request().method() === "PATCH");
    await panel.getByRole("button", { name: es.opErp.stockResetConfirm, exact: true }).click();
    expect((await stale).status()).toBe(409);
    await expect(page.getByText(es.opErp.stockResetChanged, { exact: true })).toBeVisible();
    await expect(panel).toContainText(/3[.,]5\s*kg/);
    await expect(panel).toContainText(/1[.,]680/);
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ animations: "disabled", path: test.info().outputPath("ingredient-zero-conflict-390.png") });
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: f.ingredient.id } })).trackInventory).toBe(true);
    expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: f.ingredient.id } })).toMatchObject({ qtyBase: 3500, totalValueCents: 168000 });
    expect(await db.stockMovement.count({ where: { ingredientId: f.ingredient.id } })).toBe(1);
    await panel.getByRole("button", { name: es.opErp.stockResetConfirm, exact: true }).click();
    await expect(page.getByRole("dialog", { name: es.opErp.editIngredient, exact: true })).toHaveCount(0);
    expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: f.ingredient.id } })).toMatchObject({ qtyBase: 0, totalValueCents: 0 });
    const movements = await db.stockMovement.findMany({ where: { ingredientId: f.ingredient.id }, orderBy: { createdAt: "asc" } });
    expect(movements).toHaveLength(2);
    expect(movements[1]).toMatchObject({ qtyBase: -3500, valueCents: -168000, createdById: f.user.id });
  } finally { await f.cleanup(); }
});

test.afterAll(() => db.$disconnect());
