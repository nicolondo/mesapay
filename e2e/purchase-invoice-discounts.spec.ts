import { test, expect, type Locator, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import type { PurchaseInvoiceExtraction, PurchaseInvoiceLineType } from "../src/lib/anthropic";
import es from "../messages/es.json";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!["localhost", "127.0.0.1"].includes(databaseUrl.hostname) || !/^\/mesapay_.*validation$/.test(databaseUrl.pathname) || !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""), "Isolated local app and validation database required");
const db = new PrismaClient();
const t = es.opErp;
test.setTimeout(90_000);

function line(overrides: Partial<PurchaseInvoiceLineType> = {}): PurchaseInvoiceLineType {
  return {
    description: "Aceite con descuento", quantity: 2, unit: "un", unitPriceCents: 900_000,
    lineTotalCents: 1_800_000, unitPriceTaxBasis: "net", lineTotalTaxBasis: "net", unitPriceLabel: "P. UNIT ANTES IMPTO",
    taxPct: "19", lineTaxCents: null, lineIncCents: 0, confidence: 1, ...overrides,
  };
}

function cards(page: Page) {
  return page.locator("div.rounded-2xl")
    .filter({ has: page.getByRole("button", { name: t.invReviewRemoveLine, exact: true }) })
    .filter({ has: page.getByLabel(t.fieldTaxPct, { exact: true }) });
}
const breakdownRow = (scope: Locator, label: string) => scope.getByText(label, { exact: true }).locator("..");

async function login(page: Page, token: string) {
  const password = `Disc-${token}`;
  const headers = { "x-real-ip": `127.1.${parseInt(token.slice(0, 2), 16)}.${parseInt(token.slice(2, 4), 16)}` };
  await page.setExtraHTTPHeaders(headers);
  const restaurant = await db.restaurant.create({ data: { name: "Descuentos de prueba", slug: `invoice-discount-${token}`, enabledModules: ["inventory", "purchasing"], purchaseIvaDeductible: true } });
  const user = await db.user.create({ data: { restaurantId: restaurant.id, role: "operator", email: `invoice-discount-${token}@example.test`, passwordHash: await bcrypt.hash(password, 4) } });
  // No OCR, mail or other external request is allowed from these specs.
  await page.route(/^https?:\/\//, route => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const response = await page.request.post("/api/auth/callback/credentials", {
    headers: { ...headers, "X-Auth-Return-Redirect": "1" },
    form: { csrfToken: csrf.csrfToken, email: user.email, password, callbackUrl: `${process.env.PLAYWRIGHT_BASE_URL}/operator/compras` },
  });
  expect(response.ok()).toBe(true);
  return restaurant;
}

async function cleanup(restaurantId: string) {
  await db.stockMovement.deleteMany({ where: { restaurantId } });
  await db.supplierPriceHistory.deleteMany({ where: { supplierItem: { supplier: { restaurantId } } } });
  await db.purchaseOrder.deleteMany({ where: { restaurantId } });
  await db.user.deleteMany({ where: { restaurantId } });
  await db.restaurant.deleteMany({ where: { id: restaurantId } });
}

