import { test, expect, type Locator, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import es from "../messages/es.json";
import type { PurchaseInvoiceExtraction } from "../src/lib/anthropic";
import type { InvoiceMatch } from "../src/lib/erp/invoiceMatch";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(
  !["localhost", "127.0.0.1"].includes(databaseUrl.hostname)
  || !/^\/mesapay_.*validation$/.test(databaseUrl.pathname)
  || !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""),
  "An isolated local app and validation database are required",
);
const db = new PrismaClient();
const t = es.opErp;
const fixtureTenantIds = new Set<string>();
const printedDescription = "REF 700 GORDONS DRY";
test.setTimeout(90_000);

function lineCards(page: Page) {
  return page.locator("div.rounded-2xl")
    .filter({ has: page.getByRole("button", { name: t.invReviewRemoveLine, exact: true }) })
    .filter({ has: page.getByLabel(t.fieldTaxPct, { exact: true }) });
}

function rememberCheckbox(card: Locator) {
  return card.getByRole("checkbox", { name: t.invAliasRemember, exact: true });
}

async function readMatch(page: Page, uploadId: string, supplierId?: string) {
  const query = supplierId ? `?supplierId=${encodeURIComponent(supplierId)}` : "";
  const response = await page.request.get(`/api/operator/purchase-invoices/${uploadId}${query}`);
  expect(response.status()).toBe(200);
  const body = await response.json() as {
    upload: { id: string; fileUrl: string; extraction: PurchaseInvoiceExtraction };
    match: InvoiceMatch;
  };
  expect(body.match).toBeTruthy();
  expect(body.match.lines.length).toBe(body.upload.extraction.lines.length);
  return body;
}

