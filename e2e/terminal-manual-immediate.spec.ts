import { test, expect, type Page } from "@playwright/test";
import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

const application = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3300");
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(
  !["localhost", "127.0.0.1"].includes(application.hostname)
    || !["localhost", "127.0.0.1"].includes(database.hostname)
    || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname),
  "Immediate terminal resolution requires an isolated local app and database",
);
test.setTimeout(90_000);
test.use({ actionTimeout: 15_000, navigationTimeout: 60_000 });
const db = new PrismaClient();
const tenants: string[] = [];
const payments: string[] = [];
const evidence = "Revisé el datáfono: transacción cancelada, sin cobro ni voucher.";

async function fixture(page: Page, options: { role?: Role; uncertain?: boolean; pushed?: boolean } = {}) {
  const token = randomUUID();
  const role = options.role ?? "operator";
  const password = `Terminal-local-${token}`;
  const restaurant = await db.restaurant.create({ data: {
    name: "Restaurante de resolución de prueba", slug: `manual-terminal-${token}`,
    country: "CO", serviceMode: "table", enabledModules: [],
    enabledPaymentMethods: ["cash", "kushki_card_terminal"], salesTaxKind: "none",
    kitchenAutoFire: false, kitchenPrintEnabled: false, barPrintEnabled: false,
    invoiceAutoPrint: false, shiftPolicy: "global",
  } });
  tenants.push(restaurant.id);
  const user = await db.user.create({ data: {
    restaurantId: restaurant.id, role, name: "Personal de prueba",
    email: `manual-terminal-${token}@example.test`, passwordHash: await bcrypt.hash(password, 4),
  } });
  const table = await db.table.create({ data: { restaurantId: restaurant.id, number: 1, qrToken: token } });
  const order = await db.order.create({ data: {
    restaurantId: restaurant.id, tableId: table.id, shortCode: token, status: "paying",
    subtotalCents: 10_000_000, totalCents: 10_000_000, simpleInvoiceEmail: "",
    items: { create: { nameSnapshot: "Producto sintético", priceCentsSnapshot: 10_000_000, qty: 1 } },
  } });
  const payment = await db.payment.create({ data: {
    orderId: order.id, method: "kushki_card_terminal", status: "pending",
    amountCents: 10_000_000, tipCents: 0, reconciliationRequired: options.uncertain ?? false,
  } });
  payments.push(payment.id);
  const pushedAt = new Date(Date.now() - 500);
  if (options.pushed !== false) await db.financialOperation.create({ data: {
    key: `terminal:${payment.id}`, paymentId: payment.id, kind: "terminal",
    amountCents: payment.amountCents, status: "pending", createdAt: pushedAt,
    clientTransactionId: randomUUID(),
  } });
  await db.shift.create({ data: { restaurantId: restaurant.id, openedById: user.id, openingCashCents: 0 } });
  await page.route(/^https?:\/\//, route =>
    ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname)
      ? route.continue() : route.abort());
  await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: "es", domain: application.hostname, path: "/" }]);
  const headers = { "x-real-ip": `127.9.${parseInt(token.slice(0, 2), 16)}.${parseInt(token.slice(2, 4), 16)}` };
  await page.setExtraHTTPHeaders(headers);
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const login = await page.request.post("/api/auth/callback/credentials", {
    headers: { ...headers, "X-Auth-Return-Redirect": "1" },
    form: { csrfToken: csrf.csrfToken, email: user.email, password, callbackUrl: `${application.origin}/operator/tables` },
  });
  expect(login.ok()).toBe(true);
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(user.id);
  const checkout = role === "mesero" ? `/mesero/cobrar/${order.id}` : `/t/${restaurant.slug}/pay/${order.id}?op=1`;
  await page.goto(checkout);
  return { restaurant, order, payment, user, pushedAt };
}

async function fillEvidence(page: Page, text = evidence) {
  const dialog = page.getByRole("dialog", { name: "Resolver cobro del datáfono", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: /Nota de evidencia/ }).fill(text);
  await dialog.getByRole("checkbox").check();
  return dialog;
}

