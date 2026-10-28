import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import es from "../messages/es.json";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!["localhost", "127.0.0.1"].includes(databaseUrl.hostname) || !/^\/mesapay_.*validation$/.test(databaseUrl.pathname) || !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""), "Isolated local app and validation database required");
const db = new PrismaClient();
const t = es.opErp;
const fixtureTenantIds = new Set<string>();
test.setTimeout(90_000);

type AmountFixture = {
  line: {
    description: string; quantity: number; unit: string; unitPriceCents: number | null; lineTotalCents: number | null;
    taxPct: string | null; confidence: number; lineTotalTaxBasis?: "net" | "gross" | "unknown";
    unitPriceTaxBasis?: "net" | "gross" | "unknown"; lineIncCents?: number | null;
    lineTaxCents?: number | null; lineIncAmbiguous?: boolean;
  };
  netCents: number; taxCents: number; incCents: number; totalCents: number;
};

async function setup(page: Page, amounts?: AmountFixture) {
  page.setDefaultTimeout(15_000);
  const token = randomUUID(), password = `Purchase-${token}`;
  // Independent local clients must not share the IP-based login throttle.
  const clientHeaders = { "x-real-ip": `127.0.${parseInt(token.slice(0, 2), 16)}.${parseInt(token.slice(2, 4), 16)}` };
  await page.setExtraHTTPHeaders(clientHeaders);
  const restaurant = await db.restaurant.create({ data: { name: "Importación de prueba", slug: `purchase-edit-${token}`, enabledModules: ["inventory", "purchasing"], purchaseIvaDeductible: false } });
  fixtureTenantIds.add(restaurant.id);
  const user = await db.user.create({ data: { email: `purchase-edit-${token}@example.test`, passwordHash: await bcrypt.hash(password, 4), role: "operator", restaurantId: restaurant.id } });
  const supplier = await db.supplier.create({ data: { restaurantId: restaurant.id, name: "Proveedor de prueba" } });
  const oldIngredient = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Arroz sugerido", measureKind: "mass" } });
  const replacement = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: amounts ? "Botella de prueba" : "Huevos corregidos", measureKind: "count" } });
  const presentation = await db.supplierIngredient.create({ data: { supplierId: supplier.id, ingredientId: oldIngredient.id, presentationLabel: "Bulto", contentQty: 25000 } });
  const extraction = {
    documentType: "factura", supplierNit: null, supplierName: supplier.name,
    supplierInvoiceNumber: "TEST-OCR", issueDate: "2026-10-15", currency: "COP",
    lines: amounts ? [amounts.line] : [
      { description: oldIngredient.name, quantity: 2, unit: "kg", unitPriceCents: 1000000, lineTotalCents: 2000000, taxPct: "0", confidence: 1, lineTotalTaxBasis: "net", unitPriceTaxBasis: "net" },
      { description: "Insumo leído", quantity: 1, unit: "kg", unitPriceCents: 500000, lineTotalCents: 500000, taxPct: "0", confidence: 1, lineTotalTaxBasis: "net", unitPriceTaxBasis: "net" },
    ],
    invoiceSubtotalCents: amounts?.netCents ?? 2500000, invoiceTaxCents: amounts?.taxCents ?? 0, invoiceTotalCents: amounts?.totalCents ?? 2500000,
    invoiceIncCents: amounts?.incCents ?? 0, retefuenteCents: 0, reteIvaCents: 0, reteIcaCents: 0,
    confidence: 1, notes: "",
  };
  const upload = await db.purchaseInvoiceUpload.create({ data: { restaurantId: restaurant.id, fileUrl: "/test-invoice.png", extraction } });
  await page.route(/^https?:\/\//, route => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.route("**/test-invoice.png", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><text x="10" y="40">FACTURA DE PRUEBA</text></svg>' }));
  // Only OCR is stubbed: confirmation and re-opening use the real API + database.
  await page.route("**/api/operator/purchase-invoices", route => route.request().method() !== "POST" ? route.continue() : route.fulfill({ json: {
    uploadId: upload.id, fileUrl: upload.fileUrl, extraction,
    match: {
      supplier: { kind: "matched", supplier: { id: supplier.id, name: supplier.name } },
      lines: amounts ? [{ line: extraction.lines[0], lowConfidence: false, ingredient: { kind: "matched", ingredient: replacement }, suggestedPresentation: null }] : [
        { line: extraction.lines[0], lowConfidence: false, ingredient: { kind: "matched", ingredient: oldIngredient }, suggestedPresentation: { supplierItemId: presentation.id, presentationLabel: "Bulto", contentQty: 25000, lastPriceCents: null } },
        { line: extraction.lines[1], lowConfidence: false, ingredient: { kind: "suggest_create", name: "Insumo leído" }, suggestedPresentation: null },
      ], computedTotalCents: extraction.invoiceTotalCents,
    },
  } }));
  // Authenticate through the real endpoint; these regressions target invoice editing.
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const login = await page.request.post("/api/auth/callback/credentials", {
    headers: { ...clientHeaders, "X-Auth-Return-Redirect": "1" },
    form: { csrfToken: csrf.csrfToken, email: user.email, password, callbackUrl: `${process.env.PLAYWRIGHT_BASE_URL}/operator/compras` },
  });
  expect(login.ok()).toBe(true);
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(user.id);
  await page.goto("/operator/compras");
  await page.locator('#inv-upload-file').setInputFiles({ name: "synthetic-invoice.png", mimeType: "image/png", buffer: Buffer.from("synthetic OCR fixture") });
  await expect(page.getByRole("heading", { name: t.invReviewTitle, exact: true })).toBeVisible();
  const cards = page.locator("div.rounded-2xl").filter({ has: page.getByRole("button", { name: t.invReviewRemoveLine, exact: true }) }).filter({ has: page.getByLabel(t.fieldTaxPct, { exact: true }) });
  return { restaurant, upload, oldIngredient, replacement, cards, cleanup: async () => {
    await page.goto("about:blank");
    await cleanupFixture(restaurant.id);
  } };
}