async function setup(page: Page) {
  page.setDefaultTimeout(15_000);
  const token = randomUUID();
  const password = `Alias-${token}`;
  const clientHeaders = {
    "x-real-ip": `127.1.${parseInt(token.slice(0, 2), 16)}.${parseInt(token.slice(2, 4), 16)}`,
  };
  await page.setExtraHTTPHeaders(clientHeaders);
  const restaurant = await db.restaurant.create({ data: {
    name: "Relaciones de factura de prueba",
    slug: `invoice-alias-${token}`,
    enabledModules: ["inventory", "purchasing"],
    purchaseIvaDeductible: false,
  } });
  fixtureTenantIds.add(restaurant.id);
  const user = await db.user.create({ data: {
    email: `invoice-alias-${token}@example.test`,
    passwordHash: await bcrypt.hash(password, 4),
    role: "operator",
    restaurantId: restaurant.id,
  } });
  const supplier = await db.supplier.create({ data: {
    restaurantId: restaurant.id, name: "Distribuidora Norte", taxId: "900111111",
  } });
  const otherSupplier = await db.supplier.create({ data: {
    restaurantId: restaurant.id, name: "Comercializadora Sur", taxId: "900222222",
  } });
  const ingredient = await db.ingredient.create({ data: {
    restaurantId: restaurant.id, name: "Ginebra de la casa", measureKind: "count",
  } });
  const replacement = await db.ingredient.create({ data: {
    restaurantId: restaurant.id, name: "Aperitivo de barra", measureKind: "count",
  } });
  let nextOcrResponse: {
    uploadId: string;
    fileUrl: string;
    extraction: PurchaseInvoiceExtraction;
    match: InvoiceMatch;
  } | null = null;
  await page.route(/^https?:\/\//, route => (
    ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname)
      ? route.continue() : route.abort()
  ));
  await page.route("**/alias-invoice.png", route => route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><text x="10" y="40">FACTURA SINTETICA</text></svg>',
  }));
  // Stub only OCR/upload transport. Matching, catalog reads, confirmation and
  // persistence all use the real authenticated API and isolated database.
  await page.route("**/api/operator/purchase-invoices", async route => {
    if (route.request().method() !== "POST") return route.continue();
    expect(nextOcrResponse).not.toBeNull();
    const response = nextOcrResponse;
    nextOcrResponse = null;
    await route.fulfill({ json: response });
  });
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const login = await page.request.post("/api/auth/callback/credentials", {
    headers: { ...clientHeaders, "X-Auth-Return-Redirect": "1" },
    form: {
      csrfToken: csrf.csrfToken,
      email: user.email,
      password,
      callbackUrl: `${process.env.PLAYWRIGHT_BASE_URL}/operator/compras`,
    },
  });
  expect(login.ok()).toBe(true);
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(user.id);

  async function importInvoice({
    from = supplier,
    descriptions = [printedDescription],
  }: {
    from?: typeof supplier;
    descriptions?: string[];
  } = {}) {
    const extraction: PurchaseInvoiceExtraction = {
      documentType: "factura",
      supplierNit: from.taxId,
      supplierName: from.name,
      supplierInvoiceNumber: `ALIAS-${randomUUID().slice(0, 8)}`,
      issueDate: "2026-10-20",
      currency: "COP",
      lines: descriptions.map(description => ({
        description, quantity: 2, unit: "un",
        unitPriceCents: 1000000, lineTotalCents: 2000000,
        taxPct: "0", confidence: 1,
        lineTotalTaxBasis: "net", unitPriceTaxBasis: "net",
        lineIncCents: 0,
      })),
      invoiceSubtotalCents: 2000000 * descriptions.length,
      invoiceTaxCents: 0,
      invoiceTotalCents: 2000000 * descriptions.length,
      invoiceIncCents: 0, retefuenteCents: 0, reteIvaCents: 0, reteIcaCents: 0,
      confidence: 1,
      notes: "",
    };
    const upload = await db.purchaseInvoiceUpload.create({ data: {
      restaurantId: restaurant.id, fileUrl: "/alias-invoice.png", extraction,
    } });
    const real = await readMatch(page, upload.id);
    nextOcrResponse = {
      uploadId: real.upload.id, fileUrl: real.upload.fileUrl,
      extraction: real.upload.extraction, match: real.match,
    };
    // A fresh visit represents a later invoice and closes the previous order's
    // detail sheet, while retaining the same authenticated operator.
    await page.goto("/operator/compras");
    // Wait for an actual React interaction before dispatching the file event.
    // WebKit can expose the server-rendered input before hydration finishes.
    await page.getByRole("tab", { name: t.tabUnpaid, exact: true }).click();
    await expect(page.getByRole("tab", { name: t.tabUnpaid, exact: true })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: t.tabOrders, exact: true }).click();
    await expect(page.getByRole("tab", { name: t.tabOrders, exact: true })).toHaveAttribute("aria-selected", "true");
    await page.locator("#inv-upload-file").setInputFiles({
      name: `${upload.id}.png`, mimeType: "image/png", buffer: Buffer.from("synthetic OCR fixture"),
    });
    await expect(page.getByRole("heading", { name: t.invReviewTitle, exact: true })).toBeVisible();
    await expect(lineCards(page)).toHaveCount(descriptions.length);
    return { upload, match: real.match, cards: lineCards(page) };
  }

  return {
    restaurant, supplier, otherSupplier, ingredient, replacement, importInvoice,
    aliases: () => db.supplierInvoiceAlias.findMany({
      where: { supplier: { restaurantId: restaurant.id } },
      orderBy: { createdAt: "asc" },
    }),
    cleanup: async () => {
      await page.goto("about:blank");
      await cleanupFixture(restaurant.id);
    },
  };
}

async function chooseIngredient(card: Locator, ingredient: { name: string }) {
  const existing = card.getByRole("button", { name: t.invReviewChangeIngredient, exact: true });
  if (await existing.count()) await existing.click();
  else await card.getByRole("button", { name: t.invReviewUseExistingIngredient, exact: true }).click();
  await card.getByPlaceholder(t.ingredientSearchPlaceholder).fill(ingredient.name);
  await card.getByRole("button", { name: new RegExp(ingredient.name) }).click();
  await expect(card.getByText(ingredient.name, { exact: true })).toBeVisible();
  await expect(rememberCheckbox(card)).toBeChecked();
}

async function confirm(page: Page, uploadId: string, mode: "draft" | "receive" = "draft") {
  await page.getByRole("button", {
    name: mode === "draft" ? t.invReviewModeDraft : t.invReviewModeReceive, exact: true,
  }).click();
  const responsePromise = page.waitForResponse(response =>
    response.url().endsWith(`/purchase-invoices/${uploadId}/confirm`)
    && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: t.invReviewConfirm, exact: true }).click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBe(201);
  const payload = response.request().postDataJSON();
  await expect(page.getByRole("dialog", { name: t.invReviewTitle, exact: true })).toHaveCount(0);
  const savedUpload = await db.purchaseInvoiceUpload.findUniqueOrThrow({ where: { id: uploadId } });
  expect(savedUpload.status).toBe("confirmed");
  const order = await db.purchaseOrder.findUniqueOrThrow({
    where: { id: savedUpload.purchaseOrderId! }, include: { items: true },
  });
  expect(order.status).toBe(mode === "draft" ? "draft" : "received");
  return { order, payload };
}

