// Cobro EN SERIE de una cuenta dividida (modo staff): tras cada pago
// aprobado el flujo se queda en la misma pantalla, muestra «Pago k de n
// aprobado · Pagado $X · Faltan $Y» y «Cobrar siguiente» repite el método
// anterior con el monto de la parte que sigue (la última, exacta). Un
// rechazo ofrece reintentar ESA parte sin rearmar nada, y recargar la
// página retoma el plan contra el saldo real del servidor.

import { test, expect, type Page } from "@playwright/test";
import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

const application = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3300");
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(
  !["localhost", "127.0.0.1"].includes(application.hostname)
    || !["localhost", "127.0.0.1"].includes(database.hostname)
    || !/^\/mesapay_.*(?:test|validation|browser)$/.test(database.pathname),
  "Serial split charges require an isolated local application and database",
);
test.setTimeout(90_000);
test.use({ actionTimeout: 20_000, navigationTimeout: 60_000 });
const db = new PrismaClient();
const tenants: string[] = [];

async function fixture(page: Page, options: { role?: Role; smartTerminal?: boolean } = {}) {
  const token = randomUUID();
  const password = `Serial-split-${token}`;
  const role = options.role ?? "operator";
  const restaurant = await db.restaurant.create({ data: {
    name: "Restaurante de cobros en serie", slug: `serial-${token}`,
    country: "CO", serviceMode: "table", enabledModules: [],
    kushkiMode: "mock", enabledPaymentMethods: options.smartTerminal ? ["cash", "kushki_card_terminal"] : ["cash", "external_terminal"], salesTaxKind: "none",
    kitchenAutoFire: false, kitchenPrintEnabled: false, barPrintEnabled: false,
    invoiceAutoPrint: false, shiftPolicy: "global",
  } });
  tenants.push(restaurant.id);
  if (options.smartTerminal) await db.terminalDevice.create({ data: {
    restaurantId: restaurant.id, kushkiDeviceId: token, label: "POS de prueba",
  } });
  const user = await db.user.create({ data: {
    restaurantId: restaurant.id, role, name: "Personal de prueba",
    email: `serial-${token}@example.test`, passwordHash: await bcrypt.hash(password, 4),
  } });
  const table = await db.table.create({ data: { restaurantId: restaurant.id, number: 1, qrToken: token } });
  const category = await db.category.create({ data: { restaurantId: restaurant.id, slug: "pruebas", label: "Platos" } });
  const dish = await db.menuItem.create({ data: {
    restaurantId: restaurant.id, categoryId: category.id, name: "Plato prueba serie", priceCents: 10_000_000,
  } });
  const order = await db.order.create({ data: {
    restaurantId: restaurant.id, tableId: table.id, shortCode: randomUUID(), status: "placed",
    subtotalCents: 10_000_000, totalCents: 10_000_000, simpleInvoiceEmail: "",
  } });
  const round = await db.round.create({ data: { orderId: order.id, seq: 1, status: "placed" } });
  await db.orderItem.create({ data: {
    orderId: order.id, roundId: round.id, menuItemId: dish.id, nameSnapshot: dish.name,
    qty: 1, priceCentsSnapshot: dish.priceCents, kitchenStatus: "ready", servedAt: new Date(),
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
  const checkout = role === "mesero"
    ? `/mesero/cobrar/${order.id}` : role === "terminal" ? `/terminal/cobrar/${order.id}` : `/t/${restaurant.slug}/pay/${order.id}?op=1`;
  await page.goto(checkout);
  return { restaurant, user, order, table, checkout };
}

async function chooseEqualSplit(page: Page) {
  await page.getByRole("button", { name: /^Partes iguales/ }).click();
  await expect(page.getByText("Dividir entre", { exact: true })).toBeVisible();
}

/** Cobra en efectivo el monto que ya trae el botón (la parte en curso). */
async function cashCurrentPart(page: Page) {
  await page.getByRole("button", { name: /^Recibir en efectivo ·/ }).click();
  const posting = page.waitForResponse(response => response.url().endsWith("/pay") && response.request().method() === "POST");
  await page.getByRole("button", { name: /^Confirmar cobro ·/ }).click();
  const result = await posting;
  expect(result.ok()).toBe(true);
  return result.json() as Promise<{ paymentId: string; paid: boolean }>;
}

async function requestExternal(page: Page) {
  const response = page.waitForResponse(result => result.url().endsWith("/pay/external-terminal-request") && result.request().method() === "POST");
  await page.getByRole("button", { name: /^Cobrar con datáfono del comercio ·/ }).click();
  expect((await response).ok()).toBe(true);
  await expect(page.getByRole("button", { name: "Confirmar pago recibido", exact: true })).toBeVisible();
}

async function settleExternal(page: Page) {
  const settling = page.waitForResponse(result => result.url().includes("/settle-external-terminal") && result.request().method() === "POST");
  await page.getByRole("button", { name: "Confirmar pago recibido", exact: true }).click();
  const settled = await settling;
  expect(settled.ok()).toBe(true);
  return settled.json() as Promise<{ paid: boolean }>;
}

test.afterEach(async () => {
  if (!tenants.length) return;
  const fixturePayments = await db.payment.findMany({ where: { order: { restaurantId: { in: tenants } } }, select: { id: true } });
  await db.financialOperation.deleteMany({ where: { paymentId: { in: fixturePayments.map(p => p.id) } } });
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.platformEvent.deleteMany({ where: { restaurantId: { in: tenants } } });
  tenants.splice(0);
});
test.afterAll(() => db.$disconnect());

test("administrador: partes iguales × 2 en efectivo, con «Cobrar siguiente» y recarga a mitad", async ({ page }, info) => {
  const f = await fixture(page);
  await chooseEqualSplit(page);
  // Parte 1 de 2: $50.000 de comida + 10% de propina = $55.000.
  await expect(page.getByRole("button", { name: /^Recibir en efectivo · \$\s?55,000$/ })).toBeVisible();
  const first = await cashCurrentPart(page);
  expect(first.paid).toBe(false);

  // El flujo SE QUEDA en el cobro, con el avance y la parte siguiente lista.
  await expect(page).toHaveURL(`${application.origin}${f.checkout}`);
  await expect(page.getByText("Pago 1 de 2 aprobado", { exact: true })).toBeVisible();
  await expect(page.getByText(/Pagado \$\s?50,000 · Faltan \$\s?50,000/)).toBeVisible();
  const next = page.getByTestId("serial-charge-next");
  await expect(next).toHaveText(/^Cobrar siguiente · \$\s?55,000$/);
  await page.screenshot({ path: info.outputPath("serial-part-approved.png"), fullPage: true });

  // Cerrar y reabrir «Cobrar» no rearma nada: mismo plan, mismo saldo real.
  await page.reload();
  await expect(page.getByTestId("serial-part-progress")).toHaveText("Va la parte 2 de 2.");
  await expect(page.getByRole("button", { name: /^Recibir en efectivo · \$\s?55,000$/ })).toBeVisible();

  // Un toque: «Cobrar siguiente» repite efectivo con el saldo EXACTO.
  await page.getByTestId("serial-charge-next").click();
  const posting = page.waitForResponse(response => response.url().endsWith("/pay") && response.request().method() === "POST");
  await page.getByRole("button", { name: /^Confirmar cobro · \$\s?55,000$/ }).click();
  expect(((await (await posting).json()) as { paid: boolean }).paid).toBe(true);
  await expect(page).toHaveURL(/\/done(?:\?|$)/);

  const finished = await db.order.findUniqueOrThrow({ where: { id: f.order.id }, include: { payments: true } });
  expect(finished).toMatchObject({ status: "paid", totalCents: 11_000_000, tipCents: 1_000_000 });
  expect(finished.payments).toHaveLength(2);
  expect(finished.payments.every(payment => payment.status === "approved")).toBe(true);
  expect(finished.payments.reduce((sum, payment) => sum + payment.amountCents, 0)).toBe(11_000_000);
});

test("un rechazo del datáfono del comercio ofrece reintentar ESA parte sin rearmar nada", async ({ page }, info) => {
  const f = await fixture(page);
  await chooseEqualSplit(page);
  await requestExternal(page);

  // El equipo no aprobó: se declina y la parte queda igual para reintentar.
  page.once("dialog", dialog => dialog.accept());
  const declining = page.waitForResponse(result => result.url().includes("/settle-external-terminal") && result.request().method() === "POST");
  await page.getByRole("button", { name: "No se recibió este pago", exact: true }).click();
  expect((await declining).ok()).toBe(true);
  await expect(page.getByText("No se aprobó el pago de esta parte", { exact: true })).toBeVisible();
  const retry = page.getByTestId("serial-charge-next");
  await expect(retry).toHaveText(/^Reintentar · \$\s?55,000$/);
  await page.screenshot({ path: info.outputPath("serial-part-declined.png"), fullPage: true });

  // Reintento con un toque: mismo método, mismo monto.
  await retry.click();
  await expect(page.getByRole("button", { name: "Confirmar pago recibido", exact: true })).toBeVisible();
  expect((await settleExternal(page)).paid).toBe(false);
  await expect(page.getByText("Pago 1 de 2 aprobado", { exact: true })).toBeVisible();

  // La última parte cobra exacto el saldo y cierra la cuenta.
  await page.getByTestId("serial-charge-next").click();
  await expect(page.getByRole("button", { name: "Confirmar pago recibido", exact: true })).toBeVisible();
  expect((await settleExternal(page)).paid).toBe(true);
  await expect(page).toHaveURL(/\/done(?:\?|$)/);
  const payments = await db.payment.findMany({ where: { orderId: f.order.id, status: "approved" } });
  expect(payments).toHaveLength(2);
  expect(payments.reduce((sum, payment) => sum + payment.amountCents, 0)).toBe(11_000_000);
});

test("mesero (PWA): el cobro en serie vive en /mesero y termina en su pantalla de listo", async ({ page }) => {
  const f = await fixture(page, { role: "mesero" });
  await chooseEqualSplit(page);
  const first = await cashCurrentPart(page);
  expect(first.paid).toBe(false);
  await expect(page).toHaveURL(`${application.origin}${f.checkout}`);
  await expect(page.getByText("Pago 1 de 2 aprobado", { exact: true })).toBeVisible();
  await page.getByTestId("serial-charge-next").click();
  const posting = page.waitForResponse(response => response.url().endsWith("/pay") && response.request().method() === "POST");
  await page.getByRole("button", { name: /^Confirmar cobro ·/ }).click();
  expect(((await (await posting).json()) as { paid: boolean }).paid).toBe(true);
  await expect(page).toHaveURL(`${application.origin}/mesero/cobrar/${f.order.id}/done`);
  expect((await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe("paid");
});

async function mockTerminalResult(page: Page, paymentId: string, status: "approved" | "declined") {
  const response = await page.request.post("/api/webhooks/kushki", { data: {
    eventId: randomUUID(), type: `terminal.${status}`, paymentId, providerRef: `mock-${paymentId}`,
  } });
  expect(response.ok()).toBe(true);
  expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe(status);
}

test("mesero recupera el cobro cuando el datáfono rechaza y el POST sigue sin responder", async ({ page }, info) => {
  const f = await fixture(page, { role: "mesero", smartTerminal: true });
  let paymentId = "";
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/terminal/charge", async route => {
    paymentId = route.request().postDataJSON().paymentId;
    await held;
    await route.fulfill({ json: { ok: true } }).catch(() => {});
  });
  try {
    const charge = page.getByRole("button", { name: /Cobrar con datáfono ·/ });
    await charge.click();
    await expect.poll(() => paymentId).toBeTruthy();
    await expect(page.getByRole("button", { name: "Procesando…" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Cancelar y volver a intentar" })).toBeVisible({ timeout: 8000 });
    await mockTerminalResult(page, paymentId, "declined");
    await expect(charge).toBeEnabled({ timeout: 10_000 });
    await expect(page.getByText("El datáfono no aprobó el cobro.", { exact: true })).toBeVisible();
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
    await charge.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("despues.png"), fullPage: true });
    expect(new URL(page.url()).pathname).toBe(f.checkout);
    expect(await db.payment.count({ where: { orderId: f.order.id } })).toBe(1);
  } finally { release(); }
});

for (const answered of [false, true]) {
  test(`cancelar y reintentar antes del límite, con respuesta previa del equipo: ${answered}`, async ({ page }) => {
    const f = await fixture(page, { role: answered ? "operator" : "mesero", smartTerminal: true });
    const ids: string[] = [];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/terminal/charge", async route => {
      const { paymentId, deviceId } = route.request().postDataJSON();
      if (!ids.length) {
        const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
        await db.financialOperation.create({ data: {
          key: `terminal:${paymentId}`, kind: "terminal", paymentId, deviceId,
          amountCents: payment.amountCents, clientTransactionId: randomUUID(),
          answeredAt: answered ? new Date() : null,
        } });
      }
      if (ids.length === 1 && !answered) {
        // Same payment and live claim: the real push route must decline to send twice.
        const result = await page.request.post(route.request().url(), { data: { paymentId, deviceId } });
        expect(await result.json()).toMatchObject({ pending: true });
      }
      ids.push(paymentId);
      await held;
      await route.fulfill({ json: { ok: true } }).catch(() => {});
    });
    try {
      const charge = page.getByRole("button", { name: /Cobrar con datáfono ·/ });
      await charge.click();
      await expect.poll(() => ids.length).toBe(1);
      page.on("dialog", dialog => dialog.accept());
      await page.getByRole("button", { name: "Cancelar y volver a intentar" }).click();
      await expect(charge).toBeEnabled();
      if (!answered) {
        await expect(page.getByText(/No sabemos si el datáfono alcanzó a cobrar/)).toBeVisible();
        await expect(page.getByRole("button", { name: "Consultar estado", exact: true })).toBeVisible();
      }
      expect((await db.payment.findUniqueOrThrow({ where: { id: ids[0] } })).status).toBe(answered ? "declined" : "pending");
      await charge.click();
      await expect.poll(() => ids.length).toBe(2);
      if (answered) {
        expect(ids[1]).not.toBe(ids[0]);
        await mockTerminalResult(page, ids[1], "approved");
      } else expect(ids[1]).toBe(ids[0]);
      await mockTerminalResult(page, ids[0], "approved");
      const payments = await db.payment.findMany({ where: { orderId: f.order.id } });
      expect(payments.filter(p => p.status === "approved" && !p.reconciliationRequired)).toHaveLength(1);
      expect(payments.find(p => p.id === ids[0])?.reconciliationRequired).toBe(answered);
      expect(await db.simpleInvoice.count({ where: { orderId: f.order.id } })).toBe(1);
      if (answered) {
        await page.goto("/operator/payments?status=review");
        await expect(page.getByRole("link", { name: /^Requiere revisión/ }).first()).toBeVisible();
      }
    } finally {
      release();
      await db.financialOperation.deleteMany({ where: { paymentId: { in: ids } } });
    }
  });
}

test("operador por ficha: liberar un datáfono externo aunque se haya perdido la primera respuesta", async ({ page }) => {
  const f = await fixture(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/pay/external-terminal-request", async route => {
    await page.request.post(route.request().url(), { data: route.request().postDataJSON() });
    await held;
    await route.abort().catch(() => {});
  });
  try {
    const charge = page.getByRole("button", { name: /Cobrar con datáfono del comercio ·/ });
    await charge.click();
    await page.getByRole("button", { name: "Cancelar y volver a intentar" }).click();
    await expect(charge).toBeEnabled();
    expect(await db.payment.findFirstOrThrow({ where: { orderId: f.order.id } })).toMatchObject({ status: "declined" });
  } finally { release(); }
});

for (const registered of [false, true]) {
  test(`usuario datáfono: el límite exige consultar o confirmar el reintento, pago registrado: ${registered}`, async ({ page }) => {
    await fixture(page, { role: "terminal", smartTerminal: true });
    await page.clock.install();
    let posts = 0;
    const endpoint = registered ? "**/terminal/charge" : "**/pay/terminal-request";
    let initialBody: Record<string, unknown> = {};
    let requestUrl = "";
    await page.route(endpoint, async route => {
      posts++;
      requestUrl = route.request().url();
      initialBody = route.request().postDataJSON();
      await route.abort();
    });
    const charge = page.getByRole("button", { name: /Cobrar con datáfono ·/ });
    await charge.click();
    await expect.poll(() => posts).toBe(1);
    await expect(page.getByRole("button", { name: "Procesando…" })).toBeDisabled();
    await page.clock.fastForward(120_001);
    await expect(charge).toBeEnabled();
    if (!registered) {
      await expect(page.getByText("No se registró el cobro. Puedes volver a intentarlo.")).toBeVisible();
      // A delayed copy of the original POST cannot revive the closed attempt.
      const latePost = await page.request.post(requestUrl, { data: initialBody });
      expect(latePost.status()).toBe(409);
      expect(await db.payment.count({ where: { orderId: String(initialBody.orderId) } })).toBe(0);
      const oldAttempt = initialBody.attemptId;
      await charge.click();
      await expect.poll(() => posts).toBe(2);
      expect(initialBody.attemptId).not.toBe(oldAttempt);
      return;
    }
    await expect(page.getByText(/No sabemos si el datáfono alcanzó a cobrar/)).toBeVisible();
    const checking = page.waitForRequest(r => r.url().includes(registered ? "/terminal-attempt" : "/terminal-status?"));
    await page.getByRole("button", { name: "Consultar estado", exact: true }).click();
    await checking;
    const confirmation = page.waitForEvent("dialog");
    const click = charge.click();
    await (await confirmation).dismiss();
    await click;
    expect(posts).toBe(1);

    // The server declines between automatic reads. A conscious retry must
    // claim a fresh payment even though the stale card still says unknown.
    const declinedId = String(initialBody.paymentId);
    await mockTerminalResult(page, declinedId, "declined");
    page.once("dialog", dialog => dialog.accept());
    await charge.click();
    await expect.poll(() => posts).toBe(2);
    expect(initialBody.paymentId).not.toBe(declinedId);
  });
}

for (const adjustment of ["partial", "tip"] as const) {
  test(`mesero: el sondeo conserva el importe autorizado por el datáfono (${adjustment})`, async ({ page }) => {
    const f = await fixture(page, { role: "mesero", smartTerminal: true });
    let paymentId = "";
    await page.route("**/terminal/charge", async route => {
      paymentId = route.request().postDataJSON().paymentId;
      await route.abort();
    });
    await page.getByRole("button", { name: /Cobrar con datáfono ·/ }).click();
    await expect.poll(() => paymentId).toBeTruthy();
    const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const authorizedCents = adjustment === "partial" ? 7_000_000 : payment.amountCents + 500_000;
    // Same ledger/amount snapshot the mock provider commits on a confirmed adjustment.
    await db.$transaction([
      db.financialOperation.create({ data: { key: `terminal:${paymentId}`, paymentId, kind: "terminal",
        status: "completed", amountCents: payment.amountCents, authorizedCents, amountCheck: adjustment } }),
      db.payment.update({ where: { id: paymentId }, data: { amountCents: authorizedCents,
        tipCents: adjustment === "partial" ? 0 : payment.tipCents + 500_000 } }),
    ]);
    await mockTerminalResult(page, paymentId, "approved");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const expected = adjustment === "partial" ? /El datáfono aprobó solo .*Quedan .* por pagar/ : /se registró como propina.*Total cobrado/;
    await expect(page.getByRole("status").filter({ hasText: expected })).toBeVisible({ timeout: 10_000 });
    if (adjustment === "partial") await expect(page).toHaveURL(`${application.origin}${f.checkout}`, { timeout: 12_000 });
    else await expect(page).toHaveURL(/\/done(?:\?|$)/, { timeout: 12_000 });
  });
}

test.describe("mesero en un navegador Android sin impresión local", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    userAgent: "Mozilla/5.0 (Android 11; Mobile; rv:107.0) Gecko/107.0 Firefox/107.0",
  });
  for (const flow of ["factura previa", "partes iguales"] as const) {
    test(`mesero cobra con datáfono mock tras ${flow}`, async ({ page }, info) => {
      test.skip(process.env.KUSHKI_MOCK_TERMINAL_AUTHORIZED !== "+0", "Run with deterministic mock approval (+0) on both server and runner");
      const f = await fixture(page, { role: "mesero", smartTerminal: true });
      if (flow === "factura previa") {
        const customer = await page.request.post(`/api/tenant/${f.restaurant.slug}/orders/${f.order.id}/invoice-request`, {
          data: { customerName: "Cliente de prueba", docNumber: "12345678", docType: "CC",
            email: "cliente@example.test", rememberCustomer: true },
        });
        expect(customer.ok(), await customer.text()).toBe(true);
        expect(await db.billingCustomer.count({ where: { restaurantId: f.restaurant.id, email: "cliente@example.test" } })).toBe(1);
        const invoice = await page.request.post(`/api/operator/orders/${f.order.id}/pre-invoice`, { data: {} });
        expect(invoice.ok(), await invoice.text()).toBe(true);
        // Reproduce the accepted banner without contacting the tax authority.
        await db.dianDocument.create({ data: {
          restaurantId: f.restaurant.id, orderId: f.order.id, simpleInvoiceId: (await invoice.json()).invoiceId, state: "accepted",
        } });
        await page.reload();
        await expect(page.getByText("Aceptada por la DIAN", { exact: true })).toBeVisible();
        await page.getByRole("radio", { name: "Datáfono", exact: true }).click();
      } else {
        await chooseEqualSplit(page);
      }
      let resume!: () => void;
      const waiting = new Promise<void>(resolve => { resume = resolve; });
      await page.route("**/terminal/charge", async route => {
        await waiting;
        await route.continue();
      });
      try {
        const push = page.waitForRequest(req => req.url().endsWith("/terminal/charge"));
        await page.getByRole("button", { name: /Cobrar con datáfono ·/ }).click();
        await push;
        await expect(page.getByRole("button", { name: "Procesando…" })).toBeDisabled();
        if (flow === "factura previa") {
          const reprint = page.getByRole("button", { name: "Reimprimir factura" });
          await expect(reprint).toBeDisabled();
          await expect(page.getByRole("radio", { name: "Datáfono", exact: true })).toBeDisabled();
          await expect(page.getByRole("radio", { name: "Este dispositivo" })).toBeDisabled();
          await expect(page.getByRole("radio", { name: "Impresora de caja" })).toBeEnabled();
          await reprint.scrollIntoViewIfNeeded();
        }
        await page.screenshot({ path: info.outputPath(flow + ".png") });
      } finally { resume(); }
      if (flow === "partes iguales") {
        await expect(page.getByText("Pago 1 de 2 aprobado", { exact: true })).toBeVisible({ timeout: 30000 });
        await page.getByTestId("serial-charge-next").click();
      }
      await expect.poll(async () => (await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).status,
        { timeout: 30000 }).toBe("paid");
      expect(await db.payment.count({ where: { orderId: f.order.id, status: "approved" } })).toBe(flow === "partes iguales" ? 2 : 1);
      if (flow === "factura previa") {
        await expect(page).toHaveURL(/\/done(?:\?|$)/);
        await page.getByRole("radio", { name: "Datáfono", exact: true }).click();
        await page.getByRole("button", { name: "Imprimir factura", exact: true }).click();
        const notice = page.getByText(/Espera un minuto desde la aprobación/);
        await expect(notice).toBeVisible();
        await notice.scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath("despues-aprobacion.png") });
      }
    });
  }
});

