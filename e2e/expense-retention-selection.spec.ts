import { test, expect, type Locator, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

const application = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3300");
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(
  !["localhost", "127.0.0.1"].includes(application.hostname)
    || !["localhost", "127.0.0.1"].includes(database.hostname)
    || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname),
  "Expense retention regressions require an isolated local app and database",
);
test.setTimeout(90_000);
test.use({ actionTimeout: 15_000, navigationTimeout: 60_000 });
const db = new PrismaClient();
const tenants: string[] = [];

async function fixture(page: Page) {
  const token = randomUUID();
  const password = `Expense-local-${token}`;
  const restaurant = await db.restaurant.create({ data: {
    name: "Gastos de prueba local", slug: `expense-retention-${token}`, country: "CO",
    enabledModules: ["accounting"], purchaseIvaDeductible: true,
    kitchenPrintEnabled: false, barPrintEnabled: false, invoiceAutoPrint: false,
  } });
  tenants.push(restaurant.id);
  const user = await db.user.create({ data: {
    restaurantId: restaurant.id, role: "operator", name: "Administrador de prueba",
    email: `expense-${token}@example.test`, passwordHash: await bcrypt.hash(password, 4),
  } });
  const supplier = await db.supplier.create({ data: {
    restaurantId: restaurant.id, name: "Proveedor sintético local", taxId: "901944469-1",
    taxIdType: "NIT", personType: "juridica",
  } });
  const concepts = [];
  for (const concept of [
    { kind: "retefuente", name: "Servicios de prueba", rateBps: 400, base: "subtotal", accountCode: "236505" },
    { kind: "reteiva", name: "IVA de prueba", rateBps: 1500, base: "tax", accountCode: "236705" },
    { kind: "reteica", name: "ICA de prueba", rateBps: 70, base: "subtotal", accountCode: "236805" },
  ]) concepts.push(await db.retentionConcept.create({ data: {
    ...concept, restaurantId: restaurant.id, active: false, thresholdUvt: 0,
  } }));
  await page.route(/^https?:\/\//, route =>
    ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname)
      ? route.fallback() : route.abort());
  await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: "es", domain: application.hostname, path: "/" }]);
  const headers = { "x-real-ip": `127.12.${parseInt(token.slice(0, 2), 16)}.${parseInt(token.slice(2, 4), 16)}` };
  await page.setExtraHTTPHeaders(headers);
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const login = await page.request.post("/api/auth/callback/credentials", {
    headers: { ...headers, "X-Auth-Return-Redirect": "1" },
    form: { csrfToken: csrf.csrfToken, email: user.email, password, callbackUrl: `${application.origin}/operator/contabilidad` },
  });
  expect(login.ok()).toBe(true);
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(user.id);
  const suppliersLoaded = page.waitForResponse(r => r.url().endsWith("/api/operator/suppliers") && r.request().method() === "GET");
  await page.goto("/operator/contabilidad?tab=expenses&month=2026-11");
  expect((await suppliersLoaded).ok()).toBe(true);
  await page.getByRole("button", { name: "Nuevo gasto", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Nuevo gasto", exact: true });
  await expect(dialog).toBeVisible();
  return { restaurant, supplier, concepts, dialog };
}

async function basicFields(dialog: Locator) {
  await dialog.getByRole("combobox", { name: /^Categoría/ }).fill("Mantenimiento sintético");
  await dialog.getByRole("textbox", { name: /^Monto/ }).fill("1000000");
  await dialog.getByLabel(/^Fecha/).fill("2026-11-05");
  await dialog.getByRole("textbox", { name: "Descripción", exact: true }).fill("Evidencia local de retenciones");
}

async function openTaxes(dialog: Locator) {
  const toggle = dialog.getByRole("button", { name: /^Impuestos y retenciones/ });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
}

test.afterEach(async () => {
  if (tenants.length) {
    await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
    await db.platformEvent.deleteMany({ where: { restaurantId: { in: tenants } } });
  }
  tenants.splice(0);
});
test.afterAll(() => db.$disconnect());

test("chooses inactive concepts explicitly for one expense, edits values and preserves them on reopen", async ({ page }, info) => {
  const { restaurant, supplier, concepts, dialog } = await fixture(page);
  await basicFields(dialog);
  await dialog.getByRole("combobox", { name: /^Proveedor/ }).fill(supplier.name);
  await dialog.getByRole("option", { name: new RegExp(`^${supplier.name}`) }).click();
  await openTaxes(dialog);
  const add = dialog.getByRole("combobox", { name: "+ Agregar retención", exact: true });
  await expect(add).toBeVisible();
  // No suggestion or global configuration change is implied by opening the expense.
  for (const concept of concepts) await expect(dialog.getByRole("textbox", { name: concept.name, exact: true })).toHaveCount(0);
  await dialog.getByRole("radio", { name: "19 %", exact: true }).click();
  for (const concept of concepts) await add.selectOption(concept.id);
  await dialog.getByRole("textbox", { name: "Servicios de prueba", exact: true }).fill("35000");
  await expect(dialog.getByRole("textbox", { name: "IVA de prueba", exact: true })).toHaveValue("28.500");
  await expect(dialog.getByRole("textbox", { name: "ICA de prueba", exact: true })).toHaveValue("7.000");
  const recurring = dialog.getByRole("checkbox", { name: "Gasto recurrente (se repite cada mes)", exact: true });
  await recurring.check();
  const warning = dialog.getByText(/^Estas retenciones están desactivadas y no se aplicarán a los gastos futuros/);
  await expect(warning).toBeVisible();
  for (const concept of concepts) await expect(warning).toContainText(concept.name);
  await recurring.uncheck();
  await expect(warning).toHaveCount(0);
  await dialog.getByRole("checkbox", { name: "Ya está pagado", exact: true }).uncheck();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByText("Retenciones que practicas", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("manual-retentions-selected.png"), fullPage: true });
  const saved = page.waitForResponse(r => r.url().endsWith("/api/operator/expenses") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(201);
  const { expense } = await response.json();
  const stored = await db.expense.findUniqueOrThrow({ where: { id: expense.id }, include: { retentions: true } });
  expect(stored).toMatchObject({
    supplierId: supplier.id, baseCents: 100_000_000, ivaCents: 19_000_000, amountCents: 100_000_000,
    retefuenteCents: 3_500_000, reteIvaCents: 2_850_000, reteIcaCents: 700_000,
    payableCents: 111_950_000, paidCents: 0,
  });
  expect(stored.retentions).toHaveLength(3);
  expect(stored.retentions.map(r => [r.conceptId, r.amountCents])).toEqual(expect.arrayContaining([
    [concepts[0]!.id, 3_500_000], [concepts[1]!.id, 2_850_000], [concepts[2]!.id, 700_000],
  ]));
  expect(await db.retentionConcept.count({ where: { restaurantId: restaurant.id, active: true } })).toBe(0);
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: /Mantenimiento sintético/ }).click();
  const reopened = page.getByRole("dialog", { name: "Editar gasto", exact: true });
  await expect(reopened.getByRole("textbox", { name: "Servicios de prueba", exact: true })).toHaveValue("35.000");
  await expect(reopened.getByRole("textbox", { name: "IVA de prueba", exact: true })).toHaveValue("28.500");
  await expect(reopened.getByRole("textbox", { name: "ICA de prueba", exact: true })).toHaveValue("7.000");
});