async function selectSupplier(page: Page, supplier: { id: string; name: string }) {
  const dialog = page.getByRole("dialog", { name: t.invReviewTitle, exact: true });
  await dialog.getByRole("button", { name: t.changeSupplier, exact: true }).click();
  await dialog.getByPlaceholder(t.supplierSearchPlaceholder).fill(supplier.name);
  await dialog.getByRole("button", { name: supplier.name, exact: true }).click();
}

async function changeSupplier(page: Page, uploadId: string, supplier: { id: string; name: string }) {
  const responsePromise = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname.endsWith(`/purchase-invoices/${uploadId}`)
      && url.searchParams.get("supplierId") === supplier.id;
  });
  await selectSupplier(page, supplier);
  expect((await responsePromise).status()).toBe(200);
  await expect(page.getByText(t.invAliasLoading, { exact: true })).toHaveCount(0);
}

async function seedPreviousRelations(f: Awaited<ReturnType<typeof setup>>) {
  // Existing confirmed relations are fixture data for transport/race tests.
  // Their application is still read through the real matching endpoint.
  await db.supplierInvoiceAlias.createMany({ data: [
    { supplierId: f.supplier.id, ingredientId: f.ingredient.id,
      sourceDescription: printedDescription, normalizedDescription: "ref 700 gordons dry" },
    { supplierId: f.otherSupplier.id, ingredientId: f.replacement.id,
      sourceDescription: printedDescription, normalizedDescription: "ref 700 gordons dry" },
  ] });
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
  test(`remembered supplier wording reuses the existing ingredient after ${mode}`, async ({ page }) => {
    const f = await setup(page);
    try {
      const first = await f.importInvoice();
      expect(first.match.lines[0].ingredient.kind).toBe("suggest_create");
      await chooseIngredient(first.cards.first(), f.ingredient);
      if (mode === "draft") {
        await rememberCheckbox(first.cards.first()).scrollIntoViewIfNeeded();
        await page.screenshot({
          animations: "disabled", path: test.info().outputPath("remember-supplier-choice.png"),
        });
      }
      const saved = await confirm(page, first.upload.id, mode);
      expect(saved.payload.lines[0]).toMatchObject({
        sourceLineIndex: 0, rememberMatch: true, ingredientId: f.ingredient.id,
      });
      expect(saved.order.items[0]).toMatchObject({
        ingredientId: f.ingredient.id, qtyOrderedBase: 2000, expectedCostCents: 2000000,
      });
      expect(await f.aliases()).toEqual([expect.objectContaining({
        supplierId: f.supplier.id, ingredientId: f.ingredient.id,
        sourceDescription: printedDescription, normalizedDescription: "ref 700 gordons dry",
      })]);

      const second = await f.importInvoice();
      expect(second.match.lines[0]).toMatchObject({
        sourceLineIndex: 0, matchSource: "alias",
        ingredient: { kind: "matched", ingredient: { id: f.ingredient.id } },
      });
      const card = second.cards.first();
      await expect(card.getByText(t.invAliasSaved, { exact: true })).toBeVisible();
      await expect(card.getByText(f.ingredient.name, { exact: true })).toBeVisible();
      await expect(card.getByLabel(t.fieldQty)).toHaveValue("2");
      await expect(card.getByLabel(`${t.invLineAmount} (COP)`)).toHaveValue("20.000");
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({
        animations: "disabled", path: test.info().outputPath(`remembered-supplier-${mode}.png`),
      });
      const importedAgain = await confirm(page, second.upload.id, mode);
      expect(importedAgain.payload.lines[0]).toMatchObject({
        ingredientId: f.ingredient.id, rememberMatch: false,
      });
      expect(importedAgain.order.items[0]).toMatchObject({
        ingredientId: f.ingredient.id, qtyOrderedBase: 2000, expectedCostCents: 2000000,
      });
      expect(await f.aliases()).toHaveLength(1);
      expect(await db.ingredient.count({ where: { restaurantId: f.restaurant.id } })).toBe(2);
      const stock = await db.stockMovement.findMany({
        where: { restaurantId: f.restaurant.id, kind: "purchase_in" },
      });
      expect(stock).toHaveLength(mode === "receive" ? 2 : 0);
      if (mode === "receive") {
        for (const movement of stock) expect(movement).toMatchObject({
          ingredientId: f.ingredient.id, qtyBase: 2000, valueCents: 2000000,
        });
      }
    } finally { await f.cleanup(); }
  });
}

