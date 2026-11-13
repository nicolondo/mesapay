import { test, expect, type Page, type Route } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import es from "../messages/es.json";

const application = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3411");
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(
  !["localhost", "127.0.0.1"].includes(application.hostname) ||
  !["localhost", "127.0.0.1"].includes(database.hostname) ||
  !/^\/mesapay_.*validation$/.test(database.pathname),
  "Invoice reading tests require isolated local services",
);
test.setTimeout(90_000);
test.use({ actionTimeout: 15_000, navigationTimeout: 60_000 });
const db = new PrismaClient();
const tenants = new Set<string>();
const t = es.opErp;
const retryLabel = "Reintentar lectura";
const anotherFileLabel = "Elegir otro archivo";
const fixtureFile = { name: "factura-de-prueba.png", mimeType: "image/png", buffer: Buffer.from("Local invoice fixture; never sent to an AI provider") };

type ReadFile = { name: string; type: string; content: string };

function successfulReading() {
  const line = { description: "Arroz de prueba", quantity: 2, unit: "un", unitPriceCents: 750_000, lineTotalCents: 1_500_000, taxPct: "0", confidence: 1, unitPriceTaxBasis: "net", lineTotalTaxBasis: "net" };
  return {
    uploadId: "local-invoice-read-fixture", fileUrl: "/invoice-read-fixture.svg",
    extraction: {
      documentType: "factura", supplierName: "Proveedor de prueba", supplierNit: null,
      supplierInvoiceNumber: "LECTURA-001", issueDate: "2026-11-08", currency: "COP", lines: [line],
      invoiceSubtotalCents: 1_500_000, invoiceTaxCents: 0, invoiceTotalCents: 1_500_000,
      invoiceIncCents: 0, retefuenteCents: 0, reteIvaCents: 0, reteIcaCents: 0, confidence: 1,
    },
    match: {
      supplier: { kind: "suggest_create", name: "Proveedor de prueba", nit: null },
      lines: [{ line, lowConfidence: false, ingredient: { kind: "suggest_create", name: line.description }, suggestedPresentation: null }],
      computedTotalCents: 1_500_000,
    },
  };
}

