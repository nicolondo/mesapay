import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import es from "../messages/es.json";
import en from "../messages/en.json";
import pt from "../messages/pt.json";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(
  !["127.0.0.1", "localhost"].includes(databaseUrl.hostname) ||
  !/^\/mesapay_.*validation$/.test(databaseUrl.pathname) ||
  !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""),
  "Isolated local app and validation database required",
);
const db = new PrismaClient();
const messages = { es, en, pt };

async function fixture() {
  const token = randomUUID();
  const restaurant = await db.restaurant.create({ data: { name: "Carta de prueba", slug: `diner-${token}` } });
  const table = await db.table.create({ data: { restaurantId: restaurant.id, number: 1, qrToken: token } });
  const category = await db.category.create({ data: { restaurantId: restaurant.id, label: "Bebidas", slug: "bebidas" } });
  const water = await db.menuItem.create({ data: { restaurantId: restaurant.id, categoryId: category.id, name: "Agua de prueba", description: "Agua mineral sin gas de la carta de prueba.", priceCents: 500000 } });
  await db.menuItem.create({ data: { restaurantId: restaurant.id, categoryId: category.id, name: "Café de prueba", description: "Café recién preparado.", priceCents: 700000 } });
  return { restaurant, table, water, menu: `/t/${restaurant.slug}/menu`, qr: `/t/${restaurant.slug}/menu?table=${token}` };
}