async function cleanupFixture(restaurantId: string) {
  await db.stockMovement.deleteMany({ where: { restaurantId } });
  await db.supplierPriceHistory.deleteMany({ where: { supplierItem: { supplier: { restaurantId } } } });
  await db.purchaseOrder.deleteMany({ where: { restaurantId } });
  await db.user.deleteMany({ where: { restaurantId } });
  await db.restaurant.deleteMany({ where: { id: restaurantId } });
  fixtureTenantIds.delete(restaurantId);
}

for (const mode of ["draft", "receive"] as const) {
  test(`corrected OCR line names, amounts and tax survive ${mode} and reopening`, async ({ page }) => {
    const f = await setup(page);
    try {
      await f.cards.nth(0).getByRole("button", { name: t.invReviewRemoveLine, exact: true }).click();
      const card = f.cards.nth(0);
      await card.getByLabel(t.invReviewNewIngredientName).fill("Harina corregida");
      await card.getByLabel(t.fieldQty).fill("2,75");
      await card.getByLabel(`${t.invLineAmount} (COP)`).fill("38750");
      await card.getByLabel(t.fieldTaxPct, { exact: true }).selectOption("19");
      await page.getByRole("button", { name: mode === "draft" ? t.invReviewModeDraft : t.invReviewModeReceive, exact: true }).click();
      const response = page.waitForResponse(r => r.url().endsWith(`/purchase-invoices/${f.upload.id}/confirm`) && r.request().method() === "POST");
      await page.getByRole("button", { name: t.invReviewConfirm, exact: true }).click();
      expect((await response).status()).toBe(201);
      const po = await db.purchaseOrder.findFirstOrThrow({ where: { restaurantId: f.restaurant.id }, include: { items: { include: { ingredient: true } } } });
      expect(po.status).toBe(mode === "draft" ? "draft" : "received");
      expect(po.items).toHaveLength(1);
      expect(po.items[0]).toMatchObject({ qtyOrderedBase: 2750, expectedCostCents: 3875000, taxPct: 19, ingredient: { name: "Harina corregida" } });
      if (mode === "receive") expect(po.items[0]).toMatchObject({ receivedQtyBase: 2750, receivedCostCents: 3875000 });
      await page.reload();
      const saved = await page.request.get(`/api/operator/purchase-orders/${po.id}`);
      expect(saved.ok()).toBe(true);
      expect((await saved.json()).order.items[0]).toMatchObject({ qtyOrderedBase: 2750, expectedCostCents: 3875000, taxPct: 19, ingredient: { name: "Harina corregida" } });
    } finally { await f.cleanup(); }
  });
}