test("la API protege el serial cuando coinciden una impresión y un cobro", async ({ page }) => {
  const f = await fixture(page, { role: "mesero", smartTerminal: true });
  const device = await db.terminalDevice.findFirstOrThrow({ where: { restaurantId: f.restaurant.id } });
  const serial = randomUUID();
  await db.terminalDevice.update({ where: { id: device.id }, data: { serialNumber: serial } });
  const second = await db.terminalDevice.create({ data: {
    restaurantId: f.restaurant.id, kushkiDeviceId: randomUUID(), serialNumber: randomUUID(), label: "Segundo equipo",
  } });
  const tenant = `/api/tenant/${f.restaurant.slug}`;
  const requestPayment = async () => {
    const response = await page.request.post(`${tenant}/pay/terminal-request`, {
      data: { orderId: f.order.id, amountCents: f.order.totalCents / 2, tipCents: 0, attemptId: randomUUID() },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).paymentId as string;
  };
  const push = (paymentId: string) => page.request.post(`${tenant}/terminal/charge`, { data: { paymentId, deviceId: device.kushkiDeviceId } });
  const print = (deviceId: string) => page.request.post("/api/operator/print/terminal", {
    data: { kind: "prebill", orderId: f.order.id, deviceId },
  });
  const jobId = randomUUID();
  await db.terminalPrintReservation.create({ data: { serial, jobId } });
  try {
    const paymentId = await requestPayment();
    const blocked = await push(paymentId);
    expect(blocked.status()).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: "terminal_printing", status: "declined" });
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe("declined");
    expect(await db.financialOperation.findUnique({ where: { key: `terminal:${paymentId}` } })).toBeNull();
    expect((await print(second.kushkiDeviceId)).ok()).toBe(true);
  } finally {
    await db.terminalPrintReservation.deleteMany({ where: { serial, jobId } });
  }
  const paymentId = await requestPayment();
  // A previous job may still be pending at the provider after our deadline.
  await db.terminalPrintReservation.create({ data: { serial, jobId, fault: "timeout", createdAt: new Date(Date.now() - 181_000) } });
  expect((await push(paymentId)).ok()).toBe(true);
  expect(await db.terminalPrintReservation.findUnique({ where: { serial } })).toBeNull();
  const conflict = await print(device.kushkiDeviceId);
  expect(conflict.status()).toBe(409);
  expect(await conflict.json()).toEqual({ error: "terminal_charging" });
  expect((await print(second.kushkiDeviceId)).ok()).toBe(true);
  await expect.poll(async () => (await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status)
    .not.toBe("pending");
  if (process.env.KUSHKI_MOCK_TERMINAL_AUTHORIZED === "+0") {
    expect(await (await print(device.kushkiDeviceId)).json()).toMatchObject({ error: "terminal_post_approval" });
    expect((await print(second.kushkiDeviceId)).ok()).toBe(true);
    await db.payment.update({ where: { id: paymentId }, data: { settledAt: new Date(Date.now() - 61_000) } });
    expect((await print(device.kushkiDeviceId)).ok()).toBe(true);

    // Deliberately seed unresolved snapshots. None may hold printing indefinitely.
    await db.payment.update({ where: { id: paymentId }, data: { status: "pending", settledAt: null } });
    for (const update of [{ status: "uncertain" }, { status: "pending", createdAt: new Date(Date.now() - 151_000) }]) {
      await db.financialOperation.update({ where: { key: `terminal:${paymentId}` }, data: update });
      expect((await print(device.kushkiDeviceId)).ok()).toBe(true);
    }
  }
});

