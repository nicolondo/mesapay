import { test, expect, type Page, type Locator } from "@playwright/test";
import { PrismaClient, type Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(
  !["localhost", "127.0.0.1"].includes(database.hostname)
    || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)
    || !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""),
  "Shift-tax regressions require an isolated local application and database",
);
const db = new PrismaClient();
const tenants: string[] = [];
const taxLabel = "Impuesto al consumo (INC)";
test.setTimeout(90_000);

async function fixture(page: Page, locale = "es") {
  const token = randomUUID();
  const password = `Shift-tax-${token}`;
  const restaurant = await db.restaurant.create({ data: {
    name: "Restaurante de prueba INC", slug: `shift-tax-${token}`,
    salesTaxKind: "iva", salesTaxPct: 19, businessDayCutoffHour: 5,
  } });
  tenants.push(restaurant.id);
  const user = await db.user.create({ data: {
    restaurantId: restaurant.id, role: "operator", name: "Operador de prueba",
    email: `shift-tax-${token}@example.test`, passwordHash: await bcrypt.hash(password, 4),
  } });
  const table = await db.table.create({ data: { restaurantId: restaurant.id, number: 1, qrToken: token } });
  const openedAt = new Date(Date.now() - 3_600_000);
  const shift = await db.shift.create({ data: {
    restaurantId: restaurant.id, openedById: user.id, openedAt, openingCashCents: 40_000_000,
  } });
  await page.route(/^https?:\/\//, route =>
    ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname)
      ? route.continue() : route.abort());
  await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: locale, domain: "localhost", path: "/" }]);
  const headers = { "x-real-ip": `127.7.${parseInt(token.slice(0, 2), 16)}.${parseInt(token.slice(2, 4), 16)}` };
  await page.setExtraHTTPHeaders(headers);
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const login = await page.request.post("/api/auth/callback/credentials", {
    headers: { ...headers, "X-Auth-Return-Redirect": "1" },
    form: { csrfToken: csrf.csrfToken, email: user.email, password, callbackUrl: `${process.env.PLAYWRIGHT_BASE_URL}/operator/reports` },
  });
  expect(login.ok()).toBe(true);
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(user.id);
  let invoiceNumber = 0;
  async function sale(totalCents: number, tipCents: number, snapshot: Prisma.InputJsonObject | null) {
    const taxCents = Number(snapshot?.taxCents ?? 0);
    const order = await db.order.create({ data: {
      restaurantId: restaurant.id, tableId: table.id, shortCode: randomUUID(), status: "paid",
      createdAt: new Date(openedAt.getTime() + 60_000), paidAt: new Date(),
      subtotalCents: totalCents - tipCents - taxCents, taxCents, tipCents, totalCents,
    } });
    if (snapshot !== null) await db.simpleInvoice.create({ data: {
      restaurantId: restaurant.id, orderId: order.id, invoiceNumber: ++invoiceNumber, totalCents,
      snapshot: { totalCents, tipCents, ...snapshot },
    } });
    return order;
  }
  async function payment(orderId: string, amountCents: number, tipCents: number, options: Partial<Prisma.PaymentUncheckedCreateInput> = {}) {
    return db.payment.create({ data: {
      orderId, amountCents, tipCents, method: "cash", status: "approved",
      createdAt: new Date(openedAt.getTime() + 120_000), settledAt: new Date(), collectedByUserId: user.id,
      ...options,
    } });
  }
  return { restaurant, user, shift, openedAt, sale, payment };
}