test("changing a matched ingredient releases the old presentation and saves the corrected quantity", async ({ page }) => {
  const f = await setup(page);
  try {
    await f.cards.nth(1).getByRole("button", { name: t.invReviewRemoveLine, exact: true }).click();
    const card = f.cards.nth(0);
    await card.getByRole("button", { name: t.invReviewChangeIngredient, exact: true }).click();
    await card.getByPlaceholder(t.ingredientSearchPlaceholder).fill(f.replacement.name);
    await card.getByRole("button", { name: new RegExp(f.replacement.name) }).click();
    await expect(card.getByRole("button", { name: t.invReviewQtyModePresentation, exact: true })).toHaveCount(0);
    await card.getByLabel(t.fieldQty).fill("12");
    await card.getByLabel(`${t.invLineAmount} (COP)`).fill("18000");
    await page.getByRole("button", { name: t.invReviewConfirm, exact: true }).click();
    await expect.poll(async () => db.purchaseOrder.count({ where: { restaurantId: f.restaurant.id } })).toBe(1);
    const po = await db.purchaseOrder.findFirstOrThrow({ where: { restaurantId: f.restaurant.id }, include: { items: true } });
    expect(po.items[0]).toMatchObject({ ingredientId: f.replacement.id, qtyOrderedBase: 12000, expectedCostCents: 1800000 });
    expect(await db.ingredient.findUniqueOrThrow({ where: { id: f.oldIngredient.id } })).toMatchObject({ name: "Arroz sugerido" });
  } finally { await f.cleanup(); }
});

test("failed confirmation keeps edited lines and allows retry", async ({ page }) => {
  const f = await setup(page);
  try {
    const endpoint = `**/api/operator/purchase-invoices/${f.upload.id}/confirm`;
    await f.cards.nth(0).getByRole("button", { name: t.invReviewRemoveLine, exact: true }).click();
    const card = f.cards.nth(0);
    await card.getByLabel(t.invReviewNewIngredientName).fill("Edición recuperable");
    await card.getByLabel(t.fieldQty).fill("3,25");
    await page.route(endpoint, route => route.abort("failed"));
    await page.getByRole("button", { name: t.invReviewConfirm, exact: true }).click();
    await expect(page.getByRole("button", { name: t.invReviewConfirm, exact: true })).toBeEnabled();
    await expect(card.getByLabel(t.invReviewNewIngredientName)).toHaveValue("Edición recuperable");
    await expect(card.getByLabel(t.fieldQty)).toHaveValue("3,25");
    expect(await db.purchaseOrder.count({ where: { restaurantId: f.restaurant.id } })).toBe(0);
    await page.unroute(endpoint);
    await page.getByRole("button", { name: t.invReviewConfirm, exact: true }).click();
    await expect.poll(async () => db.purchaseOrder.count({ where: { restaurantId: f.restaurant.id } })).toBe(1);
    const po = await db.purchaseOrder.findFirstOrThrow({ where: { restaurantId: f.restaurant.id }, include: { items: { include: { ingredient: true } } } });
    expect(po.items[0]).toMatchObject({ qtyOrderedBase: 3250, ingredient: { name: "Edición recuperable" } });
  } finally { await f.cleanup(); }
});

test("an incorrect existing match can be replaced with a new edited ingredient", async ({ page }) => {
  const f = await setup(page);
  try {
    await f.cards.nth(1).getByRole("button", { name: t.invReviewRemoveLine, exact: true }).click();
    const card = f.cards.nth(0);
    await card.getByRole("button", { name: t.invReviewCreateNewIngredient, exact: true }).click();
    await card.getByLabel(t.invReviewNewIngredientName).fill("Harina de trigo corregida");
    await expect(card.getByLabel(t.fieldQty)).toHaveValue("50");
    await card.getByLabel(t.fieldQty).fill("7,5");
    await card.getByLabel(`${t.invLineAmount} (COP)`).fill("25000");
    await card.getByLabel(t.fieldTaxPct, { exact: true }).selectOption("5");
    await page.screenshot({ animations: "disabled", path: test.info().outputPath("corrected-invoice-review.png") });
    await page.getByRole("button", { name: t.invReviewConfirm, exact: true }).click();
    await expect.poll(async () => db.purchaseOrder.count({ where: { restaurantId: f.restaurant.id } })).toBe(1);
    const po = await db.purchaseOrder.findFirstOrThrow({ where: { restaurantId: f.restaurant.id }, include: { items: { include: { ingredient: true } } } });
    expect(po.items[0]).toMatchObject({ qtyOrderedBase: 7500, expectedCostCents: 2500000, taxPct: 5, ingredient: { name: "Harina de trigo corregida" } });
    expect(po.items[0].ingredientId).not.toBe(f.oldIngredient.id);
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: f.oldIngredient.id } })).name).toBe("Arroz sugerido");
  } finally { await f.cleanup(); }
});

