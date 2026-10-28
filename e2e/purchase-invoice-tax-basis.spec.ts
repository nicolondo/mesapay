import { test, expect, type Locator, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import type { PurchaseInvoiceExtraction, PurchaseInvoiceLineType } from "../src/lib/anthropic";
import es from "../messages/es.json";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!["localhost", "127.0.0.1"].includes(databaseUrl.hostname) || !/^\/mesapay_.*validation$/.test(databaseUrl.pathname) || !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""), "Isolated local app and validation database required");
const db = new PrismaClient();
const t = es.opErp as typeof es.opErp & { invLineTaxIncluded: string; invLineConfirmNet: string };
const tenants = new Set<string>();
test.setTimeout(90_000);

function line(overrides: Partial<PurchaseInvoiceLineType> = {}): PurchaseInvoiceLineType {
  return {
    description: "Botellas con IVA", quantity: 2, unit: "un", unitPriceCents: 1_000_000,
    lineTotalCents: 2_380_000, unitPriceTaxBasis: "net", lineTotalTaxBasis: "unknown",
    taxPct: "19", lineTaxCents: null, lineIncCents: 0, confidence: 1, ...overrides,
  };
}

function cards(page: Page) {
  return page.locator("div.rounded-2xl")
    .filter({ has: page.getByRole("button", { name: t.invReviewRemoveLine, exact: true }) })
    .filter({ has: page.getByLabel(t.fieldTaxPct, { exact: true }) });
}
function included(card: Locator) { return card.getByRole("checkbox", { name: t.invLineTaxIncluded, exact: true }); }
async function preview(card: Locator, values: { net: string; tax: string; total: string }) {
  const amounts = card.getByTestId("invoice-line-amounts");
  await expect(amounts.getByText(t.invLineNetAmount, { exact: true }).locator("..")).toContainText(values.net);
  await expect(amounts.getByText(t.taxLabel, { exact: true }).locator("..")).toContainText(values.tax);
  await expect(amounts.getByText(t.invLineFinalAmount, { exact: true }).locator("..")).toContainText(values.total);
}