test("un datáfono ocupado permite reintentar la misma parte en serie", async ({ page }) => {
  test.skip(process.env.KUSHKI_MOCK_TERMINAL_AUTHORIZED !== "+0");
  const f = await fixture(page, { role: "mesero", smartTerminal: true });
  const device = await db.terminalDevice.findFirstOrThrow({ where: { restaurantId: f.restaurant.id } });
  const serial = `mock:${device.kushkiDeviceId}`;
  await db.terminalPrintReservation.create({ data: { serial, jobId: randomUUID() } });
  try {
    await chooseEqualSplit(page);
    await page.getByRole("button", { name: /Cobrar con datáfono ·/ }).click();
    await expect(page.getByTestId("serial-charge-next")).toHaveText(/^Reintentar/);
    await expect(page.getByText("El datáfono está imprimiendo.", { exact: false })).toBeVisible();
    expect(await db.payment.count({ where: { orderId: f.order.id, status: "pending" } })).toBe(0);
  } finally {
    await db.terminalPrintReservation.deleteMany({ where: { serial } });
  }
  await page.getByTestId("serial-charge-next").click();
  await expect(page.getByText("Pago 1 de 2 aprobado", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("serial-charge-next").click();
  await expect.poll(() => db.payment.count({ where: { orderId: f.order.id, status: "approved" } }), { timeout: 30_000 }).toBe(2);
});