test("correcting a remembered ingredient updates its relation without creating another ingredient", async ({ page }) => {
  const f = await setup(page);
  try {
    const first = await f.importInvoice();
    await chooseIngredient(first.cards.first(), f.ingredient);
    await confirm(page, first.upload.id);
    const previousAlias = (await f.aliases())[0];
    const second = await f.importInvoice();
    await expect(second.cards.first().getByText(t.invAliasSaved, { exact: true })).toBeVisible();
    await chooseIngredient(second.cards.first(), f.replacement);
    await expect(second.cards.first().getByText(t.invAliasSaved, { exact: true })).toHaveCount(0);
    await confirm(page, second.upload.id);
    expect(await f.aliases()).toEqual([expect.objectContaining({
      id: previousAlias.id, ingredientId: f.replacement.id, supplierId: f.supplier.id,
    })]);
    const third = await f.importInvoice();
    expect(third.match.lines[0]).toMatchObject({
      matchSource: "alias", ingredient: { kind: "matched", ingredient: { id: f.replacement.id } },
    });
    await expect(third.cards.first().getByText(f.replacement.name, { exact: true })).toBeVisible();
    expect(await db.ingredient.count({ where: { restaurantId: f.restaurant.id } })).toBe(2);
  } finally { await f.cleanup(); }
});

test("opting out saves the chosen ingredient without learning the supplier wording", async ({ page }) => {
  const f = await setup(page);
  try {
    const first = await f.importInvoice();
    await chooseIngredient(first.cards.first(), f.ingredient);
    await rememberCheckbox(first.cards.first()).uncheck();
    const saved = await confirm(page, first.upload.id);
    expect(saved.payload.lines[0]).toMatchObject({ ingredientId: f.ingredient.id, rememberMatch: false });
    expect(saved.order.items[0].ingredientId).toBe(f.ingredient.id);
    expect(await f.aliases()).toHaveLength(0);
    const second = await f.importInvoice();
    expect(second.match.lines[0].ingredient.kind).toBe("suggest_create");
    await expect(second.cards.first().getByText(t.invAliasSaved, { exact: true })).toHaveCount(0);
    await expect(second.cards.first().getByLabel(t.invReviewNewIngredientName)).toHaveValue(printedDescription);
    expect(await db.ingredient.count({ where: { restaurantId: f.restaurant.id } })).toBe(2);
  } finally { await f.cleanup(); }
});

test("two suppliers can use the same printed description for different ingredients", async ({ page }) => {
  const f = await setup(page);
  try {
    const first = await f.importInvoice();
    await chooseIngredient(first.cards.first(), f.ingredient);
    await confirm(page, first.upload.id);
    const other = await f.importInvoice({ from: f.otherSupplier });
    expect(other.match.supplier).toMatchObject({ kind: "matched", supplier: { id: f.otherSupplier.id } });
    expect(other.match.lines[0].ingredient.kind).toBe("suggest_create");
    await expect(other.cards.first().getByText(t.invAliasSaved, { exact: true })).toHaveCount(0);
    await chooseIngredient(other.cards.first(), f.replacement);
    await confirm(page, other.upload.id);
    const aliases = await f.aliases();
    expect(aliases).toHaveLength(2);
    expect(aliases).toEqual(expect.arrayContaining([
      expect.objectContaining({ supplierId: f.supplier.id, ingredientId: f.ingredient.id }),
      expect.objectContaining({ supplierId: f.otherSupplier.id, ingredientId: f.replacement.id }),
    ]));
    const again = await f.importInvoice();
    expect(again.match.lines[0].ingredient).toMatchObject({
      kind: "matched", ingredient: { id: f.ingredient.id },
    });
    const selectedOther = await readMatch(page, again.upload.id, f.otherSupplier.id);
    expect(selectedOther.match.lines[0]).toMatchObject({
      matchSource: "alias", ingredient: { kind: "matched", ingredient: { id: f.replacement.id } },
    });
  } finally { await f.cleanup(); }
});