async function expectTax(group: Locator, amount: string) {
  await expect(group).toBeVisible();
  await expect(group).toContainText(amount);
  await expect(group).toContainText("Incluido en el total cobrado del turno.");
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test.afterEach(async () => {
  if (!tenants.length) return;
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.platformEvent.deleteMany({ where: { restaurantId: { in: tenants } } });
  tenants.splice(0);
});
test.afterAll(async () => db.$disconnect());

test("live close, historical reports and print show INC without adding IVA or changing cash", async ({ page }, info) => {
  const f = await fixture(page);
  const embedded = await f.sale(11_800_000, 1_000_000, {
    salesTaxKind: "inc", salesTaxPct: 8, embeddedTaxCents: 800_000,
    embeddedBaseCents: 10_000_000, taxCents: 0, taxByKind: { inc: 0, iva: 0 },
  });
  const mixed = await f.sale(6_850_000, 500_000, {
    salesTaxKind: "iva", salesTaxPct: 19, embeddedTaxCents: 0,
    taxCents: 1_350_000, taxByKind: { inc: 400_000, iva: 950_000 },
  });
  await f.payment(embedded.id, 11_800_000, 1_000_000);
  await f.payment(mixed.id, 6_850_000, 500_000, { method: "demo_card" });
  await page.goto("/operator/reports");
  await expectTax(page.getByRole("group", { name: taxLabel, exact: true }).filter({ visible: true }), "$12.000");
  const metrics = await (await page.request.get("/api/operator/shifts/current")).json();
  expect(metrics.metrics).toMatchObject({ grossCents: 18_650_000, tipCents: 1_500_000, cashCents: 11_800_000, consumptionTaxCents: 1_200_000, taxPendingPayments: 0 });
  expect(metrics.expectedCashCents).toBe(51_800_000);
  await page.getByRole("button", { name: "Cerrar turno", exact: true }).click();
  const modal = page.locator("div.fixed.inset-0").filter({ has: page.getByRole("button", { name: "Confirmar cierre", exact: true }) });
  await expectTax(modal.getByRole("group", { name: taxLabel, exact: true }), "$12.000");
  await expect(modal.getByRole("group", { name: taxLabel, exact: true })).toBeInViewport();
  await expect(modal.getByRole("button", { name: "Confirmar cierre", exact: true })).toBeInViewport();
  await expect(modal.getByLabel("Efectivo contado físicamente", { exact: true })).toHaveValue("518.000");
  await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath("close-modal-inc.png") });
  const closing = page.waitForResponse(response => response.url().endsWith("/api/operator/shifts/close") && response.request().method() === "POST");
  await modal.getByRole("button", { name: "Confirmar cierre", exact: true }).click();
  const closed = await closing;
  expect(closed.ok()).toBe(true);
  expect(await closed.json()).toMatchObject({ expectedCashCents: 51_800_000, cashDiffCents: 0, breakdown: { grossCents: 18_650_000, tipCents: 1_500_000, consumptionTaxCents: 1_200_000, taxPendingPayments: 0 } });
  await expect(page.getByText("Sin turno abierto", { exact: true })).toBeVisible();
  const recent = page.getByRole("table").filter({ has: page.getByRole("columnheader", { name: "INC", exact: true }) }).filter({ visible: true });
  await expect(recent.getByRole("row").filter({ has: page.locator(`a[href="/operator/shifts/${f.shift.id}"]`) })).toContainText("$12.000");
  await recent.locator(`a[href="/operator/shifts/${f.shift.id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/operator/shifts/${f.shift.id}$`));
  await page.locator('a[href="/operator/shifts"]').filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/operator\/shifts$/);
  const row = page.locator(`a[href="/operator/shifts/${f.shift.id}"]`).filter({ visible: true });
  await expect(row).toContainText("INC: $12.000");
  await noHorizontalOverflow(page);
  await row.click();
  const report = page.locator(".shift-report").filter({ visible: true });
  await expectTax(report.getByRole("group", { name: taxLabel, exact: true }), "$12.000");
  await expect(report).toContainText("$186.500");
  await expect(report).toContainText("$15.000");
  await expect(report).toContainText("$518.000");
  await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath("shift-report-inc.png"), fullPage: true });
  await report.getByRole("group", { name: taxLabel, exact: true }).screenshot({ path: info.outputPath("inc-breakdown.png") });
  await page.emulateMedia({ media: "print" });
  await expectTax(report.getByRole("group", { name: taxLabel, exact: true }), "$12.000");
  await expect(page.getByRole("button", { name: "Imprimir", exact: true })).toBeHidden();
  await expect(page.locator("header, nav, [role='navigation']").filter({ visible: true })).toHaveCount(0);
  expect((await report.boundingBox())!.width).toBeGreaterThan(page.viewportSize()!.width * 0.7);
  await page.screenshot({ path: info.outputPath("shift-report-inc-print.png"), fullPage: true });
});

