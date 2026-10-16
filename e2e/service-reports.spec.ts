import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(
  !["localhost", "127.0.0.1"].includes(database.hostname) ||
  !/^\/mesapay_.*validation$/.test(database.pathname) ||
  process.env.PLAYWRIGHT_BASE_URL !== "http://localhost:3392",
  "Service report regressions require an isolated local application and validation database",
);
const db = new PrismaClient();
const tenantIds: string[] = [];
const representation = "/operator/reports/gastos-representacion";
const uncollected = "/operator/reports/no-cobrados";

async function fixture(bulk = false) {
  const token = randomUUID();
  const password = `Reports-${token}`;
  const passwordHash = await bcrypt.hash(password, 4);
  const restaurant = await db.restaurant.create({ data: {
    slug: `service-reports-${token}`, name: "Reportes de servicio de prueba", country: "CO",
    compEnabled: false, businessDayCutoffHour: 5, enabledPaymentMethods: ["cash"],
    kitchenAutoFire: false, barAutoFire: false, kitchenPrintEnabled: false, barPrintEnabled: false,
  } });
  tenantIds.push(restaurant.id);
  const user = await db.user.create({ data: {
    restaurantId: restaurant.id, role: "operator", email: `reports-${token}@example.test`, passwordHash,
  } });
  const waiter = await db.user.create({ data: {
    restaurantId: restaurant.id, role: "mesero", email: `waiter-${token}@example.test`, passwordHash,
  } });
  const table = await db.table.create({ data: {
    restaurantId: restaurant.id, number: 12, label: "Terraza de representación", qrToken: randomUUID(),
  } });
  const eventAt = new Date(Date.now() - 60_000);
  const before = (hours: number) => new Date(eventAt.getTime() - hours * 3_600_000);
  const order = await db.order.create({ data: {
    restaurantId: restaurant.id, tableId: table.id, shortCode: randomUUID(), status: "paid",
    compedAt: eventAt, paidAt: eventAt, placedAt: before(4), compAmountCents: 300_000,
    compLabel: "Gastos de representación", compNote: "Visita institucional",
  } });
  const secondOrder = await db.order.create({ data: {
    restaurantId: restaurant.id, tableId: table.id, shortCode: randomUUID(), status: "served", placedAt: before(4),
  } });
  const round = await db.round.create({ data: { orderId: order.id, seq: 1, status: "served", placedAt: before(4) } });
  const cancelledRound = await db.round.create({ data: {
    orderId: order.id, seq: 2, status: "cancelled", placedAt: before(4), cancelledAt: before(3),
    cancellationReason: "Ronda duplicada", cancelledByEmail: user.email,
  } });
  await db.orderItem.createMany({ data: [
    ...["Representación café", "Representación postre"].map((nameSnapshot, index) => ({
      orderId: order.id, roundId: round.id, nameSnapshot, qty: index === 0 ? 2 : 1, priceCentsSnapshot: 100_000,
      cancelledAt: eventAt, cancellationKind: "comp", cancellationReason: "Gastos de representación: Visita institucional", cancelledByEmail: user.email,
    })),
    { orderId: order.id, roundId: round.id, nameSnapshot: "Cortesía individual previa", qty: 2, priceCentsSnapshot: 20_000,
      cancelledAt: before(2), cancellationKind: "comp", cancellationReason: "Atención individual", cancelledByEmail: user.email },
    { orderId: order.id, roundId: round.id, nameSnapshot: "Cancelación individual", qty: 1, priceCentsSnapshot: 50_000,
      cancelledAt: before(1), cancellationKind: "cancel", cancellationReason: "Producto agotado", cancelledByEmail: user.email },
    // Legacy round-only cancellation: there is no cancellation marker on the item itself.
    { orderId: order.id, roundId: cancelledRound.id, nameSnapshot: "Cancelación de ronda", qty: 3, priceCentsSnapshot: 20_000 },
    { orderId: secondOrder.id, nameSnapshot: "Cancelación histórica sin detalle", qty: 1, priceCentsSnapshot: 70_000, cancelledAt: before(4) },
    { orderId: secondOrder.id, nameSnapshot: "Producto que sí se cobra", qty: 1, priceCentsSnapshot: 900_000 },
    ...(bulk ? Array.from({ length: 506 }, (_, index) => ({
      orderId: secondOrder.id, nameSnapshot: `Exportable ${String(index + 1).padStart(4, "0")}`, qty: 1, priceCentsSnapshot: 100,
      cancelledAt: before(1), cancellationKind: "comp", cancellationReason: "Validación de exportación", cancelledByEmail: user.email,
    })) : []),
  ] });
  await db.auditEvent.create({ data: {
    restaurantId: restaurant.id, actorUserId: user.id, actorEmail: user.email, actorRole: "operator",
    kind: "order.comp", occurredAt: eventAt, targetType: "order", targetId: order.id,
    summary: "No cobró la cuenta — Visita institucional", diff: { after: { compAmountCents: 300_000, note: "Visita institucional" } },
  } });
  return { restaurant, user, waiter, password, order, secondOrder, eventAt };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function cleanup(ids: string[]) {
  await db.auditEvent.deleteMany({ where: { restaurantId: { in: ids } } });
  await db.restaurant.deleteMany({ where: { id: { in: ids } } });
  await db.platformEvent.deleteMany({ where: { restaurantId: { in: ids } } });
}

async function login(page: Page, f: Fixture, waiter = false) {
  await page.route(/^https?:\/\//, route =>
    ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: "es", domain: "localhost", path: "/" }]);
  await page.goto("/signin");
  await page.getByLabel("Correo", { exact: true }).fill(waiter ? f.waiter.email : f.user.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(f.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(url => !url.pathname.startsWith("/signin"));
}

const rows = (page: Page) => page.getByTestId("service-report-row").filter({ visible: true });
const input = (page: Page, name: string) => page.locator(`input[name="${name}"]`).filter({ visible: true });
async function navigateFromBusiness(page: Page, path: string, name: string) {
  const menuButton = page.getByRole("button", { name: "Abrir menú", exact: true });
  const mobile = await menuButton.isVisible();
  if (mobile) await menuButton.click();
  const rail = mobile ? page.getByRole("dialog", { name: "Abrir menú", exact: true }) : page.getByRole("complementary");
  const business = rail.getByRole("button", { name: "Negocio", exact: true });
  if (await business.getAttribute("aria-expanded") !== "true") await business.click();
  const link = rail.getByRole("link", { name, exact: true });
  await expect(link).toHaveAttribute("href", path);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  await page.getByRole("link", { name: "Todo el historial", exact: true }).click();
  await expect(page).toHaveURL(/range=all/);
}
async function stats(page: Page, amountCents: number, quantity: number, orders: number) {
  for (const [id, expected] of [["amount", amountCents / 100], ["quantity", quantity], ["orders", orders]] as const) {
    await expect.poll(async () => Number((await page.getByTestId(`service-report-${id}`).filter({ visible: true }).innerText()).replace(/\D/g, ""))).toBe(expected);
  }
}
async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Report page must fit the viewport").toBe(true);
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
  // The operator shell scrolls its main panel, so a full-page screenshot
  // alone cannot show detail rows below the filters on a small screen.
  if (await rows(page).count()) {
    await rows(page).first().scrollIntoViewIfNeeded();
    const detailPath = testInfo.outputPath(`${name}-detail.png`);
    await page.screenshot({ path: detailPath });
    await testInfo.attach(`${name}-detail`, { path: detailPath, contentType: "image/png" });
  }
}
async function report(page: Page, path: string, query = "range=all") {
  const response = await page.request.get(`/api${path}?${query}`);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  return response.json();
}