test("an interrupted response recovers the saved order without losing edits or duplicating it", async ({ page }) => {
  const f = await setup(page);
  try {
    await f.cards.nth(0).getByRole("button", { name: t.invReviewRemoveLine, exact: true }).click();
    const card = f.cards.nth(0);
    await card.getByLabel(t.invReviewNewIngredientName).fill("Edición guardada");
    await card.getByLabel(t.fieldQty).fill("4,5");
    let confirmations = 0;
    await page.route(`**/api/operator/purchase-invoices/${f.upload.id}/confirm`, async route => {
      confirmations++;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.abort("failed");
    });
    await page.getByRole("button", { name: t.invReviewConfirm, exact: true }).click();
    await expect(page.getByRole("dialog", { name: t.invReviewTitle, exact: true })).toHaveCount(0);
    expect(confirmations).toBe(1);
    const orders = await db.purchaseOrder.findMany({ where: { restaurantId: f.restaurant.id }, include: { items: { include: { ingredient: true } } } });
    expect(orders).toHaveLength(1);
    expect(orders[0].items[0]).toMatchObject({ qtyOrderedBase: 4500, ingredient: { name: "Edición guardada" } });
  } finally { await f.cleanup(); }
});

test("a failed discard preserves the editable review for confirmation", async ({ page }) => {
  const f = await setup(page);
  try {
    await f.cards.nth(0).getByRole("button", { name: t.invReviewRemoveLine, exact: true }).click();
    const card = f.cards.nth(0);
    await card.getByLabel(t.invReviewNewIngredientName).fill("Corrección conservada");
    const endpoint = `**/api/operator/purchase-invoices/${f.upload.id}`;
    await page.route(endpoint, route => route.request().method() === "DELETE" ? route.abort("failed") : route.continue());
    page.on("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: t.invReviewDiscard, exact: true }).click();
    await expect(page.getByText(t.errSaveFailed, { exact: true })).toBeVisible();
    await expect(card.getByLabel(t.invReviewNewIngredientName)).toHaveValue("Corrección conservada");
    await page.unroute(endpoint);
    await page.getByRole("button", { name: t.invReviewConfirm, exact: true }).click();
    await expect.poll(async () => db.purchaseOrder.count({ where: { restaurantId: f.restaurant.id } })).toBe(1);
    const po = await db.purchaseOrder.findFirstOrThrow({ where: { restaurantId: f.restaurant.id }, include: { items: { include: { ingredient: true } } } });
    expect(po.items[0].ingredient.name).toBe("Corrección conservada");
  } finally { await f.cleanup(); }
});

const grossWithConsumption: AmountFixture = {
  line: {
    description: "Botella de prueba", quantity: 2, unit: "un", unitPriceCents: 6942500,
    lineTotalCents: 13885000, taxPct: "5", confidence: 1,
    lineTotalTaxBasis: "gross", unitPriceTaxBasis: "gross", lineIncCents: 4977400,
  },
  netCents: 8483429, taxCents: 424171, incCents: 4977400, totalCents: 13885000,
};

async function confirmAmountReview(page: Page, uploadId: string, mode: "draft" | "receive") {
  await page.getByRole("button", { name: mode === "draft" ? t.invReviewModeDraft : t.invReviewModeReceive, exact: true }).click();
  const response = page.waitForResponse(r => r.url().endsWith(`/purchase-invoices/${uploadId}/confirm`) && r.request().method() === "POST");
  await page.getByRole("button", { name: t.invReviewConfirm, exact: true }).click();
  expect((await response).status()).toBe(201);
  await expect(page.getByRole("dialog", { name: t.invReviewTitle, exact: true })).toHaveCount(0);
}

async function savedAmountOrder(restaurantId: string, expected: AmountFixture, received: boolean) {
  const orders = await db.purchaseOrder.findMany({ where: { restaurantId }, include: { items: true } });
  expect(orders).toHaveLength(1);
  const po = orders[0];
  expect(po).toMatchObject({ status: received ? "received" : "draft", incCents: expected.incCents });
  expect(po.items).toHaveLength(1);
  const item = po.items[0];
  expect(item).toMatchObject({ qtyOrderedBase: 2000, expectedCostCents: expected.netCents, expectedTaxCents: expected.taxCents, expectedIncCents: expected.incCents, taxPct: 5 });
  expect(item.expectedCostCents + item.expectedTaxCents! + po.incCents).toBe(expected.totalCents);
  const stock = await db.stockMovement.findMany({ where: { restaurantId, kind: "purchase_in", purchaseOrderId: po.id } });
  if (received) {
    expect(item).toMatchObject({ receivedQtyBase: 2000, receivedCostCents: expected.netCents });
    expect(stock).toHaveLength(1);
    expect(stock[0]).toMatchObject({ qtyBase: 2000, valueCents: expected.totalCents });
  } else expect(stock).toHaveLength(0);
  return po;
}

for (const mode of ["draft", "receive"] as const) {
  test(`gross total includes VAT and fixed consumption once through ${mode}, reopening and receipt`, async ({ page }) => {
    const f = await setup(page, grossWithConsumption);
    try {
      const card = f.cards.first();
      await expect(card.getByLabel(t.invLineAmountKind, { exact: true })).toHaveValue("line");
      await expect(card.getByRole("checkbox", { name: t.invLineTaxIncluded, exact: true })).toBeChecked();
      await expect(card.getByLabel(`${t.invLineAmount} (COP)`)).toHaveValue("138.850");
      await expect(card.getByLabel(t.invLineIncAmount, { exact: true })).toHaveValue("49.774");
      const preview = card.getByTestId("invoice-line-amounts");
      await expect(preview.getByText(t.invLineFinalAmount, { exact: true }).locator("..")).toContainText("138.850");
      await expect(preview).toContainText(/Final por un:.*69\.425/);
      await expect(page.getByText(t.invTaxGrandTotal, { exact: true }).locator("..")).toContainText("138.850");
      await preview.scrollIntoViewIfNeeded();
      await page.screenshot({ animations: "disabled", path: test.info().outputPath(`gross-vat-consumption-${mode}.png`) });
      await confirmAmountReview(page, f.upload.id, mode);
      const po = await savedAmountOrder(f.restaurant.id, grossWithConsumption, mode === "receive");
      await page.reload();
      const row = page.getByRole("button", { name: new RegExp(`OC-${String(po.number).padStart(4, "0")} `) });
      await expect(row).toContainText("138.850");
      await row.click();
      await expect(page.getByRole("heading", { name: `OC-${String(po.number).padStart(4, "0")}`, exact: true })).toBeVisible();
      if (mode === "draft") {
        await page.getByRole("button", { name: t.receiveGoods, exact: true }).click();
        const netCost = page.getByLabel(`${t.fieldRealCost} (COP)`);
        await expect(netCost).toHaveValue("84.834,29");
        await netCost.fill("84834,29");
        await expect(netCost).toHaveValue("84.834,29");
        const receipt = page.waitForResponse(r => r.url().endsWith(`/purchase-orders/${po.id}/receive`) && r.request().method() === "POST");
        await page.getByRole("button", { name: t.receiveSubmit, exact: true }).click();
        const result = await receipt;
        expect(result.request().postDataJSON().lines[0].costCents).toBe(8483429);
        expect(result.status()).toBe(200);
      }
      await savedAmountOrder(f.restaurant.id, grossWithConsumption, true);
    } finally { await f.cleanup(); }
  });
}

test("VAT-only gross line preserves the invoice total and cent rounding", async ({ page }) => {
  const expected: AmountFixture = {
    ...grossWithConsumption,
    line: { ...grossWithConsumption.line, lineIncCents: 0 },
    netCents: 13223810, taxCents: 661190, incCents: 0,
  };
  const f = await setup(page, expected);
  try {
    await expect(f.cards.first().getByTestId("invoice-line-amounts")).toContainText(/Final por un:.*69\.425/);
    await confirmAmountReview(page, f.upload.id, "receive");
    await savedAmountOrder(f.restaurant.id, expected, true);
  } finally { await f.cleanup(); }
});

test("a unit-only gross price is multiplied by quantity exactly once", async ({ page }) => {
  const expected: AmountFixture = { ...grossWithConsumption, line: { ...grossWithConsumption.line, lineTotalCents: null } };
  const f = await setup(page, expected);
  try {
    const card = f.cards.first();
    await expect(card.getByLabel(t.invLineAmountKind, { exact: true })).toHaveValue("unit");
    await expect(card.getByLabel(`${t.invUnitAmount} (COP)`)).toHaveValue("69.425");
    await expect(card.getByTestId("invoice-line-amounts").getByText(t.invLineFinalAmount, { exact: true }).locator("..")).toContainText("138.850");
    await confirmAmountReview(page, f.upload.id, "receive");
    await savedAmountOrder(f.restaurant.id, expected, true);
  } finally { await f.cleanup(); }
});

test("legacy unknown tax basis and ambiguous consumption require explicit review", async ({ page }) => {
  const unknown: AmountFixture = {
    ...grossWithConsumption, incCents: 0,
    line: { ...grossWithConsumption.line, lineTotalTaxBasis: undefined, taxPct: null, lineIncCents: null, lineIncAmbiguous: true },
  };
  const f = await setup(page, unknown);
  try {
    const card = f.cards.first();
    await expect(card.getByRole("checkbox", { name: t.invLineTaxIncluded, exact: true })).toHaveAttribute("aria-checked", "mixed");
    let confirmations = 0;
    page.on("request", request => { if (request.method() === "POST" && request.url().endsWith(`/purchase-invoices/${f.upload.id}/confirm`)) confirmations++; });
    await page.getByRole("button", { name: t.invReviewConfirm, exact: true }).click();
    await expect(page.getByText(t.invLineReviewAmounts, { exact: true }).first()).toBeVisible();
    expect(confirmations).toBe(0);
    expect(await db.purchaseOrder.count({ where: { restaurantId: f.restaurant.id } })).toBe(0);
    await card.getByRole("checkbox", { name: t.invLineTaxIncluded, exact: true }).check();
    await card.getByLabel(t.fieldTaxPct, { exact: true }).selectOption("5");
    await page.getByRole("button", { name: t.invReviewConfirm, exact: true }).click();
    expect(confirmations, "Blank ambiguous consumption must not silently become zero").toBe(0);
    await card.getByLabel(t.invLineIncAmount, { exact: true }).fill("49774");
    await confirmAmountReview(page, f.upload.id, "receive");
    expect(confirmations).toBe(1);
    await savedAmountOrder(f.restaurant.id, grossWithConsumption, true);
  } finally { await f.cleanup(); }
});

test("unallocated document consumption blocks gross lines until distributed without duplication", async ({ page }) => {
  const f = await setup(page, { ...grossWithConsumption, line: { ...grossWithConsumption.line, lineIncCents: null } });
  try {
    const card = f.cards.first();
    await expect(page.getByRole("alert").filter({ hasText: t.invLineUnallocatedConsumption })).toBeVisible();
    await page.getByRole("button", { name: t.invReviewConfirm, exact: true }).click();
    expect(await db.purchaseOrder.count({ where: { restaurantId: f.restaurant.id } })).toBe(0);
    await card.getByLabel(t.invLineIncAmount, { exact: true }).fill("49774");
    await expect(page.getByLabel(t.invLineUnassignedInc, { exact: true })).toHaveValue("");
    await expect(page.getByRole("alert").filter({ hasText: t.invLineUnallocatedConsumption })).toHaveCount(0);
    await confirmAmountReview(page, f.upload.id, "receive");
    await savedAmountOrder(f.restaurant.id, grossWithConsumption, true);
  } finally { await f.cleanup(); }
});

test.afterAll(async () => {
  for (const restaurantId of fixtureTenantIds) await cleanupFixture(restaurantId);
  await db.$disconnect();
});