async function setup(page: Page, lines = [line()], totals: Partial<PurchaseInvoiceExtraction> = {}) {
  page.setDefaultTimeout(15_000);
  page.on("pageerror", error => console.error(`Invoice review browser error: ${error.message}`));
  const token = randomUUID(), password = `Tax-${token}`;
  const headers = { "x-real-ip": `127.0.${parseInt(token.slice(0, 2), 16)}.${parseInt(token.slice(2, 4), 16)}` };
  await page.setExtraHTTPHeaders(headers);
  const restaurant = await db.restaurant.create({ data: { name: "Revisión de IVA de prueba", slug: `invoice-tax-${token}`, enabledModules: ["inventory", "purchasing"], purchaseIvaDeductible: false } });
  tenants.add(restaurant.id);
  const user = await db.user.create({ data: { restaurantId: restaurant.id, role: "operator", email: `invoice-tax-${token}@example.test`, passwordHash: await bcrypt.hash(password, 4) } });
  const supplier = await db.supplier.create({ data: { restaurantId: restaurant.id, name: "Proveedor de prueba IVA" } });
  const otherSupplier = await db.supplier.create({ data: { restaurantId: restaurant.id, name: "Proveedor corregido IVA" } });
  const ingredients = await Promise.all(lines.map(l => db.ingredient.create({ data: { restaurantId: restaurant.id, name: l.description, measureKind: "count" } })));
  const replacement = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Botella corregida del catálogo", measureKind: "count" } });
  const extraction: PurchaseInvoiceExtraction = {
    documentType: "factura", supplierName: supplier.name, supplierNit: null,
    supplierInvoiceNumber: `TAX-${token.slice(0, 8)}`, issueDate: "2026-10-28", currency: "COP", lines,
    invoiceSubtotalCents: null, invoiceTaxCents: null, invoiceTotalCents: null, invoiceIncCents: 0,
    retefuenteCents: 0, reteIvaCents: 0, reteIcaCents: 0, confidence: 1, notes: "", ...totals,
  };
  const upload = await db.purchaseInvoiceUpload.create({ data: { restaurantId: restaurant.id, fileUrl: "/tax-basis-invoice.png", extraction } });
  // No real OCR, mail or external service request is allowed. Matching,
  // inference on initial review, saving and receipt use the real application.
  await page.route(/^https?:\/\//, route => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.route("**/tax-basis-invoice.png", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><text x="10" y="40">FACTURA DE PRUEBA</text></svg>' }));
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const login = await page.request.post("/api/auth/callback/credentials", {
    headers: { ...headers, "X-Auth-Return-Redirect": "1" },
    form: { csrfToken: csrf.csrfToken, email: user.email, password, callbackUrl: `${process.env.PLAYWRIGHT_BASE_URL}/operator/compras` },
  });
  expect(login.ok()).toBe(true);
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(user.id);
  const matchResponse = await page.request.get(`/api/operator/purchase-invoices/${upload.id}`);
  expect(matchResponse.ok()).toBe(true);
  const matched = await matchResponse.json();
  expect(matched.match, "Synthetic pending OCR must pass the real extraction schema").not.toBeNull();
  await page.route("**/api/operator/purchase-invoices", route => route.request().method() !== "POST" ? route.continue() : route.fulfill({ json: {
    uploadId: upload.id, fileUrl: upload.fileUrl, extraction, match: matched.match,
  } }));
  await page.goto("/operator/compras");
  await page.getByRole("tab", { name: t.tabUnpaid, exact: true }).click();
  await expect(page.getByRole("tab", { name: t.tabUnpaid, exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: t.tabOrders, exact: true }).click();
  await expect(page.getByRole("tab", { name: t.tabOrders, exact: true })).toHaveAttribute("aria-selected", "true");
  await page.locator("#inv-upload-file").setInputFiles({ name: "synthetic-invoice.png", mimeType: "image/png", buffer: Buffer.from("synthetic OCR fixture") });
  await expect(page.getByRole("heading", { name: t.invReviewTitle, exact: true })).toBeVisible();
  await expect(cards(page)).toHaveCount(lines.length);
  return { restaurant, supplier, otherSupplier, ingredients, replacement, upload, cards: cards(page), cleanup: async () => {
    await page.goto("about:blank");
    await cleanup(restaurant.id);
  } };
}

async function cleanup(restaurantId: string) {
  await db.stockMovement.deleteMany({ where: { restaurantId } });
  await db.supplierPriceHistory.deleteMany({ where: { supplierItem: { supplier: { restaurantId } } } });
  await db.purchaseOrder.deleteMany({ where: { restaurantId } });
  await db.user.deleteMany({ where: { restaurantId } });
  await db.restaurant.deleteMany({ where: { id: restaurantId } });
  tenants.delete(restaurantId);
}
async function confirm(page: Page, uploadId: string, mode: "draft" | "receive") {
  await page.getByRole("button", { name: mode === "draft" ? t.invReviewModeDraft : t.invReviewModeReceive, exact: true }).click();
  const response = page.waitForResponse(r => r.url().endsWith(`/purchase-invoices/${uploadId}/confirm`) && r.request().method() === "POST");
  await page.getByRole("button", { name: t.invReviewConfirm, exact: true }).click();
  const result = await response;
  expect(result.status(), await result.text()).toBe(201);
  await expect(page.getByRole("dialog", { name: t.invReviewTitle, exact: true })).toHaveCount(0);
  const savedUpload = await db.purchaseInvoiceUpload.findUniqueOrThrow({ where: { id: uploadId } });
  return { payload: result.request().postDataJSON(), order: await db.purchaseOrder.findUniqueOrThrow({ where: { id: savedUpload.purchaseOrderId! }, include: { items: true } }) };
}

test("mixed supplier lines automatically turn included taxes on or off independently", async ({ page }) => {
  const f = await setup(page, [line(), line({ description: "Botellas sin IVA", lineTotalCents: 2_000_000 })], {
    invoiceSubtotalCents: 4_000_000, invoiceTaxCents: 760_000, invoiceTotalCents: 4_760_000,
  });
  try {
    await expect(included(f.cards.nth(0))).toBeChecked();
    await expect(included(f.cards.nth(1))).not.toBeChecked();
    await expect(included(f.cards.nth(1))).toHaveJSProperty("indeterminate", false);
    await preview(f.cards.nth(0), { net: "20.000", tax: "3.800", total: "23.800" });
    await preview(f.cards.nth(1), { net: "20.000", tax: "3.800", total: "23.800" });
    await expect(f.cards.nth(0).getByLabel(t.invLineAmountKind, { exact: true })).toHaveValue("line");
    await included(f.cards.nth(0)).scrollIntoViewIfNeeded();
    await page.screenshot({ animations: "disabled", path: test.info().outputPath("mixed-vat-bases.png") });
    const { order, payload } = await confirm(page, f.upload.id, "receive");
    expect(payload.lines).toEqual(expect.arrayContaining(f.ingredients.map(ingredient => expect.objectContaining({ ingredientId: ingredient.id, qtyBase: 2000, expectedCostCents: 2_000_000, expectedTaxCents: 380_000 }))));
    expect(order.items).toHaveLength(2);
    expect(await db.stockMovement.findMany({ where: { restaurantId: f.restaurant.id } })).toEqual(expect.arrayContaining(f.ingredients.map(ingredient => expect.objectContaining({ ingredientId: ingredient.id, qtyBase: 2000, valueCents: 2_380_000 }))));
  } finally { await f.cleanup(); }
});

for (const mode of ["draft", "receive"] as const) {
  test(`manual VAT choice survives rematching and a failed confirmation, then ${mode} and reopening`, async ({ page }) => {
    const f = await setup(page);
    try {
      const card = f.cards.first();
      await expect(included(card)).toBeChecked();
      await included(card).uncheck();
      await preview(card, { net: "23.800", tax: "4.522", total: "28.322" });
      await included(card).check();
      await preview(card, { net: "20.000", tax: "3.800", total: "23.800" });
      await included(card).uncheck();
      const matchResponse = page.waitForResponse(r => new URL(r.url()).pathname.endsWith(`/purchase-invoices/${f.upload.id}`) && new URL(r.url()).searchParams.get("supplierId") === f.otherSupplier.id);
      const dialog = page.getByRole("dialog", { name: t.invReviewTitle, exact: true });
      await dialog.getByRole("button", { name: t.changeSupplier, exact: true }).click();
      await dialog.getByPlaceholder(t.supplierSearchPlaceholder).fill(f.otherSupplier.name);
      await dialog.getByRole("button", { name: f.otherSupplier.name, exact: true }).click();
      expect((await matchResponse).status()).toBe(200);
      await expect(page.getByText(t.invAliasLoading, { exact: true })).toHaveCount(0);
      await expect(included(card)).not.toBeChecked();
      await card.getByRole("button", { name: t.invReviewChangeIngredient, exact: true }).click();
      await card.getByPlaceholder(t.ingredientSearchPlaceholder).fill(f.replacement.name);
      await card.getByRole("button", { name: new RegExp(f.replacement.name) }).click();
      await expect(included(card)).not.toBeChecked();
      await expect(card.getByLabel(t.fieldQty)).toHaveValue("2");
      await expect(card.getByLabel(`${t.invLineAmount} (COP)`)).toHaveValue("23.800");
      const endpoint = `**/api/operator/purchase-invoices/${f.upload.id}/confirm`;
      await page.route(endpoint, route => route.abort("failed"));
      await page.getByRole("button", { name: t.invReviewConfirm, exact: true }).click();
      await expect(page.getByRole("button", { name: t.invReviewConfirm, exact: true })).toBeEnabled();
      await expect(included(card)).not.toBeChecked();
      await preview(card, { net: "23.800", tax: "4.522", total: "28.322" });
      expect(await db.purchaseOrder.count({ where: { restaurantId: f.restaurant.id } })).toBe(0);
      await page.unroute(endpoint);
      await included(card).scrollIntoViewIfNeeded();
      await page.screenshot({ animations: "disabled", path: test.info().outputPath(`manual-vat-${mode}.png`) });
      const { order, payload } = await confirm(page, f.upload.id, mode);
      expect(payload.lines[0]).toMatchObject({ ingredientId: f.replacement.id, qtyBase: 2000, expectedCostCents: 2_380_000, expectedTaxCents: 452_200 });
      expect(order.supplierId).toBe(f.otherSupplier.id);
      expect(order.items[0]).toMatchObject({ ingredientId: f.replacement.id, qtyOrderedBase: 2000, expectedCostCents: 2_380_000, expectedTaxCents: 452_200 });
      await page.reload();
      const number = `OC-${String(order.number).padStart(4, "0")}`;
      const row = page.getByRole("button", { name: new RegExp(`${number} `) });
      await expect(row).toContainText("28.322");
      await row.click();
      await expect(page.getByRole("heading", { name: number, exact: true })).toBeVisible();
      if (mode === "draft") {
        expect(await db.stockMovement.count({ where: { restaurantId: f.restaurant.id } })).toBe(0);
        await page.getByRole("button", { name: t.receiveGoods, exact: true }).click();
        await expect(page.getByLabel(`${t.fieldRealCost} (COP)`)).toHaveValue("23.800");
        const receipt = page.waitForResponse(r => r.url().endsWith(`/purchase-orders/${order.id}/receive`) && r.request().method() === "POST");
        await page.getByRole("button", { name: t.receiveSubmit, exact: true }).click();
        expect((await receipt).status()).toBe(200);
      }
      expect(await db.stockMovement.findMany({ where: { restaurantId: f.restaurant.id } })).toEqual([
        expect.objectContaining({ ingredientId: f.replacement.id, qtyBase: 2000, valueCents: 2_832_200 }),
      ]);
    } finally { await f.cleanup(); }
  });
}

test("an ambiguous line stays visibly undecided and requires an explicit tax choice", async ({ page }) => {
  const f = await setup(page, [line({ unitPriceCents: null, unitPriceTaxBasis: "unknown", lineTotalCents: 2_000_000 })]);
  try {
    const card = f.cards.first();
    await expect(included(card)).toHaveJSProperty("indeterminate", true);
    let attempts = 0;
    page.on("request", request => { if (request.method() === "POST" && request.url().endsWith(`/purchase-invoices/${f.upload.id}/confirm`)) attempts++; });
    await page.getByRole("button", { name: t.invReviewConfirm, exact: true }).click();
    await expect(page.getByText(t.invLineReviewAmounts, { exact: true }).first()).toBeVisible();
    expect(attempts).toBe(0);
    await included(card).scrollIntoViewIfNeeded();
    await page.screenshot({ animations: "disabled", path: test.info().outputPath("ambiguous-vat-requires-choice.png") });
    await card.getByRole("button", { name: t.invLineConfirmNet, exact: true }).click();
    await expect(included(card)).toHaveJSProperty("indeterminate", false);
    await expect(included(card)).not.toBeChecked();
    await preview(card, { net: "20.000", tax: "3.800", total: "23.800" });
    await confirm(page, f.upload.id, "receive");
    expect(attempts).toBe(1);
  } finally { await f.cleanup(); }
});

test("included-tax control preserves fixed consumption and multiplies a unit price only once", async ({ page }) => {
  const f = await setup(page, [line({ unitPriceCents: 1_300_000, unitPriceTaxBasis: "gross", lineTotalCents: null, taxPct: "5", lineIncCents: 500_000 })], {
    invoiceSubtotalCents: 2_000_000, invoiceTaxCents: 100_000, invoiceIncCents: 500_000, invoiceTotalCents: 2_600_000,
  });
  try {
    const card = f.cards.first();
    await expect(included(card)).toBeChecked();
    await expect(card.getByLabel(t.invLineAmountKind, { exact: true })).toHaveValue("unit");
    await expect(card.getByLabel(`${t.invUnitAmount} (COP)`)).toHaveValue("13.000");
    await preview(card, { net: "20.000", tax: "1.000", total: "26.000" });
    await included(card).uncheck();
    await preview(card, { net: "26.000", tax: "1.300", total: "32.300" });
    await expect(card.getByLabel(t.invLineIncAmount, { exact: true })).toHaveValue("5.000");
    await included(card).check();
    await preview(card, { net: "20.000", tax: "1.000", total: "26.000" });
    const { order, payload } = await confirm(page, f.upload.id, "receive");
    expect(payload.lines[0]).toMatchObject({ qtyBase: 2000, expectedCostCents: 2_000_000, expectedTaxCents: 100_000, expectedIncCents: 500_000 });
    expect(order.incCents).toBe(500_000);
    expect(await db.stockMovement.findMany({ where: { restaurantId: f.restaurant.id } })).toEqual([
      expect.objectContaining({ qtyBase: 2000, valueCents: 2_600_000 }),
    ]);
  } finally { await f.cleanup(); }
});

test("legacy missing tax metadata still requires explicit consumption review after choosing included VAT", async ({ page }) => {
  const f = await setup(page, [line({
    unitPriceCents: null, unitPriceTaxBasis: undefined, lineTotalTaxBasis: undefined,
    lineTotalCents: 2_000_000, lineIncCents: undefined, lineIncAmbiguous: undefined,
  })], { invoiceIncCents: null, notes: undefined });
  try {
    const card = f.cards.first();
    await expect(included(card)).toHaveJSProperty("indeterminate", true);
    await included(card).check();
    await expect(included(card)).toBeChecked();
    let attempts = 0;
    page.on("request", request => { if (request.method() === "POST" && request.url().endsWith(`/purchase-invoices/${f.upload.id}/confirm`)) attempts++; });
    await page.getByRole("button", { name: t.invReviewConfirm, exact: true }).click();
    await expect(page.getByText(t.invLineReviewAmounts, { exact: true }).first()).toBeVisible();
    expect(attempts).toBe(0);
    expect(await db.purchaseOrder.count({ where: { restaurantId: f.restaurant.id } })).toBe(0);
    await card.getByLabel(t.invLineIncAmount, { exact: true }).fill("0");
    // COP display rounds to pesos; the confirmation below must keep cents.
    await preview(card, { net: "16.807", tax: "3.193", total: "20.000" });
    const { payload } = await confirm(page, f.upload.id, "receive");
    expect(payload.lines[0]).toMatchObject({ qtyBase: 2000, expectedCostCents: 1_680_672, expectedTaxCents: 319_328, expectedIncCents: 0 });
    expect(attempts).toBe(1);
  } finally { await f.cleanup(); }
});

test.afterAll(async () => {
  for (const restaurantId of tenants) await cleanup(restaurantId);
  await db.$disconnect();
});
