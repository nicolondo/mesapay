import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import es from "../messages/es.json";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!["localhost", "127.0.0.1"].includes(databaseUrl.hostname) || !/^\/mesapay_.*validation$/.test(databaseUrl.pathname) || !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""), "Isolated local app and validation database required");
const db = new PrismaClient();
const t = es.opErp;

async function setup(page: Page) {
  const token = randomUUID(), password = `Purchase-${token}`;
  // Independent local clients must not share the IP-based login throttle.
  const clientHeaders = { "x-real-ip": `127.0.${parseInt(token.slice(0, 2), 16)}.${parseInt(token.slice(2, 4), 16)}` };
  await page.setExtraHTTPHeaders(clientHeaders);
  const restaurant = await db.restaurant.create({ data: { name: "Importación de prueba", slug: `purchase-edit-${token}`, enabledModules: ["inventory", "purchasing"] } });
  const user = await db.user.create({ data: { email: `purchase-edit-${token}@example.test`, passwordHash: await bcrypt.hash(password, 4), role: "operator", restaurantId: restaurant.id } });
  const supplier = await db.supplier.create({ data: { restaurantId: restaurant.id, name: "Proveedor de prueba" } });
  const oldIngredient = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Arroz sugerido", measureKind: "mass" } });
  const replacement = await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Huevos corregidos", measureKind: "count" } });
  const presentation = await db.supplierIngredient.create({ data: { supplierId: supplier.id, ingredientId: oldIngredient.id, presentationLabel: "Bulto", contentQty: 25000 } });
  const extraction = {
    documentType: "factura", supplierNit: null, supplierName: supplier.name,
    supplierInvoiceNumber: "TEST-OCR", issueDate: "2026-10-15", currency: "COP",
    lines: [
      { description: oldIngredient.name, quantity: 2, unit: "kg", unitPriceCents: 1000000, lineTotalCents: 2000000, taxPct: "0", confidence: 1 },
      { description: "Insumo leído", quantity: 1, unit: "kg", unitPriceCents: 500000, lineTotalCents: 500000, taxPct: "0", confidence: 1 },
    ],
    invoiceSubtotalCents: 2500000, invoiceTaxCents: 0, invoiceTotalCents: 2500000,
    invoiceIncCents: 0, retefuenteCents: 0, reteIvaCents: 0, reteIcaCents: 0,
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
      lines: [
        { line: extraction.lines[0], lowConfidence: false, ingredient: { kind: "matched", ingredient: oldIngredient }, suggestedPresentation: { supplierItemId: presentation.id, presentationLabel: "Bulto", contentQty: 25000, lastPriceCents: null } },
        { line: extraction.lines[1], lowConfidence: false, ingredient: { kind: "suggest_create", name: "Insumo leído" }, suggestedPresentation: null },
      ], computedTotalCents: 2500000,
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
    await db.stockMovement.deleteMany({ where: { restaurantId: restaurant.id } });
    await db.supplierPriceHistory.deleteMany({ where: { supplierItem: { supplier: { restaurantId: restaurant.id } } } });
    await db.purchaseOrder.deleteMany({ where: { restaurantId: restaurant.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.restaurant.delete({ where: { id: restaurant.id } });
  } };
}

for (const mode of ["draft", "receive"] as const) {
  test(`corrected OCR line names, amounts and tax survive ${mode} and reopening`, async ({ page }) => {
    const f = await setup(page);
    try {
      await f.cards.nth(0).getByRole("button", { name: t.invReviewRemoveLine, exact: true }).click();
      const card = f.cards.nth(0);
      await card.getByLabel(t.invReviewNewIngredientName).fill("Harina corregida");
      await card.getByLabel(t.fieldQty).fill("2,75");
      await card.getByLabel(`${t.fieldExpectedCost} (COP)`).fill("38750");
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
    await card.getByLabel(`${t.fieldExpectedCost} (COP)`).fill("18000");
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
    await card.getByLabel(`${t.fieldExpectedCost} (COP)`).fill("25000");
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

test.afterAll(() => db.$disconnect());