async function prepare(page: Page, width = 390) {
  await page.setViewportSize({ width, height: 1000 });
  await page.route(/^https?:\/\//, (route) => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
}

async function identify(page: Page, locale: keyof typeof messages = "es") {
  const t = messages[locale].menu;
  const dialog = page.getByRole("dialog", { name: t.whatToCallYou, exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: t.namePlaceholder, exact: true }).fill("Nicolás de prueba");
  await dialog.getByRole("button", { name: t.save, exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

for (const width of [390, 1440]) {
  test(`QR asks the name immediately, remembers it and guides the cart at ${width}px`, async ({ page }) => {
    const f = await fixture();
    try {
      await prepare(page, width);
      await page.goto(f.qr);
      await expect(page.getByRole("dialog", { name: es.menu.whatToCallYou, exact: true })).toBeVisible();
      await page.screenshot({ animations: "disabled", path: test.info().outputPath(`initial-name-${width}.png`) });
      await identify(page);
      expect(await page.evaluate((key) => localStorage.getItem(key), `mesapay.guestName.${f.table.id}`)).toBe("Nicolás de prueba");
      await page.reload();
      await expect(page.getByRole("button", { name: /Nicolás de prueba/ })).toBeVisible();
      await expect(page.getByRole("dialog", { name: es.menu.whatToCallYou })).toHaveCount(0);
      await page.locator(`#menu-item-${f.water.id}`).getByRole("button", { name: es.menu.addToOrder, exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Agregado al carrito" })).toBeVisible();
      await expect(page.getByRole("button", { name: /Ver y enviar pedido/ })).toBeInViewport();
      await page.screenshot({ animations: "disabled", path: test.info().outputPath(`cart-guidance-${width}.png`) });
      await page.getByRole("button", { name: /Ver y enviar pedido/ }).click();
      await expect(page.getByRole("button", { name: es.menu.sendToKitchen, exact: true })).toBeVisible();
      await expect(page.getByRole("dialog", { name: es.menu.whatToCallYou })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // Reviewing a cart must not create or send any order.
      expect(await db.order.count({ where: { restaurantId: f.restaurant.id } })).toBe(0);
      const sent = page.waitForResponse((response) => response.url().endsWith(`/api/tenant/${f.restaurant.slug}/orders`) && response.request().method() === "POST");
      await page.getByRole("button", { name: es.menu.sendToKitchen, exact: true }).click();
      expect((await sent).ok()).toBe(true);
      await expect(page).toHaveURL(new RegExp(`/t/${f.restaurant.slug}/order/`));
      const order = await db.order.findFirstOrThrow({ where: { restaurantId: f.restaurant.id }, include: { items: true } });
      expect(order.items).toHaveLength(1);
      expect(order.items[0]).toMatchObject({ menuItemId: f.water.id, qty: 1, guestName: "Nicolás de prueba" });
      await page.goto(f.qr);
      await page.locator(`#menu-item-${f.water.id}`).getByRole("button", { name: es.menu.addToOrder, exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Agregado al carrito" })).toBeVisible();
      await expect(page.getByRole("button", { name: /Ver y enviar pedido/ })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ animations: "disabled", path: test.info().outputPath(`active-order-cart-${width}.png`) });
      expect(await db.order.count({ where: { restaurantId: f.restaurant.id } })).toBe(1);
    } finally { await db.restaurant.delete({ where: { id: f.restaurant.id } }); }
  });

  test(`public menu supports browsing, search and details without ordering at ${width}px`, async ({ page }) => {
    const f = await fixture();
    try {
      await prepare(page, width);
      for (const path of [f.menu, `${f.qr}&browse=1`]) {
        await page.goto(path);
        await expect(page.getByText("Solo ver la carta", { exact: true }).first()).toBeVisible();
        await expect(page.getByRole("dialog", { name: es.menu.whatToCallYou })).toHaveCount(0);
        await expect(page.getByRole("button", { name: es.menu.addToOrder, exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: /mesero/i })).toHaveCount(0);
        await expect(page.getByRole("button", { name: /Ver y enviar pedido/ })).toHaveCount(0);
        for (const layout of [es.menu.layoutList, es.menu.layoutGrid, es.menu.layoutEditorial]) {
          await page.getByRole("button", { name: layout, exact: true }).click();
          await page.getByRole("searchbox", { name: es.menu.searchPlaceholder, exact: true }).fill("agua");
          await expect(page.locator(`#menu-item-${f.water.id}`)).toBeVisible();
          await expect(page.getByText("Café de prueba", { exact: true })).toHaveCount(0);
          await page.locator(`#menu-item-${f.water.id}`).getByRole("button").first().click();
          await expect(page.getByRole("heading", { name: f.water.name, exact: true })).toBeVisible();
          await expect(page.getByRole("button", { name: /Añadir|Marchar|Ver y enviar/ })).toHaveCount(0);
          await page.screenshot({ animations: "disabled", path: test.info().outputPath(`browse-detail-${layout}-${width}.png`) });
          await page.getByRole("button", { name: es.menu.close, exact: true }).click();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        }
      }
      expect(await db.order.count({ where: { restaurantId: f.restaurant.id } })).toBe(0);
      expect((await db.table.findUniqueOrThrow({ where: { id: f.table.id } })).waiterCalledAt).toBeNull();
    } finally { await db.restaurant.delete({ where: { id: f.restaurant.id } }); }
  });
}

test("diner pages omit installation metadata while staff retains a manifest", async ({ page }) => {
  const f = await fixture();
  try {
    await prepare(page);
    for (const path of [`/t/${f.restaurant.slug}`, f.menu, f.qr, `/p/${f.restaurant.slug}`]) {
      await page.goto(path);
      await expect(page.locator('link[rel="manifest"]')).toHaveCount(0);
      await expect(page.getByRole("button", { name: /instalar/i })).toHaveCount(0);
    }
    await page.goto("/signin");
    await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
  } finally { await db.restaurant.delete({ where: { id: f.restaurant.id } }); }
});

test("blocked localStorage does not prevent naming or adding to the cart", async ({ page }) => {
  const f = await fixture();
  try {
    await prepare(page);
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", { get: () => { throw new DOMException("Storage blocked", "SecurityError"); } });
    });
    await page.goto(f.qr);
    await identify(page);
    await page.locator(`#menu-item-${f.water.id}`).getByRole("button", { name: es.menu.addToOrder, exact: true }).click();
    await expect(page.getByRole("button", { name: /Ver y enviar pedido/ })).toBeVisible();
  } finally { await db.restaurant.delete({ where: { id: f.restaurant.id } }); }
});

test("initial prompt can browse and resume ordering through client navigation", async ({ page }) => {
  const f = await fixture();
  try {
    await prepare(page);
    await page.goto(f.qr);
    const dialog = page.getByRole("dialog", { name: es.menu.whatToCallYou, exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Solo ver la carta", exact: true }).click();
    await expect(page).toHaveURL(/browse=1/);
    await expect(page.getByRole("button", { name: es.menu.addToOrder, exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Hacer un pedido", exact: true }).click();
    await expect(page).not.toHaveURL(/browse=1/);
    await identify(page);
    await page.locator(`#menu-item-${f.water.id}`).getByRole("button", { name: es.menu.addToOrder, exact: true }).click();
    await expect(page.getByRole("button", { name: /Ver y enviar pedido/ })).toBeVisible();
    // Entering the read-only link must not render a previously saved cart.
    await page.goto(`${f.qr}&browse=1`);
    await expect(page.getByRole("button", { name: /Ver y enviar pedido/ })).toHaveCount(0);
    await page.getByRole("link", { name: "Hacer un pedido", exact: true }).click();
    await expect(page.getByRole("button", { name: /Ver y enviar pedido/ })).toBeVisible();
    await expect(dialog).toHaveCount(0);
    expect(await db.order.count({ where: { restaurantId: f.restaurant.id } })).toBe(0);
  } finally { await db.restaurant.delete({ where: { id: f.restaurant.id } }); }
});

for (const locale of ["en", "pt"] as const) {
  test(`initial name and browse mode are translated in ${locale}`, async ({ page }) => {
    const f = await fixture();
    try {
      await prepare(page);
      await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: locale, domain: "localhost", path: "/" }]);
      await page.goto(f.qr);
      await identify(page, locale);
      await page.goto(f.menu);
      await expect(page.getByText(messages[locale].menu.browseOnlyLabel, { exact: true })).toBeVisible();
      await expect(page.getByRole("searchbox", { name: messages[locale].menu.searchPlaceholder, exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: messages[locale].menu.addToOrder, exact: true })).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
    } finally { await db.restaurant.delete({ where: { id: f.restaurant.id } }); }
  });
}

test.afterAll(() => db.$disconnect());