test("account representation and individual adjustments remain distinct, searchable and readable", async ({ page }, testInfo) => {
  const f = await fixture();
  try {
    await login(page, f);
    await navigateFromBusiness(page, representation, "Gastos de representación");
    await expect(page.getByRole("heading", { level: 1, name: "Gastos de representación", exact: true })).toBeVisible();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page)).toContainText(["Visita institucional"]);
    await expect(rows(page)).toContainText([f.user.email]);
    await stats(page, 300_000, 3, 1);
    await screenshot(page, testInfo, "representation-accounts");

    await page.getByRole("link", { name: "Productos", exact: true }).click();
    await expect(page).toHaveURL(/vista=productos/);
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).filter({ hasText: "Cortesía individual previa" })).toHaveCount(0);
    await stats(page, 300_000, 3, 1);
    await input(page, "q").fill("Representación café");
    await page.getByRole("button", { name: "Aplicar filtros", exact: true }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page)).toContainText(["Representación café"]);
    await stats(page, 200_000, 2, 1);
    await input(page, "q").fill("");
    await page.getByRole("button", { name: "Aplicar filtros", exact: true }).click();
    await expect(rows(page)).toHaveCount(2);
    await stats(page, 300_000, 3, 1);
    await screenshot(page, testInfo, "representation-products");
    for (const view of ["cuentas", "productos"]) {
      const csvResponse = await page.request.get(`/api${representation}?range=all&vista=${view}&format=csv`);
      expect(csvResponse.status()).toBe(200);
      expect(csvResponse.headers()["content-type"]).toContain("text/csv");
      const csv = await csvResponse.text();
      expect(csv).toContain("Visita institucional");
      expect(csv).toContain(f.user.email);
      expect(csv).not.toContain("Cortesía individual previa");
      if (view === "productos") {
        expect(csv).toContain("Representación café");
        expect(csv).toContain("Representación postre");
      }
    }

    await navigateFromBusiness(page, uncollected, "Productos no cobrados");
    await expect(page.getByRole("heading", { name: "Productos no cobrados", exact: true })).toBeVisible();
    await expect(rows(page)).toHaveCount(6);
    await stats(page, 520_000, 10, 2);
    await expect(rows(page).filter({ hasText: "Cancelación de ronda" })).toContainText("Ronda duplicada");
    await expect(rows(page).filter({ hasText: "Cancelación de ronda" })).toContainText(f.user.email);
    const legacy = rows(page).filter({ hasText: "Cancelación histórica sin detalle" });
    await expect(legacy).toContainText("Sin motivo registrado");
    await expect(legacy).toContainText("Sin responsable registrado");
    await expect(rows(page).filter({ hasText: "Producto que sí se cobra" })).toHaveCount(0);
    await screenshot(page, testInfo, "uncollected-products");

    await input(page, "email").fill(f.user.email);
    await page.getByRole("button", { name: "Aplicar filtros", exact: true }).click();
    await expect(rows(page)).toHaveCount(5);
    await stats(page, 450_000, 9, 1);
    for (const [kind, rowCount, amountCents] of [["comp", 1, 40_000], ["representation", 2, 300_000], ["cancel", 3, 180_000]] as const) {
      const result = await report(page, uncollected, `range=all&kind=${kind}`);
      expect(result.totals).toMatchObject({ rowCount, amountCents });
    }
    expect(await db.payment.count({ where: { order: { restaurantId: f.restaurant.id } } })).toBe(0);
    expect(await db.simpleInvoice.count({ where: { restaurantId: f.restaurant.id } })).toBe(0);
    expect(await db.stockMovement.count({ where: { restaurantId: f.restaurant.id } })).toBe(0);
    expect(await db.printJob.count({ where: { restaurantId: f.restaurant.id } })).toBe(0);
  } finally {
    await page.goto("about:blank");
    await cleanup([f.restaurant.id]);
  }
});