async function fixture(page: Page, read: (route: Route, attempt: number) => Promise<void>) {
  const uid = randomUUID();
  const headers = { "x-real-ip": `127.0.${parseInt(uid.slice(0, 2), 16)}.${parseInt(uid.slice(2, 4), 16)}` };
  await page.setExtraHTTPHeaders(headers);
  const restaurant = await db.restaurant.create({ data: { name: "Validación de lectura de facturas", slug: `invoice-read-${uid}`, country: "CO", enabledModules: ["inventory", "purchasing"] } });
  tenants.add(restaurant.id);
  const user = await db.user.create({ data: { restaurantId: restaurant.id, email: `invoice-read-${uid}@example.test`, role: "operator", passwordHash: await bcrypt.hash(uid, 4) } });
  await page.route(/^https?:\/\//, route => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.fallback() : route.abort());
  await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: "es", domain: application.hostname, path: "/" }]);
  // WebKit omits file bytes from Playwright's intercepted multipart body.
  // Observe the actual File passed to fetch as well, without replacing it.
  await page.addInitScript(() => {
    const observed: { name: string; type: string; content: string }[] = [];
    (window as unknown as { invoiceReadFiles: typeof observed }).invoiceReadFiles = observed;
    const originalFetch = window.fetch;
    window.fetch = async (input, init) => {
      if (input === "/api/operator/purchase-invoices" && init?.body instanceof FormData) {
        const file = init.body.get("file");
        if (file instanceof File) observed.push({ name: file.name, type: file.type, content: await file.text() });
      }
      return originalFetch.call(window, input, init);
    };
  });
  const files: ReadFile[] = [];
  let confirmations = 0;
  await page.route("**/api/operator/purchase-invoices", async route => {
    expect(route.request().method()).toBe("POST");
    const body = route.request().postDataBuffer();
    expect(body).not.toBeNull();
    const form = await new Request("http://localhost/invoice-fixture", { method: "POST", headers: { "content-type": route.request().headers()["content-type"] }, body: new Uint8Array(body!).buffer }).formData();
    const file = form.get("file") as File;
    files.push({ name: file.name, type: file.type, content: Buffer.from(await file.arrayBuffer()).toString("base64") });
    await read(route, files.length);
  });
  await page.route("**/api/operator/purchase-invoices/*/confirm", route => {
    confirmations++;
    return route.fulfill({ status: 409, json: { error: "local_test_no_confirmation" } });
  });
  await page.route("**/invoice-read-fixture.svg", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><text x="15" y="40">FACTURA DE PRUEBA</text></svg>' }));
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const login = await page.request.post("/api/auth/callback/credentials", { headers: { ...headers, "X-Auth-Return-Redirect": "1" }, form: { csrfToken: csrf.csrfToken, email: user.email, password: uid, callbackUrl: `${application.origin}/operator/compras` } });
  expect(login.ok()).toBe(true);
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(user.id);
  await page.goto("/operator/compras");
  // Wait for the interactive page before supplying the file. Switching
  // tabs also proves the response is handled by the hydrated client.
  await page.getByRole("tab", { name: t.tabUnpaid, exact: true }).click();
  await expect(page.getByRole("tab", { name: t.tabUnpaid, exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: t.tabOrders, exact: true }).click();
  await expect(page.getByRole("tab", { name: t.tabOrders, exact: true })).toHaveAttribute("aria-selected", "true");
  return { restaurantId: restaurant.id, files, confirmations: () => confirmations };
}

async function expectNoReview(page: Page) {
  await expect(page.getByRole("dialog", { name: t.invReviewTitle, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: t.invReviewConfirm, exact: true })).toHaveCount(0);
}

test.afterEach(async () => {
  for (const restaurantId of tenants) {
    expect(await db.purchaseOrder.count({ where: { restaurantId } })).toBe(0);
    expect(await db.purchaseInvoiceUpload.count({ where: { restaurantId } })).toBe(0);
    await db.user.deleteMany({ where: { restaurantId } });
    await db.restaurant.deleteMany({ where: { id: restaurantId } });
    tenants.delete(restaurantId);
  }
});
test.afterAll(() => db.$disconnect());

test("an incomplete reading stays out of review and retries the same file once", async ({ page }, info) => {
  let releaseRetry = () => {};
  const waitForRetry = new Promise<void>(resolve => { releaseRetry = resolve; });
  const f = await fixture(page, async (route, attempt) => {
    if (attempt === 1) return route.fulfill({ status: 502, json: { error: "ai_response_incomplete", message: "TECHNICAL_RAW_MAX_TOKENS" } });
    await waitForRetry;
    await route.fulfill({ json: successfulReading() });
  });
  await page.locator("#inv-upload-file").setInputFiles(fixtureFile);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("La lectura de la factura quedó incompleta");
  await expect(page.getByText("TECHNICAL_RAW_MAX_TOKENS")).toHaveCount(0);
  await expectNoReview(page);
  const retry = page.getByRole("button", { name: retryLabel, exact: true });
  await expect(retry).toBeEnabled();
  await expect(page.getByRole("button", { name: anotherFileLabel, exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath("invoice-read-incomplete.png"), animations: "disabled" });
  await retry.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect.poll(() => f.files.length).toBe(2);
  await expect(page.locator("#inv-upload-file")).toBeDisabled();
  await expect(page.getByText(t.invUploadReading, { exact: true })).toBeVisible();
  await expectNoReview(page);
  releaseRetry();
  await expect(page.getByRole("dialog", { name: t.invReviewTitle, exact: true })).toBeVisible();
  await expect(page.getByLabel(t.invReviewNewIngredientName)).toHaveValue("Arroz de prueba");
  await expect(page.getByTestId("invoice-line-amounts")).toContainText(/15[.,]000/);
  expect(f.files.map(({ name, type }) => ({ name, type }))).toEqual([1, 2].map(() => ({ name: fixtureFile.name, type: fixtureFile.mimeType })));
  const actualFiles = await page.evaluate(() => (window as unknown as { invoiceReadFiles: ReadFile[] }).invoiceReadFiles);
  expect(actualFiles).toEqual([1, 2].map(() => ({ name: fixtureFile.name, type: fixtureFile.mimeType, content: fixtureFile.buffer.toString() })));
  expect(f.confirmations()).toBe(0);
  await page.screenshot({ path: info.outputPath("invoice-read-retry-review.png"), animations: "disabled" });
});

test("reading errors show human messages, keep file selection available and never create an order", async ({ page }) => {
  const cases = [
    { status: 502, error: "ai_invalid_response", text: "No pudimos interpretar la lectura de esta factura" },
    { status: 504, error: "ai_timeout", text: "La lectura está tardando más de lo esperado" },
    { status: 422, error: "no_lines", text: "No encontramos productos o servicios para importar" },
    { status: 422, error: "not_a_document", text: "No pudimos reconocer una factura o cuenta de cobro" },
    { status: 500, error: "unknown_provider_error", text: "No se pudo leer la factura" },
    { status: 502, error: "network_failure", text: "No se pudo leer la factura" },
  ];
  const f = await fixture(page, async (route, attempt) => {
    const item = cases[attempt - 1];
    if (item.error === "network_failure") return route.abort("failed");
    return route.fulfill({ status: item.status, json: { error: item.error, message: "TECHNICAL_PROVIDER_JSON" } });
  });
  for (const [index, item] of cases.entries()) {
    await page.locator("#inv-upload-file").setInputFiles({ ...fixtureFile, name: `factura-alternativa-${index}.png` });
    await expect(page.getByRole("main").getByRole("alert")).toContainText(item.text);
    await expectNoReview(page);
    await expect(page.getByRole("button", { name: anotherFileLabel, exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: retryLabel, exact: true })).toBeEnabled();
    await expect(page.getByText("TECHNICAL_PROVIDER_JSON")).toHaveCount(0);
  }
  expect(f.files).toHaveLength(cases.length);
  expect(f.files.map(file => file.name)).toEqual(cases.map((_, index) => `factura-alternativa-${index}.png`));
  expect(f.confirmations()).toBe(0);
});

test("a success response with no lines or a malformed body cannot open a zero-value review", async ({ page }) => {
  const valid = successfulReading();
  const cases = [
    { body: { ...valid, extraction: { ...valid.extraction, lines: [], invoiceTotalCents: 0 }, match: { ...valid.match, lines: [], computedTotalCents: 0 } }, text: "No encontramos productos o servicios para importar" },
    { body: { ...valid, match: { ...valid.match, lines: [] } }, text: "No encontramos productos o servicios para importar" },
    { body: { error: "ai_response_incomplete" }, text: "La lectura de la factura quedó incompleta" },
    { body: {}, text: "No pudimos interpretar la lectura de esta factura" },
  ];
  const f = await fixture(page, (route, attempt) => route.fulfill({ json: cases[attempt - 1].body }));
  for (const item of cases) {
    await page.locator("#inv-upload-file").setInputFiles(fixtureFile);
    await expect(page.getByRole("main").getByRole("alert")).toContainText(item.text);
    await expectNoReview(page);
  }
  expect(f.files).toHaveLength(cases.length);
  expect(f.confirmations()).toBe(0);
});