async function assertPaymentAge(pushedAt: Date) {
  // Guards against a slow test accidentally passing after the old three-minute gate.
  expect(Date.now() - pushedAt.getTime()).toBeLessThan(150_000);
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test.afterEach(async () => {
  if (payments.length) await db.financialOperation.deleteMany({ where: { paymentId: { in: payments } } });
  if (tenants.length) {
    await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
    await db.platformEvent.deleteMany({ where: { restaurantId: { in: tenants } } });
  }
  tenants.splice(0); payments.splice(0);
});
test.afterAll(() => db.$disconnect());

test("administrator cancels a newly sent terminal payment immediately after abort fails", async ({ page }, info) => {
  const f = await fixture(page);
  let aborts = 0;
  await page.route(`${application.origin}/api/operator/payments/${f.payment.id}/terminal-attempt`, async route => {
    expect(route.request().postDataJSON()).toMatchObject({ action: "cancel" });
    aborts += 1;
    // No provider call: reproduce the terminal's abort failure at the UI boundary.
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "pending", abort: "error" }) });
  });
  await page.getByRole("button", { name: "Cancelar en el datáfono", exact: true }).click();
  await expect.poll(() => aborts).toBe(1);
  const cancel = page.getByRole("button", { name: "Cancelar cobro manualmente", exact: true });
  await expect(cancel).toBeEnabled();
  await cancel.click();
  const dialog = page.getByRole("dialog", { name: "Resolver cobro del datáfono", exact: true });
  await expect(dialog.getByRole("radio", { name: "No se cobró → Marcar como rechazado", exact: true })).toBeChecked();
  const submit = dialog.getByRole("button", { name: "Marcar como rechazado", exact: true });
  await expect(submit).toBeDisabled();
  await fillEvidence(page);
  await expect(submit).toBeEnabled();
  await assertPaymentAge(f.pushedAt);
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath("immediate-manual-cancel.png"), fullPage: true });
  const resolved = page.waitForResponse(r => r.url().endsWith(`/payments/${f.payment.id}/resolve-terminal`) && r.request().method() === "POST");
  await submit.click();
  expect((await resolved).ok()).toBe(true);
  await expect.poll(async () => (await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status).toBe("declined");
  await expect(dialog).toHaveCount(0);
  expect((await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).not.toBe("paying");
  expect(await db.simpleInvoice.count({ where: { orderId: f.order.id } })).toBe(0);
  const audits = await db.auditEvent.findMany({ where: { restaurantId: f.restaurant.id, targetId: f.payment.id } });
  expect(audits.some(event => event.actorUserId === f.user.id && event.summary === evidence)).toBe(true);
});

test("manual resolution stays available while a provider lookup has not answered", async ({ page }, info) => {
  const f = await fixture(page, { uncertain: true });
  let release: (() => void) | undefined;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  await page.route(`${application.origin}/api/operator/payments/${f.payment.id}/terminal-attempt`, async route => {
    expect(route.request().postDataJSON()).toMatchObject({ action: "check" });
    started = true;
    await barrier;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "pending", result: "not_found" }) }).catch(() => undefined);
  });
  try {
    await page.getByRole("button", { name: "Consultar en Kushki", exact: true }).click();
    await expect.poll(() => started).toBe(true);
    await expect(page.getByRole("button", { name: "Consultando…", exact: true })).toBeDisabled();
    const resolve = page.getByRole("button", { name: "Resolver cobro", exact: true });
    await expect(resolve).toBeEnabled();
    await expect(page.getByText(/podrás resolverlo a mano en/)).toHaveCount(0);
    await resolve.click();
    const dialog = await fillEvidence(page, "Comprobante local verificado: pago aprobado por el datáfono.");
    await dialog.getByRole("radio", { name: "Sí se cobró → Marcar como aprobado", exact: true }).check();
    const submit = dialog.getByRole("button", { name: "Marcar como aprobado", exact: true });
    await expect(submit).toBeDisabled();
    await dialog.getByRole("textbox", { name: "Número de autorización o voucher", exact: true }).fill("LOCAL-12345");
    await expect(submit).toBeEnabled();
    await assertPaymentAge(f.pushedAt);
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath("manual-during-lookup.png"), fullPage: true });
    const response = page.waitForResponse(r => r.url().endsWith(`/payments/${f.payment.id}/resolve-terminal`) && r.request().method() === "POST");
    await submit.click();
    expect((await response).ok()).toBe(true);
    await expect.poll(async () => (await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status).toBe("approved");
    expect(await db.payment.count({ where: { orderId: f.order.id } })).toBe(1);
    expect(await db.simpleInvoice.count({ where: { orderId: f.order.id } })).toBe(1);
  } finally { release?.(); }
});