test("pagination preserves full-filter totals and CSV downloads every match beyond 500", async ({ page }, testInfo) => {
  const f = await fixture(true);
  try {
    await login(page, f);
    await page.goto(`${uncollected}?range=all&q=Exportable`);
    await expect(rows(page)).toHaveCount(50);
    await stats(page, 50_600, 506, 1);
    const firstPage = await rows(page).allTextContents();
    await page.locator('a[href*="page=2"]').filter({ visible: true }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(rows(page)).toHaveCount(50);
    expect((await rows(page).allTextContents()).filter(text => firstPage.includes(text))).toEqual([]);
    await stats(page, 50_600, 506, 1);
    await screenshot(page, testInfo, "uncollected-page-two");

    const result = await report(page, uncollected, "range=all&q=Exportable&page=11");
    expect(result).toMatchObject({ page: 11, pageCount: 11, pageSize: 50, totals: { rowCount: 506, quantity: 506, amountCents: 50_600 } });
    expect(result.rows).toHaveLength(6);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "Descargar CSV", exact: true }).click();
    const download = await downloadPromise;
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
    const csvPath = testInfo.outputPath("all-matching-products.csv");
    await download.saveAs(csvPath);
    const csv = await readFile(csvPath, "utf8");
    expect((csv.match(/Exportable \d{4}/g) ?? [])).toHaveLength(506);
    expect(new Set(csv.match(/Exportable \d{4}/g))).toHaveProperty("size", 506);
    expect(csv).not.toContain("Cancelación histórica sin detalle");
    expect(csv).not.toContain("Producto que sí se cobra");
    await testInfo.attach("all-matching-products", { path: csvPath, contentType: "text/csv" });
  } finally {
    await page.goto("about:blank");
    await cleanup([f.restaurant.id]);
  }
});

