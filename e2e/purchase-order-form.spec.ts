import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import es from "../messages/es.json";

/**
 * «Nueva orden de compra» rápida: en escritorio, la tabla que se llena con
 * el teclado (Enter = otra línea, Retroceso en una línea vacía = quitarla),
 * el precio y el impuesto recordados del proveedor, el aviso de insumo
 * repetido y el descuento de la línea que llega al servidor; en el celular,
 * las tarjetas y la hoja «Agregar producto».
 */
const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!["localhost", "127.0.0.1"].includes(databaseUrl.hostname) || !/^\/mesapay_.*validation$/.test(databaseUrl.pathname) || !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""), "Isolated local app and validation database required");
const db = new PrismaClient();
const t = es.opErp;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const startsWith = (label: string) => new RegExp(`^${escape(label)}`);
test.use({ actionTimeout: 10_000 });

async function setup(page: Page) {
  const token = randomUUID(), password = `Orders-${token}`;
  const clientHeaders = { "x-real-ip": `127.3.${parseInt(token.slice(0, 2), 16)}.${parseInt(token.slice(2, 4), 16)}` };
  await page.setExtraHTTPHeaders(clientHeaders);
  await page.route(/^https?:\/\//, route => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  const restaurant = await db.restaurant.create({ data: { name: "Compras rápidas", slug: `po-form-${token}`, country: "CO", enabledModules: ["inventory", "purchasing"] } });
  const user = await db.user.create({ data: { email: `po-form-${token}@example.test`, passwordHash: await bcrypt.hash(password, 4), role: "operator", restaurantId: restaurant.id } });
  const supplier = await db.supplier.create({ data: { restaurantId: restaurant.id, name: "Abarrotes de prueba" } });
  const flour = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Harina de prueba", measureKind: "mass" } });
  const sugar = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Azúcar de prueba", measureKind: "mass" } });
  const sack = await db.supplierIngredient.create({ data: { supplierId: supplier.id, ingredientId: flour.id, presentationLabel: "Bulto 50 kg", contentQty: 50_000, lastPriceCents: 18_000_000 } });
  // Orden anterior: 500 g de azúcar a $2.000 (= $4.000/kg) con IVA 19 %.
  await db.purchaseOrder.create({
    data: {
      restaurantId: restaurant.id, supplierId: supplier.id, number: 1,
      items: { create: [{ ingredientId: sugar.id, qtyOrderedBase: 500, expectedCostCents: 200_000, listCostCents: 200_000, taxPct: 19 }] },
    },
  });
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  await page.request.post("/api/auth/callback/credentials", {
    headers: { ...clientHeaders, "X-Auth-Return-Redirect": "1" },
    form: { csrfToken: csrf.csrfToken, email: user.email, password, callbackUrl: `${process.env.PLAYWRIGHT_BASE_URL}/operator/compras` },
  });
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(user.id);
  return { restaurant, supplier, flour, sugar, sack, cleanup: async () => {
    await db.auditEvent.deleteMany({ where: { restaurantId: restaurant.id } });
    await db.purchaseOrder.deleteMany({ where: { restaurantId: restaurant.id } });
    await db.supplierIngredient.deleteMany({ where: { supplierId: supplier.id } });
    await db.supplier.deleteMany({ where: { restaurantId: restaurant.id } });
    await db.ingredient.deleteMany({ where: { restaurantId: restaurant.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.restaurant.delete({ where: { id: restaurant.id } });
  } };
}

async function openForm(page: Page, supplierName: string) {
  await page.goto("/operator/compras");
  await page.locator("#operator-content").getByRole("button", { name: t.newOrder, exact: true }).click();
  await page.getByRole("combobox", { name: t.fieldSupplier, exact: true }).fill(supplierName);
  await page.getByRole("option", { name: new RegExp(`^${escape(supplierName)}`) }).click();
}

test("desktop: the order is entered with the keyboard and reaches the server as shown", async ({ page, isMobile }) => {
  test.skip(isMobile, "keyboard table is the desktop layout");
  const f = await setup(page);
  try {
    await openForm(page, f.supplier.name);
    const table = page.getByTestId("oc-lines-table");
    await expect(table.getByRole("combobox", { name: t.ocItemOfLine.replace("{n}", "1") })).toBeFocused();

    // Línea 1: la presentación del proveedor, con su último precio.
    await page.keyboard.type("Harina");
    await page.keyboard.press("Enter");
    const qty1 = table.getByRole("textbox", { name: `${t.fieldQty} · ${f.flour.name}` });
    await expect(qty1).toBeFocused();
    await expect(table.getByRole("combobox", { name: `${t.ocColUnit} · ${f.flour.name}` })).toHaveValue("pres");
    await page.keyboard.type("2");
    await page.keyboard.press("Enter");

    // Línea 2: recuerda kg, el precio por kg y el IVA de la última orden.
    await expect(table.getByRole("combobox", { name: t.ocItemOfLine.replace("{n}", "2") })).toBeFocused();
    await page.keyboard.type("Azú");
    await page.keyboard.press("Enter");
    await expect(table.getByRole("textbox", { name: `${t.ocColPrice} · ${f.sugar.name}` })).toHaveValue("4.000");
    await expect(table.getByRole("combobox", { name: `${t.poTaxLabel} · ${f.sugar.name}` })).toHaveValue("iva:19");
    await page.keyboard.type("3");
    await page.keyboard.press("Enter");

    // Una línea vacía se quita con Retroceso.
    await page.keyboard.press("Backspace");
    await expect(table.locator("tbody")).toHaveCount(2);

    // Insumo repetido: se ofrece sumarlo a la línea 1.
    await page.getByRole("button", { name: t.ocAddProduct, exact: true }).click();
    await page.keyboard.type("Harina");
    await page.keyboard.press("Enter");
    await page.keyboard.type("1");
    await table.getByRole("button", { name: t.ocDupMerge.replace("{n}", "1"), exact: true }).click();
    await expect(table.locator("tbody")).toHaveCount(2);
    await expect(qty1).toHaveValue("3");

    // Descuento de la línea: 10 %.
    await table.getByRole("textbox", { name: `${t.discountLabel} · ${f.flour.name}` }).fill("10");
    await expect(page.getByTestId("oc-total")).toHaveText(/500\.280/); // 540.000 − 54.000 + 12.000 + IVA 2.280
    const created = page.waitForResponse(r => r.url().endsWith("/api/operator/purchase-orders") && r.request().method() === "POST");
    await page.keyboard.press("Control+Enter");
    expect((await created).status()).toBe(201);

    const order = await db.purchaseOrder.findFirstOrThrow({ where: { restaurantId: f.restaurant.id, number: 2 }, include: { items: true } });
    const flour = order.items.find(i => i.ingredientId === f.flour.id)!;
    const sugar = order.items.find(i => i.ingredientId === f.sugar.id)!;
    expect(flour).toMatchObject({ supplierItemId: f.sack.id, presentations: 3, listCostCents: 54_000_000, discountPct: 10, discountCents: 5_400_000, expectedCostCents: 48_600_000 });
    expect(sugar).toMatchObject({ qtyOrderedBase: 3000, expectedCostCents: 1_200_000, taxPct: 19 });
    expect(order.discountCents).toBe(5_400_000);
  } finally { await f.cleanup(); }
});

test("desktop: cells say what is wrong and saving goes to the first problem", async ({ page, isMobile }) => {
  test.skip(isMobile, "keyboard table is the desktop layout");
  const f = await setup(page);
  try {
    await openForm(page, f.supplier.name);
    const table = page.getByTestId("oc-lines-table");
    await expect(table.getByRole("combobox", { name: t.ocItemOfLine.replace("{n}", "1") })).toBeFocused();
    await page.keyboard.type("Harina");
    await page.keyboard.press("Enter");
    await page.keyboard.type("1,5");
    await page.keyboard.press("Tab");
    await expect(table.getByText(t.ocErrQtyWhole)).toBeVisible();
    await page.getByTestId("oc-submit").click();
    await expect(page.getByRole("alert").filter({ hasText: t.ocErrFixLines.replace(/\{count, plural, one \{([^}]*)\}.*$/, "$1") })).toBeVisible();
    await expect(table.getByRole("textbox", { name: `${t.fieldQty} · ${f.flour.name}` })).toBeFocused();
    expect(await db.purchaseOrder.count({ where: { restaurantId: f.restaurant.id } })).toBe(1);
  } finally { await f.cleanup(); }
});

test("phone: products are added from a sheet and shown as compact cards", async ({ page, isMobile }) => {
  test.skip(!isMobile, "cards are the phone layout");
  const f = await setup(page);
  try {
    await openForm(page, f.supplier.name);
    await page.getByTestId("oc-add-mobile").click();
    const sheet = page.getByRole("dialog", { name: t.ocAddProduct, exact: true });
    await sheet.getByRole("combobox", { name: t.fieldIngredient, exact: true }).fill("Harina");
    await sheet.getByRole("option", { name: startsWith(f.flour.name) }).click();
    await sheet.getByRole("textbox", { name: t.fieldQty, exact: true }).fill("2");
    await sheet.getByRole("button", { name: t.ocAddAnother, exact: true }).click();
    await sheet.getByRole("combobox", { name: t.fieldIngredient, exact: true }).fill("Azúcar");
    await sheet.getByRole("option", { name: startsWith(f.sugar.name) }).click();
    await sheet.getByRole("textbox", { name: t.fieldQty, exact: true }).fill("3");
    await sheet.getByRole("button", { name: t.ocDone, exact: true }).click();

    const cards = page.getByTestId("oc-line-cards");
    await expect(cards.getByRole("button")).toHaveCount(2);
    await expect(cards.getByRole("button", { name: t.ocEditLine.replace("{name}", f.flour.name) })).toContainText("360.000");
    await expect(page.getByTestId("oc-total")).toHaveText(/374\.280/); // 360.000 + 12.000 + IVA 2.280
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const created = page.waitForResponse(r => r.url().endsWith("/api/operator/purchase-orders") && r.request().method() === "POST");
    await page.getByTestId("oc-submit").click();
    expect((await created).status()).toBe(201);
    expect(await db.purchaseOrderItem.count({ where: { purchaseOrder: { restaurantId: f.restaurant.id, number: 2 } } })).toBe(2);
  } finally { await f.cleanup(); }
});

test.afterAll(async () => { await db.$disconnect(); });