test("an archived remembered ingredient requires manual correction before confirmation", async ({ page }) => {
  const f = await setup(page);
  try {
    const first = await f.importInvoice();
    await chooseIngredient(first.cards.first(), f.ingredient);
    await confirm(page, first.upload.id);
    await db.ingredient.update({ where: { id: f.ingredient.id }, data: { active: false } });
    const second = await f.importInvoice();
    expect(second.match.lines[0]).toMatchObject({
      aliasUnavailable: true, ingredient: { kind: "suggest_create" },
    });
    const card = second.cards.first();
    await expect(card.getByRole("alert")).toHaveText(t.invAliasUnavailable);
    await page.getByRole("button", { name: t.invReviewConfirm, exact: true }).click();
    await expect(page.getByRole("dialog", { name: t.invReviewTitle, exact: true })).toBeVisible();
    expect(await db.purchaseOrder.count({ where: { restaurantId: f.restaurant.id } })).toBe(1);
    expect((await db.purchaseInvoiceUpload.findUniqueOrThrow({ where: { id: second.upload.id } })).status).toBe("pending");
    await chooseIngredient(card, f.replacement);
    await expect(card.getByRole("alert")).toHaveCount(0);
    const corrected = await confirm(page, second.upload.id);
    expect(corrected.order.items[0].ingredientId).toBe(f.replacement.id);
    expect(await f.aliases()).toEqual([expect.objectContaining({ ingredientId: f.replacement.id })]);
    expect(await db.ingredient.count({ where: { restaurantId: f.restaurant.id } })).toBe(2);
  } finally { await f.cleanup(); }
});

test("changing supplier clears an automatic relation but preserves a manual choice without learning it", async ({ page }) => {
  const f = await setup(page);
  try {
    const first = await f.importInvoice();
    await chooseIngredient(first.cards.first(), f.ingredient);
    await confirm(page, first.upload.id);
    const second = await f.importInvoice();
    const card = second.cards.first();
    await card.getByLabel(t.fieldQty).fill("3");
    await card.getByLabel(`${t.invLineAmount} (COP)`).fill("45000");
    await changeSupplier(page, second.upload.id, f.otherSupplier);
    await expect(card.getByText(t.invAliasSaved, { exact: true })).toHaveCount(0);
    await expect(card.getByLabel(t.invReviewNewIngredientName)).toHaveValue(printedDescription);
    await expect(card.getByLabel(t.fieldQty)).toHaveValue("3");
    await expect(card.getByLabel(`${t.invLineAmount} (COP)`)).toHaveValue("45.000");
    await chooseIngredient(card, f.replacement);
    await changeSupplier(page, second.upload.id, f.supplier);
    await expect(card.getByText(f.replacement.name, { exact: true })).toBeVisible();
    await expect(rememberCheckbox(card)).not.toBeChecked();
    await expect(card.getByLabel(t.fieldQty)).toHaveValue("3");
    await expect(card.getByLabel(`${t.invLineAmount} (COP)`)).toHaveValue("45.000");
    const saved = await confirm(page, second.upload.id);
    expect(saved.payload).toMatchObject({
      supplierId: f.supplier.id,
      lines: [expect.objectContaining({ ingredientId: f.replacement.id, rememberMatch: false })],
    });
    expect(saved.order.items[0]).toMatchObject({
      ingredientId: f.replacement.id, qtyOrderedBase: 3000, expectedCostCents: 4500000,
    });
    expect(await f.aliases()).toEqual([expect.objectContaining({
      supplierId: f.supplier.id, ingredientId: f.ingredient.id,
    })]);
  } finally { await f.cleanup(); }
});