/** Synthetic pending upload → the real review screen (only the OCR response is stubbed). */
async function openReview(page: Page, lines: PurchaseInvoiceLineType[], totals: Partial<PurchaseInvoiceExtraction>) {
  page.setDefaultTimeout(15_000);
  page.on("pageerror", error => console.error(`Invoice discount browser error: ${error.message}`));
  const token = randomUUID();
  const restaurant = await login(page, token);
  const supplier = await db.supplier.create({ data: { restaurantId: restaurant.id, name: "Proveedor con descuentos" } });
  const ingredients = await Promise.all(lines.map(l => db.ingredient.create({ data: { restaurantId: restaurant.id, name: l.description, measureKind: "count" } })));
  const extraction: PurchaseInvoiceExtraction = {
    documentType: "factura", supplierName: supplier.name, supplierNit: null,
    supplierInvoiceNumber: `DESC-${token.slice(0, 8)}`, issueDate: "2026-11-04", currency: "COP", lines,
    invoiceSubtotalCents: null, invoiceDiscountCents: null, invoiceTaxCents: null, invoiceTotalCents: null, invoiceIncCents: 0,
    retefuenteCents: 0, reteIvaCents: 0, reteIcaCents: 0, confidence: 1, notes: "", ...totals,
  };
  const upload = await db.purchaseInvoiceUpload.create({ data: { restaurantId: restaurant.id, fileUrl: "/discount-invoice.png", extraction } });
  await page.route("**/discount-invoice.png", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><text x="10" y="40">FACTURA CON DESCUENTO</text></svg>' }));
  const matched = await (await page.request.get(`/api/operator/purchase-invoices/${upload.id}`)).json();
  expect(matched.match, "Synthetic pending OCR must pass the real extraction schema").not.toBeNull();
  await page.route("**/api/operator/purchase-invoices", route => route.request().method() !== "POST" ? route.continue() : route.fulfill({ json: {
    uploadId: upload.id, fileUrl: upload.fileUrl, extraction, match: matched.match,
  } }));
  await page.goto("/operator/compras");
  await page.locator("#inv-upload-file").setInputFiles({ name: "synthetic-invoice.png", mimeType: "image/png", buffer: Buffer.from("synthetic OCR fixture") });
  await expect(page.getByRole("heading", { name: t.invReviewTitle, exact: true })).toBeVisible();
  await expect(cards(page)).toHaveCount(lines.length);
  return { restaurant, supplier, ingredients, upload, dialog: page.getByRole("dialog", { name: t.invReviewTitle, exact: true }) };
}

test("list price, line discount and footer discount read from the invoice are confirmed and received once", async ({ page }) => {
  // Line 1 prints list $10.000, 10 % and the discounted net. The footer adds
  // a 10 % discount over everything ($6.800) and IVA on the discounted base.
  const f = await openReview(page, [
    line({ listUnitPriceCents: 1_000_000, lineDiscountPct: 10 }),
    line({ description: "Harina sin IVA", quantity: 1, unitPriceCents: 5_000_000, lineTotalCents: 5_000_000, taxPct: "0" }),
  ], { invoiceSubtotalCents: 7_000_000, invoiceDiscountCents: 880_000, invoiceTaxCents: 307_800, invoiceTotalCents: 6_427_800 });
  try {
    const first = cards(page).first();
    await expect(first.getByLabel(t.invDiscLineLabel, { exact: true })).toHaveValue("10");
    await expect(first.getByRole("button", { name: t.discountToggleUnit, exact: true })).toHaveText("%");
    await expect(first.getByText(t.invDiscLineFromInvoice, { exact: true })).toBeVisible();
    await expect(first.getByLabel(`${t.invLineAmount} (COP)`)).toHaveValue("20.000");
    const amounts = first.getByTestId("invoice-line-amounts");
    await expect(breakdownRow(amounts, t.invDiscLineList)).toContainText("20.000");
    await expect(breakdownRow(amounts, t.discountLabel)).toContainText("2.000");
    await expect(breakdownRow(amounts, t.invLineNetAmount)).toContainText("18.000");
    await expect(f.dialog.getByLabel(t.orderDiscountLabel, { exact: true })).toHaveValue("6800");
    await expect(f.dialog.getByText(t.invDiscOrderFromInvoice, { exact: true })).toBeVisible();
    const totals = f.dialog.getByLabel(t.orderDiscountLabel, { exact: true }).locator("xpath=ancestor::div[contains(@class,'rounded-xl')][1]");
    await expect(breakdownRow(totals, t.subtotalLabel)).toContainText("70.000");
    await expect(breakdownRow(totals, t.discountLabel)).toContainText("8.800");
    await expect(breakdownRow(totals, t.taxLabel)).toContainText("3.078");
    await expect(breakdownRow(totals, t.invReviewTotalNote)).toContainText("64.278");
    await expect(page.getByText(/no coincide con el de la factura/)).toHaveCount(0);
    await f.dialog.getByLabel(t.orderDiscountLabel, { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ animations: "disabled", path: test.info().outputPath("discount-review-totals.png") });
    await first.getByLabel(t.invDiscLineLabel, { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ animations: "disabled", path: test.info().outputPath("discount-review-line.png") });

    await page.getByRole("button", { name: t.invReviewModeReceive, exact: true }).click();
    const response = page.waitForResponse(r => r.url().endsWith(`/purchase-invoices/${f.upload.id}/confirm`) && r.request().method() === "POST");
    await page.getByRole("button", { name: t.invReviewConfirm, exact: true }).click();
    const result = await response;
    expect(result.status(), await result.text()).toBe(201);
    const payload = result.request().postDataJSON();
    expect(payload).toMatchObject({ discountPct: null, discountCents: 680_000 });
    expect(payload.lines).toEqual([
      expect.objectContaining({ listCostCents: 2_000_000, discountPct: 10, expectedCostCents: 1_620_000, expectedTaxCents: 307_800 }),
      expect.objectContaining({ listCostCents: 5_000_000, discountPct: null, expectedCostCents: 4_500_000, expectedTaxCents: 0 }),
    ]);
    const saved = await db.purchaseInvoiceUpload.findUniqueOrThrow({ where: { id: f.upload.id } });
    const order = await db.purchaseOrder.findUniqueOrThrow({ where: { id: saved.purchaseOrderId! }, include: { items: { orderBy: { listCostCents: "asc" } }, movements: true } });
    expect(order).toMatchObject({ status: "received", discountCents: 880_000 });
    expect(order.items.map(i => [i.listCostCents, i.discountCents, i.orderDiscountCents, i.expectedCostCents, i.receivedCostCents])).toEqual([
      [2_000_000, 200_000, 180_000, 1_620_000, 1_620_000], [5_000_000, 0, 500_000, 4_500_000, 4_500_000],
    ]);
    expect(order.movements.map(m => m.valueCents).sort((a, b) => a - b)).toEqual([1_620_000, 4_500_000]);

    // The detail shows "Subtotal / Descuento" like the supplier's invoice.
    await expect(page.getByRole("heading", { name: `OC-${String(order.number).padStart(4, "0")}`, exact: true })).toBeVisible();
    await expect(page.getByText(t.discountLabel, { exact: true }).locator("..")).toContainText("8.800");
  } finally { await page.goto("about:blank"); await cleanup(f.restaurant.id); }
});

test("a net price that already contains the printed discount is not discounted again; a manual discount moves the VAT base", async ({ page }) => {
  const f = await openReview(page, [line()], { invoiceSubtotalCents: 2_000_000, invoiceDiscountCents: 200_000, invoiceTaxCents: 342_000, invoiceTotalCents: 2_142_000 });
  try {
    const card = cards(page).first();
    await expect(card.getByLabel(t.invDiscLineLabel, { exact: true })).toHaveValue("");
    await expect(f.dialog.getByLabel(t.orderDiscountLabel, { exact: true })).toHaveValue("");
    await expect(page.getByText(/no se aplicaron/)).toHaveCount(0);
    const amounts = card.getByTestId("invoice-line-amounts");
    await expect(breakdownRow(amounts, t.invLineNetAmount)).toContainText("18.000");
    await expect(breakdownRow(amounts, t.taxLabel)).toContainText("3.420");
    await card.getByLabel(t.invDiscLineLabel, { exact: true }).fill("10");
    await expect(breakdownRow(amounts, t.invLineNetAmount)).toContainText("16.200");
    await expect(breakdownRow(amounts, t.taxLabel)).toContainText("3.078");
    await expect(page.getByText(/no coincide con el de la factura/)).toBeVisible();
    await card.getByRole("button", { name: t.discountToggleUnit, exact: true }).click();
    await expect(card.getByRole("button", { name: t.discountToggleUnit, exact: true })).toHaveText("COP");
    await expect(breakdownRow(amounts, t.invLineNetAmount)).toContainText("17.990");
    await card.getByLabel(t.invDiscLineLabel, { exact: true }).fill("");
    await expect(breakdownRow(amounts, t.invLineNetAmount)).toContainText("18.000");
    await expect(page.getByText(/no coincide con el de la factura/)).toHaveCount(0);
    await page.getByRole("button", { name: t.invReviewModeDraft, exact: true }).click();
    const response = page.waitForResponse(r => r.url().endsWith(`/purchase-invoices/${f.upload.id}/confirm`) && r.request().method() === "POST");
    await page.getByRole("button", { name: t.invReviewConfirm, exact: true }).click();
    const result = await response;
    expect(result.status()).toBe(201);
    const payload = result.request().postDataJSON();
    expect(payload.lines[0]).toMatchObject({ expectedCostCents: 1_800_000, expectedTaxCents: 342_000 });
    expect(payload.lines[0].listCostCents).toBeUndefined();
    expect(payload.discountCents).toBeUndefined();
  } finally { await page.goto("about:blank"); await cleanup(f.restaurant.id); }
});

test("receiving goods with an extra invoice discount records the discounted net once", async ({ page }) => {
  page.setDefaultTimeout(15_000);
  const restaurant = await login(page, randomUUID());
  try {
    const supplier = await db.supplier.create({ data: { restaurantId: restaurant.id, name: "Proveedor recepción" } });
    const ingredient = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Queso de prueba", measureKind: "count" } });
    const created = await page.request.post("/api/operator/purchase-orders", { data: {
      supplierId: supplier.id, lines: [{ ingredientId: ingredient.id, qtyBase: 2_000, expectedCostCents: 2_000_000, taxPct: 19, discountPct: 10 }],
    } });
    expect(created.status()).toBe(201);
    const { order } = await created.json();
    await page.goto("/operator/compras");
    const number = `OC-${String(order.number).padStart(4, "0")}`;
    await page.getByRole("button", { name: new RegExp(`${number} `) }).click();
    await expect(page.getByRole("heading", { name: number, exact: true })).toBeVisible();
    await expect(page.getByText(t.discountLabel, { exact: true }).locator("..")).toContainText("2.000");
    await page.getByRole("button", { name: t.receiveGoods, exact: true }).click();
    await expect(page.getByLabel(`${t.fieldRealCost} (COP)`)).toHaveValue("18.000");
    await expect(page.getByText(t.receiveDiscIncluded, { exact: true })).toBeVisible();
    await page.getByLabel(t.invDiscLineLabel, { exact: true }).fill("5");
    const breakdown = page.getByTestId("receive-breakdown");
    await expect(breakdownRow(breakdown, t.subtotalLabel)).toContainText("18.000");
    await expect(breakdownRow(breakdown, t.discountLabel)).toContainText("900");
    await expect(breakdownRow(breakdown, t.taxLabel)).toContainText("3.249");
    await expect(breakdownRow(breakdown, t.invTaxGrandTotal)).toContainText("20.349");
    await breakdown.scrollIntoViewIfNeeded();
    await page.screenshot({ animations: "disabled", path: test.info().outputPath("discount-receive.png") });
    const receipt = page.waitForResponse(r => r.url().endsWith(`/purchase-orders/${order.id}/receive`) && r.request().method() === "POST");
    await page.getByRole("button", { name: t.receiveSubmit, exact: true }).click();
    const result = await receipt;
    expect(result.status()).toBe(200);
    expect(result.request().postDataJSON().lines).toEqual([expect.objectContaining({ qtyBase: 2_000, costCents: 1_710_000 })]);
    const item = await db.purchaseOrderItem.findFirstOrThrow({ where: { purchaseOrderId: order.id } });
    expect(item).toMatchObject({ listCostCents: 2_000_000, expectedCostCents: 1_800_000, receivedCostCents: 1_710_000 });
  } finally { await page.goto("about:blank"); await cleanup(restaurant.id); }
});

test("the review supplier field autocompletes by NIT and creates a new supplier from the typed text", async ({ page }) => {
  const f = await openReview(page, [line()], {});
  try {
    const other = await db.supplier.create({ data: { restaurantId: f.restaurant.id, name: "Distribuidora por NIT", taxId: "900123456" } });
    await page.reload();
    await page.locator("#inv-upload-file").setInputFiles({ name: "synthetic-invoice.png", mimeType: "image/png", buffer: Buffer.from("synthetic OCR fixture") });
    const field = f.dialog.getByRole("combobox", { name: t.invReviewSupplierSection, exact: true });
    await expect(field).toHaveValue(f.supplier.name);
    // Search by NIT (with dots and check digit) and pick the matching supplier.
    const rematch = page.waitForResponse(r => new URL(r.url()).searchParams.get("supplierId") === other.id);
    await field.fill("900.123.456-7");
    await f.dialog.getByRole("option", { name: new RegExp(`^${other.name}`) }).click();
    expect((await rematch).status()).toBe(200);
    await expect(field).toHaveValue(other.name);
    // A name that does not exist yet opens the creation with it prefilled.
    await field.fill("Granos El Nuevo");
    await f.dialog.getByRole("option", { name: es.supplierCombobox.create.replace("{query}", "Granos El Nuevo") }).click();
    await expect(f.dialog.getByRole("textbox", { name: new RegExp(t.invReviewNewSupplierName) })).toHaveValue("Granos El Nuevo");
    await page.getByRole("button", { name: t.invReviewModeDraft, exact: true }).click();
    const response = page.waitForResponse(r => r.url().endsWith(`/purchase-invoices/${f.upload.id}/confirm`) && r.request().method() === "POST");
    await page.getByRole("button", { name: t.invReviewConfirm, exact: true }).click();
    const result = await response;
    expect(result.status(), await result.text()).toBe(201);
    expect(result.request().postDataJSON()).toMatchObject({ supplierId: null, newSupplierName: "Granos El Nuevo" });
    expect(await db.supplier.count({ where: { restaurantId: f.restaurant.id, name: "Granos El Nuevo" } })).toBe(1);
  } finally { await page.goto("about:blank"); await cleanup(f.restaurant.id); }
});

test.afterAll(async () => { await db.$disconnect(); });