test("waiter cannot manually cancel or approve a sent terminal payment", async ({ page }) => {
  const f = await fixture(page, { role: "mesero" });
  await expect(page.getByRole("button", { name: "Cancelar en el datáfono", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancelar cobro manualmente", exact: true })).toHaveCount(0);
  const res = await page.request.post(`/api/operator/payments/${f.payment.id}/resolve-terminal`, { data: { outcome: "declined", evidence, confirmed: true } });
  expect(res.status()).toBe(403);
  expect((await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status).toBe("pending");
});

test("manual resolution preserves tenant, sent-payment and evidence checks", async ({ page }) => {
  const f = await fixture(page, { pushed: false });
  const endpoint = `/api/operator/payments/${f.payment.id}/resolve-terminal`;
  const invalid = await page.request.post(endpoint, { data: { outcome: "declined", evidence: "", confirmed: true } });
  expect(invalid.status()).toBe(400);
  const notSent = await page.request.post(endpoint, { data: { outcome: "declined", evidence, confirmed: true } });
  expect(notSent.status()).toBe(409);
  expect(await notSent.json()).toMatchObject({ error: "terminal_not_sent" });
  const token = randomUUID();
  const other = await db.restaurant.create({ data: { name: "Otro comercio de prueba", slug: token } });
  tenants.push(other.id);
  const table = await db.table.create({ data: { restaurantId: other.id, number: 1, qrToken: token } });
  const order = await db.order.create({ data: { restaurantId: other.id, tableId: table.id, shortCode: token, subtotalCents: 100_000, totalCents: 100_000 } });
  const payment = await db.payment.create({ data: { orderId: order.id, method: "kushki_card_terminal", status: "pending", amountCents: 100_000 } });
  payments.push(payment.id);
  await db.financialOperation.create({ data: { key: `terminal:${payment.id}`, paymentId: payment.id, kind: "terminal", amountCents: 100_000 } });
  const forbidden = await page.request.post(`/api/operator/payments/${payment.id}/resolve-terminal`, { data: { outcome: "declined", evidence, confirmed: true } });
  expect(forbidden.status()).toBe(403);
  expect((await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe("pending");
});

test("the sender can cancel manually while the initial terminal push is still waiting", async ({ page }, info) => {
  const f = await fixture(page, { pushed: false });
  // Synthetic terminal setup only exposes the send button. The request is
  // intercepted before reaching the app server, so no provider is contacted.
  await db.restaurant.update({ where: { id: f.restaurant.id }, data: {
    kushkiMode: "sandbox", cloudTerminalBusinessCode: `local-test-only-${f.restaurant.id}`,
  } });
  const device = await db.terminalDevice.create({ data: {
    restaurantId: f.restaurant.id, kushkiDeviceId: randomUUID(), label: "Datáfono de prueba local",
    serialNumber: `LOCAL-NO-PROVIDER-${randomUUID()}`, active: true,
  } });
  let release: (() => void) | undefined;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let pushedAt: Date | undefined;
  let requests = 0;
  let released = false;
  await page.route(`${application.origin}/api/tenant/${f.restaurant.slug}/terminal/charge`, async route => {
    expect(route.request().postDataJSON()).toMatchObject({ paymentId: f.payment.id, deviceId: device.kushkiDeviceId });
    requests += 1;
    pushedAt = new Date(Date.now() - 500);
    await db.financialOperation.create({ data: {
      key: `terminal:${f.payment.id}`, paymentId: f.payment.id, kind: "terminal", amountCents: f.payment.amountCents,
      createdAt: pushedAt, clientTransactionId: randomUUID(), deviceId: device.kushkiDeviceId,
    } });
    // Real local SSE invalidation refreshes the sent card while ServeBoard
    // retains its parent busy state for the unanswered push request.
    await db.platformEvent.create({ data: {
      restaurantId: f.restaurant.id, orderId: f.order.id,
      payload: { type: "order.updated", orderId: f.order.id },
    } });
    await barrier;
    released = true;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "local_test_delayed_push" }) }).catch(() => undefined);
  });
  try {
    await page.goto("/operator/serve");
    await page.getByRole("button", { name: /^Cobrar \$\s?100[.,]000$/, exact: false }).click();
    await expect.poll(() => requests).toBe(1);
    await expect(page.getByRole("button", { name: "Cancelar en el datáfono", exact: true })).toBeDisabled();
    const manual = page.getByRole("button", { name: "Cancelar cobro manualmente", exact: true });
    await expect(manual).toBeEnabled();
    expect(released).toBe(false);
    await manual.click();
    const dialog = await fillEvidence(page);
    await assertPaymentAge(pushedAt!);
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath("manual-cancel-during-initial-push.png"), fullPage: true });
    const response = page.waitForResponse(r => r.url().endsWith(`/payments/${f.payment.id}/resolve-terminal`) && r.request().method() === "POST");
    await dialog.getByRole("button", { name: "Marcar como rechazado", exact: true }).click();
    expect((await response).ok()).toBe(true);
    expect(released).toBe(false);
    expect((await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status).toBe("declined");
    expect(await db.simpleInvoice.count({ where: { orderId: f.order.id } })).toBe(0);
    expect(requests).toBe(1);
  } finally { release?.(); }
});