test("reports reject unauthenticated and waiter sessions and never expose another tenant", async ({ page, browser }) => {
  const own = await fixture();
  const foreign = await fixture();
  const waiterContext = await browser.newContext({ baseURL: "http://localhost:3392" });
  try {
    for (const path of [representation, uncollected]) {
      expect([401, 403]).toContain((await page.request.get(`/api${path}?range=all`)).status());
      expect([401, 403]).toContain((await page.request.get(`/api${path}?range=all&format=csv`)).status());
    }
    await login(page, own);
    for (const path of [representation, uncollected]) {
      const byOrder = await report(page, path, `range=all&orderId=${foreign.order.id}`);
      expect(byOrder.rows).toEqual([]);
      expect(byOrder.totals.amountCents).toBe(0);
      const byActor = await report(page, path, `range=all&email=${encodeURIComponent(foreign.user.email)}`);
      expect(byActor.rows).toEqual([]);
      const spoofed = await report(page, path, `range=all&restaurantId=${foreign.restaurant.id}`);
      expect(spoofed.rows.length).toBeGreaterThan(0);
      expect(spoofed.rows.every((row: { orderId: string }) => [own.order.id, own.secondOrder.id].includes(row.orderId))).toBe(true);
      expect(JSON.stringify(spoofed)).not.toContain(foreign.user.email);
      await page.goto(`${path}?range=all&orderId=${foreign.order.id}`);
      await expect(rows(page)).toHaveCount(0);
      await expect(page.getByText(foreign.user.email, { exact: true })).toHaveCount(0);
    }
    const waiterPage = await waiterContext.newPage();
    await login(waiterPage, own, true);
    for (const path of [representation, uncollected]) {
      expect([401, 403]).toContain((await waiterPage.request.get(`/api${path}?range=all`)).status());
      expect([401, 403]).toContain((await waiterPage.request.get(`/api${path}?range=all&format=csv`)).status());
      await waiterPage.goto(`${path}?range=all`);
      await expect(rows(waiterPage)).toHaveCount(0);
    }
    // Historical reporting stays available after the action itself is disabled.
    expect((await db.restaurant.findUniqueOrThrow({ where: { id: own.restaurant.id } })).compEnabled).toBe(false);
    expect((await report(page, representation)).totals.amountCents).toBe(300_000);
  } finally {
    await waiterContext.close();
    await page.goto("about:blank");
    await cleanup([own.restaurant.id, foreign.restaurant.id]);
  }
});

test("custom dates use the business-day cutoff with an exclusive end boundary", async ({ page }, testInfo) => {
  const f = await fixture();
  try {
    // Bogotá 05:00 cutoff is 10:00 UTC, regardless of the browser/server timezone.
    await db.orderItem.createMany({ data: [
      { nameSnapshot: "Límite antes del inicio", cancelledAt: new Date("2026-01-15T09:59:59.999Z") },
      { nameSnapshot: "Límite inicio incluido", cancelledAt: new Date("2026-01-15T10:00:00.000Z") },
      { nameSnapshot: "Límite fin incluido", cancelledAt: new Date("2026-01-16T09:59:59.999Z") },
      { nameSnapshot: "Límite después del fin", cancelledAt: new Date("2026-01-16T10:00:00.000Z") },
    ].map(item => ({ ...item, orderId: f.secondOrder.id, qty: 1, priceCentsSnapshot: 10_000, cancellationKind: "cancel" })) });
    await login(page, f);
    const query = "desde=2026-01-15&hasta=2026-01-15&q=Límite";
    const result = await report(page, uncollected, query);
    expect(result.totals).toMatchObject({ rowCount: 2, quantity: 2, amountCents: 20_000 });
    expect(result.rows.map((row: { name: string }) => row.name).sort()).toEqual(["Límite fin incluido", "Límite inicio incluido"]);
    await page.goto(`${uncollected}?${query}`);
    await expect(rows(page)).toHaveCount(2);
    await stats(page, 20_000, 2, 1);
    await screenshot(page, testInfo, "custom-business-day");
    for (const invalid of ["desde=2026-01-16&hasta=2026-01-15", "desde=2026-02-30&hasta=2026-03-01", "range=invalid", "page=0"]) {
      expect((await page.request.get(`/api${uncollected}?${invalid}`)).status()).toBe(400);
    }
  } finally {
    await page.goto("about:blank");
    await cleanup([f.restaurant.id]);
  }
});

test.afterAll(async () => {
  await cleanup(tenantIds);
  await db.$disconnect();
});