test("removing an earlier OCR line learns the remaining line's original source index", async ({ page }) => {
  const f = await setup(page);
  try {
    const descriptions = ["COD 010 PRODUCTO OMITIDO", printedDescription];
    const first = await f.importInvoice({ descriptions });
    await first.cards.first().getByRole("button", { name: t.invReviewRemoveLine, exact: true }).click();
    await expect(first.cards).toHaveCount(1);
    await chooseIngredient(first.cards.first(), f.ingredient);
    const saved = await confirm(page, first.upload.id);
    expect(saved.payload.lines).toEqual([expect.objectContaining({
      sourceLineIndex: 1, ingredientId: f.ingredient.id, rememberMatch: true,
    })]);
    expect(await f.aliases()).toEqual([expect.objectContaining({
      sourceDescription: printedDescription, ingredientId: f.ingredient.id,
    })]);
    const second = await f.importInvoice({ descriptions });
    expect(second.match.lines[0].ingredient.kind).toBe("suggest_create");
    expect(second.match.lines[1]).toMatchObject({
      sourceLineIndex: 1, matchSource: "alias",
      ingredient: { kind: "matched", ingredient: { id: f.ingredient.id } },
    });
    await expect(second.cards.nth(1).getByText(t.invAliasSaved, { exact: true })).toBeVisible();
    await expect(second.cards.first().getByText(t.invAliasSaved, { exact: true })).toHaveCount(0);
  } finally { await f.cleanup(); }
});

test("a late supplier response cannot replace an ingredient selected while matching is pending", async ({ page }) => {
  const f = await setup(page);
  let releaseResponse = () => {};
  const release = new Promise<void>(resolve => { releaseResponse = resolve; });
  try {
    await seedPreviousRelations(f);
    const review = await f.importInvoice();
    const endpoint = `**/api/operator/purchase-invoices/${review.upload.id}?supplierId=${f.otherSupplier.id}`;
    let actualResponseReady = false;
    await page.route(endpoint, async route => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      actualResponseReady = true;
      await release;
      await route.fulfill({ response });
    });
    await selectSupplier(page, f.otherSupplier);
    await expect.poll(() => actualResponseReady).toBe(true);
    await expect(page.getByText(t.invAliasLoading, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: t.invReviewConfirm, exact: true })).toBeDisabled();
    const card = review.cards.first();
    await chooseIngredient(card, f.ingredient);
    await card.getByLabel(t.fieldQty).fill("4");
    await card.getByLabel(`${t.invLineAmount} (COP)`).fill("60000");
    const responsePromise = page.waitForResponse(response =>
      response.url().includes(`${review.upload.id}?supplierId=${f.otherSupplier.id}`),
    );
    releaseResponse();
    expect((await responsePromise).status()).toBe(200);
    await expect(page.getByText(t.invAliasLoading, { exact: true })).toHaveCount(0);
    await expect(card.getByText(f.ingredient.name, { exact: true })).toBeVisible();
    await expect(card.getByText(f.replacement.name, { exact: true })).toHaveCount(0);
    await expect(rememberCheckbox(card)).toBeChecked();
    await expect(card.getByLabel(t.fieldQty)).toHaveValue("4");
    await expect(card.getByLabel(`${t.invLineAmount} (COP)`)).toHaveValue("60.000");
    const saved = await confirm(page, review.upload.id);
    expect(saved.payload).toMatchObject({
      supplierId: f.otherSupplier.id,
      lines: [expect.objectContaining({ ingredientId: f.ingredient.id, rememberMatch: true })],
    });
    expect(saved.order.items[0]).toMatchObject({
      ingredientId: f.ingredient.id, qtyOrderedBase: 4000, expectedCostCents: 6000000,
    });
    expect(await f.aliases()).toEqual(expect.arrayContaining([
      expect.objectContaining({ supplierId: f.otherSupplier.id, ingredientId: f.ingredient.id }),
    ]));
  } finally {
    releaseResponse();
    await f.cleanup();
  }
});