test("split payments allocate the frozen tax once across shifts and waiter reports", async ({ page }) => {
  const f = await fixture(page);
  const previousStart = new Date(f.openedAt.getTime() - 7_200_000);
  const previousClose = new Date(f.openedAt.getTime() - 60_000);
  const previous = await db.shift.create({ data: {
    restaurantId: f.restaurant.id, openedById: f.user.id, closedById: f.user.id,
    status: "closed", openedAt: previousStart, closedAt: previousClose,
    openingCashCents: 0, expectedCashCents: 5_900_000, declaredCashCents: 5_900_000, cashDiffCents: 0,
  } });
  const waiter = await db.user.create({ data: {
    restaurantId: f.restaurant.id, name: "Mesero segunda mitad", role: "mesero",
    email: `shift-tax-waiter-${randomUUID()}@example.test`, passwordHash: f.user.passwordHash,
  } });
  const personal = await db.shift.create({ data: {
    restaurantId: f.restaurant.id, userId: waiter.id, openedById: waiter.id, closedById: waiter.id,
    status: "closed", openedAt: f.openedAt, closedAt: new Date(),
    openingCashCents: 0, expectedCashCents: 5_900_000, declaredCashCents: 5_900_000, cashDiffCents: 0,
  } });
  const order = await f.sale(11_800_000, 1_000_000, {
    salesTaxKind: "inc", salesTaxPct: 8, embeddedTaxCents: 800_000,
    embeddedBaseCents: 10_000_000, taxCents: 0, taxByKind: { inc: 0, iva: 0 },
  });
  await db.order.update({ where: { id: order.id }, data: { createdAt: previousStart } });
  await f.payment(order.id, 5_900_000, 500_000, {
    shiftId: previous.id, createdAt: new Date(previousStart.getTime() + 60_000),
    settledAt: new Date(previousClose.getTime() - 60_000),
  });
  await f.payment(order.id, 5_900_000, 500_000, {
    collectedByUserId: waiter.id, settledAt: new Date(personal.closedAt!.getTime() - 1),
  });
  await page.goto("/operator/reports");
  await expectTax(page.getByRole("group", { name: taxLabel, exact: true }).filter({ visible: true }), "$4.000");
  const metrics = await (await page.request.get("/api/operator/shifts/current")).json();
  expect(metrics.metrics).toMatchObject({ grossCents: 5_900_000, tipCents: 500_000, consumptionTaxCents: 400_000, taxPendingPayments: 0 });
  for (const shiftId of [previous.id, personal.id]) {
    await page.goto(`/operator/shifts/${shiftId}`);
    const report = page.locator(".shift-report").filter({ visible: true });
    await expectTax(report.getByRole("group", { name: taxLabel, exact: true }), "$4.000");
    await expect(report).toContainText("$59.000");
    await expect(report).toContainText("$5.000");
  }
  await expect(page.locator(".shift-report").filter({ visible: true })).toContainText("Mesero segunda mitad");
});

test("legacy zero-tax receipts stay confirmed while unissued receipts disclose missing tax evidence", async ({ page }, info) => {
  const f = await fixture(page);
  const legacy = await f.sale(1_100_000, 100_000, { taxCents: 0 });
  const unknown = await f.sale(1_180_000, 100_000, null);
  await f.payment(legacy.id, 1_100_000, 100_000);
  await f.payment(unknown.id, 1_180_000, 100_000);
  await page.goto("/operator/reports");
  const group = page.getByRole("group", { name: taxLabel, exact: true }).filter({ visible: true });
  await expectTax(group, "$0");
  await expect(group).toContainText("1 cobro aún no tiene un desglose de impuestos confirmado.");
  const metrics = await (await page.request.get("/api/operator/shifts/current")).json();
  expect(metrics.metrics).toMatchObject({ consumptionTaxCents: 0, taxPendingPayments: 1, grossCents: 2_280_000, tipCents: 200_000 });
  await page.getByRole("button", { name: "Cerrar turno", exact: true }).click();
  const closing = page.waitForResponse(response => response.url().endsWith("/api/operator/shifts/close") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Confirmar cierre", exact: true }).click();
  const close = await closing;
  expect(close.ok()).toBe(true);
  expect(await close.json()).toMatchObject({ cashDiffCents: 0, breakdown: { consumptionTaxCents: 0, taxPendingPayments: 1 } });
  await page.locator(`a[href="/operator/shifts/${f.shift.id}"]`).filter({ visible: true }).click();
  await expect(page).toHaveURL(new RegExp(`/operator/shifts/${f.shift.id}$`));
  const report = page.locator(".shift-report").filter({ visible: true });
  await expectTax(report.getByRole("group", { name: taxLabel, exact: true }), "$0");
  await expect(report).toContainText("1 cobro aún no tiene un desglose de impuestos confirmado.");
  await expect(report).toContainText("$22.800");
  await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath("shift-tax-pending.png"), fullPage: true });
  await report.getByRole("group", { name: taxLabel, exact: true }).screenshot({ path: info.outputPath("pending-breakdown.png") });
});

for (const [locale, label] of [
  ["en", "Consumption tax (INC)"],
  ["pt", "Imposto sobre consumo (INC)"],
] as const) {
  test(`the tax breakdown is labeled in ${locale}`, async ({ page }) => {
    await fixture(page, locale);
    await page.goto("/operator/reports");
    const group = page.getByRole("group", { name: label, exact: true }).filter({ visible: true });
    await expect(group).toBeVisible();
    await expect(group).toContainText("0");
    await expect(group).not.toContainText("Incluido en el total cobrado del turno.");
  });
}
