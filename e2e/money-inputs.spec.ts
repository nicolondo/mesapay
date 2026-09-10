import { test, expect, type Locator } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import en from "../messages/en.json";
import pt from "../messages/pt.json";
const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/mesapay_.*validation$/.test(url.pathname) || !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""), "Isolated local app required");
const db = new PrismaClient();
async function paste(input: Locator, text: string) {
  await input.selectText();
  await input.evaluate((el, text) => {
    const data = new DataTransfer(); data.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: data }));
  }, text);
}
for (const width of [390, 1440]) {
  test(`money entry, cursor and persisted amounts at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    const id = randomUUID(), email = `money-${id}@example.test`, password = `Fixture-${id}`;
    const restaurant = await db.restaurant.create({ data: { name: "Fixture precios", slug: `money-${id}` } });
    const user = await db.user.create({ data: { email, passwordHash: await bcrypt.hash(password, 10), role: "platform_admin" } });
    const category = await db.category.create({ data: { restaurantId: restaurant.id, label: "Bebidas", slug: "bebidas" } });
    try {
      await page.goto("/signin");
      await page.getByLabel("Correo", { exact: true }).fill(email);
      await page.getByLabel("Contraseña", { exact: true }).fill(password);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL(u => !u.pathname.startsWith("/signin"));
      await page.context().addCookies([{ name: "mesapay_act_as", value: restaurant.id, domain: "localhost", path: "/" }]);
      await page.goto("/operator/menu");
      await page.getByRole("button", { name: "+ Producto", exact: true }).click();
      await page.getByRole("textbox", { name: "Nombre", exact: true }).fill("Producto de prueba");
      const price = page.getByRole("textbox", { name: "Precio (COP)", exact: true });
      await price.pressSequentially("25000");
      await expect(price).toHaveValue("25.000");
      await price.press("Home"); await price.press("ArrowRight"); await price.press("ArrowRight");
      await price.pressSequentially("1");
      await expect(price).toHaveValue("251.000");
      await price.press("Backspace");
      await expect(price).toHaveValue("25.000");
      await price.press("Home"); await price.press("ArrowRight"); await price.press("ArrowRight"); await price.press("ArrowRight");
      await price.press("Backspace");
      await expect(price).toHaveValue("2.000");
      await paste(price, "$ 25.000,50");
      await expect(price).toHaveValue("25.000,50");
      await paste(price, "1e6");
      await expect(price).toHaveValue("25.000,50");
      await price.fill("");
      await price.pressSequentially("25.000,50"); // typed grouping remains grouping
      await expect(price).toHaveValue("25.000,50");
      await page.getByRole("button", { name: "Crear producto", exact: true }).click();
      await expect.poll(() => db.menuItem.count({ where: { restaurantId: restaurant.id } })).toBe(1);
      const dish = await db.menuItem.findFirstOrThrow({ where: { restaurantId: restaurant.id } });
      expect(dish.priceCents).toBe(2500050);
      await db.menuItem.update({ where: { id: dish.id }, data: { modifiers: [{ id: "size", label: "Tamaño", type: "radio", opts: [{ label: "Pequeño", priceDeltaCents: 125000 }] }] } });
      await page.reload();
      await page.getByText("Producto de prueba", { exact: true }).first().click();
      await expect(price).toHaveValue("25.000,5");
      const extra = page.getByTitle("Costo adicional (COP). Vacío = sin recargo.", { exact: true });
      await extra.fill("");
      await extra.pressSequentially("-2500,50");
      await expect(extra).toHaveValue("-2.500,50");
      await price.fill("1250000");
      await expect(price).toHaveValue("1.250.000");
      await page.screenshot({ path: `/Users/nicolas/Documents/Codex/2026-09-08/files-mentioned-by-the-user-scr/UI-UX-MESAPAY/precios-miles-${width}.png`, fullPage: true });
      await page.getByRole("button", { name: "Guardar", exact: true }).click();
      await expect.poll(async () => (await db.menuItem.findUniqueOrThrow({ where: { id: dish.id } })).priceCents).toBe(125000000);
      const saved = await db.menuItem.findUniqueOrThrow({ where: { id: dish.id } });
      expect((saved.modifiers as { opts: { priceDeltaCents: number }[] }[])[0].opts[0].priceDeltaCents).toBe(-250050);
      for (const [locale, catalog, typed, expected] of [["en", en, "12500.50", "12,500.50"], ["pt", pt, "12500,50", "12.500,50"]] as const) {
        await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: locale, domain: "localhost", path: "/" }]);
        await page.goto("/operator/menu");
        await page.getByText("Producto de prueba", { exact: true }).first().click();
        const localizedPrice = page.getByRole("textbox", { name: catalog.opMenuEditor.fieldPrice, exact: true });
        await localizedPrice.fill("");
        await localizedPrice.pressSequentially(typed);
        await expect(localizedPrice).toHaveValue(expected);
      }
      await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: "es", domain: "localhost", path: "/" }]);
      // Same shared input in a previously grouped admin surface, without saving.
      await page.goto("/admin/plans");
      const planAmount = page.locator('input[inputmode="numeric"]').first();
      await planAmount.fill("1250000");
      await expect(planAmount).toHaveValue("1.250.000");
      await paste(planAmount, "25.000,50"); // integer fields reject cents, never multiply them
      await expect(planAmount).toHaveValue("1.250.000");
    } finally {
      await db.restaurant.delete({ where: { id: restaurant.id } });
      await db.user.delete({ where: { id: user.id } });
    }
  });
}
test.afterAll(() => db.$disconnect());