test("checking Remember protects the current ingredient from a late supplier response", async ({ page }) => {
  const f = await setup(page);
  let releaseResponse = () => {};
  const release = new Promise<void>(resolve => { releaseResponse = resolve; });
  try {
    await db.supplierInvoiceAlias.create({ data: {
      supplierId: f.otherSupplier.id, ingredientId: f.replacement.id,
      sourceDescription: f.ingredient.name, normalizedDescription: f.ingredient.name.toLowerCase(),
    } });
    const review = await f.importInvoice({ descriptions: [f.ingredient.name] });
    expect(review.match.lines[0].matchSource).toBe("name");
    const endpoint = `**/api/operator/purchase-invoices/${review.upload.id}?supplierId=${f.otherSupplier.id}`;
    let actualResponseReady = false;
    await page.route(endpoint, async route => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      actualResponseReady = true;
      await release;
      await route.fulfill({ response });
    });
    await selectSupplier(page, f.otherSupplier);
    await expect.poll(() => actualResponseReady).toBe(true);
    const card = review.cards.first();
    await expect(rememberCheckbox(card)).not.toBeChecked();
    await rememberCheckbox(card).check();
    const responsePromise = page.waitForResponse(response =>
      response.url().includes(`${review.upload.id}?supplierId=${f.otherSupplier.id}`),
    );
    releaseResponse();
    expect((await responsePromise).status()).toBe(200);
    await expect(page.getByText(t.invAliasLoading, { exact: true })).toHaveCount(0);
    await expect(card.getByText(f.ingredient.name, { exact: true })).toBeVisible();
    await expect(rememberCheckbox(card)).toBeChecked();
    const saved = await confirm(page, review.upload.id);
    expect(saved.payload.lines[0]).toMatchObject({ ingredientId: f.ingredient.id, rememberMatch: true });
    expect(await f.aliases()).toEqual([expect.objectContaining({
      supplierId: f.otherSupplier.id, ingredientId: f.ingredient.id,
    })]);
  } finally {
    releaseResponse();
    await f.cleanup();
  }
});

for (const selectDuringError of [false, true]) {
test(`failed supplier rematch preserves amounts and manual remembering=${selectDuringError} after retry`, async ({ page }) => {
  const f = await setup(page);
  try {
    await seedPreviousRelations(f);
    const review = await f.importInvoice();
    const card = review.cards.first();
    await card.getByLabel(t.fieldQty).fill("4");
    await card.getByLabel(`${t.invLineAmount} (COP)`).fill("60000");
    const endpoint = `**/api/operator/purchase-invoices/${review.upload.id}?supplierId=${f.otherSupplier.id}`;
    let attempts = 0;
    await page.route(endpoint, route => ++attempts === 1 ? route.abort("failed") : route.continue());
    await selectSupplier(page, f.otherSupplier);
    const dialog = page.getByRole("dialog", { name: t.invReviewTitle, exact: true });
    await expect(dialog.getByRole("alert")).toContainText(t.invAliasLoadError);
    await expect(dialog.getByRole("button", { name: t.invReviewConfirm, exact: true })).toBeDisabled();
    await expect(card.getByText(t.invAliasSaved, { exact: true })).toHaveCount(0);
    await expect(card.getByLabel(t.fieldQty)).toHaveValue("4");
    await expect(card.getByLabel(`${t.invLineAmount} (COP)`)).toHaveValue("60.000");
    expect(await db.purchaseOrder.count({ where: { restaurantId: f.restaurant.id } })).toBe(0);
    if (selectDuringError) await chooseIngredient(card, f.ingredient);
    const responsePromise = page.waitForResponse(response =>
      response.url().includes(`${review.upload.id}?supplierId=${f.otherSupplier.id}`),
    );
    await dialog.getByRole("button", { name: t.invAliasRetry, exact: true }).click();
    expect((await responsePromise).status()).toBe(200);
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    if (selectDuringError) {
      await expect(card.getByText(t.invAliasSaved, { exact: true })).toHaveCount(0);
      await expect(rememberCheckbox(card)).toBeChecked();
    } else {
      await expect(card.getByText(t.invAliasSaved, { exact: true })).toBeVisible();
    }
    const chosenIngredient = selectDuringError ? f.ingredient : f.replacement;
    await expect(card.getByText(chosenIngredient.name, { exact: true })).toBeVisible();
    await expect(card.getByLabel(t.fieldQty)).toHaveValue("4");
    await expect(card.getByLabel(`${t.invLineAmount} (COP)`)).toHaveValue("60.000");
    expect(attempts).toBe(2);
    const saved = await confirm(page, review.upload.id);
    expect(saved.order).toMatchObject({ supplierId: f.otherSupplier.id });
    expect(saved.order.items[0]).toMatchObject({
      ingredientId: chosenIngredient.id, qtyOrderedBase: 4000, expectedCostCents: 6000000,
    });
    expect(saved.payload.lines[0].rememberMatch).toBe(selectDuringError);
  } finally { await f.cleanup(); }
});
}

test.afterAll(async () => {
  for (const restaurantId of fixtureTenantIds) await cleanupFixture(restaurantId);
  await db.$disconnect();
});