test("failed tax context can be retried without discarding the expense draft", async ({ page }, info) => {
  let requests = 0;
  let recovering = false;
  await page.route(`${application.origin}/api/operator/expenses/tax-context`, async route => {
    requests += 1;
    if (!recovering) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "local_test_unavailable" }) });
    else await route.continue();
  });
  const { dialog, concepts } = await fixture(page);
  await basicFields(dialog);
  await openTaxes(dialog);
  await expect(dialog.getByRole("alert")).toContainText(/No se pudieron cargar/);
  const retry = dialog.getByRole("button", { name: /Reintentar/ });
  await expect(retry).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Guardar", exact: true })).toBeDisabled();
  await retry.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("retentions-load-error.png"), fullPage: true });
  const attemptsBeforeRetry = requests;
  recovering = true;
  await retry.click();
  const add = dialog.getByRole("combobox", { name: "+ Agregar retención", exact: true });
  await expect(add).toBeVisible();
  expect(requests).toBe(attemptsBeforeRetry + 1);
  await expect(dialog.getByRole("combobox", { name: /^Categoría/ })).toHaveValue("Mantenimiento sintético");
  await expect(dialog.getByRole("textbox", { name: /^Subtotal/ })).toHaveValue("1.000.000");
  await expect(dialog.getByRole("textbox", { name: "Descripción", exact: true })).toHaveValue("Evidencia local de retenciones");
  await add.selectOption(concepts[0]!.id);
  await expect(dialog.getByRole("textbox", { name: concepts[0]!.name, exact: true })).toHaveValue("40.000");
  await page.screenshot({ path: info.outputPath("retentions-load-recovered.png"), fullPage: true });
});
