import { test, expect, type Page } from "@playwright/test";
import { PrismaClient, type Role, type ServiceMode } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

const application = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3300");
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(
  !["localhost", "127.0.0.1"].includes(application.hostname)
    || !["localhost", "127.0.0.1"].includes(database.hostname)
    || !/^\/mesapay_.*(?:test|validation|browser)$/.test(database.pathname),
  "Mixed payment regressions require an isolated local application and database",
);
test.setTimeout(90_000);
test.use({ actionTimeout: 20_000, navigationTimeout: 60_000 });
const db = new PrismaClient();
const tenants: string[] = [];

async function fixture(page: Page, options: {
  role?: Role; serviceMode?: ServiceMode; locale?: string;
} = {}) {
  const token = randomUUID();
  const password = `Mixed-payment-${token}`;
  const role = options.role ?? "operator";
  const restaurant = await db.restaurant.create({ data: {
    name: "Restaurante de pagos combinados", slug: `mixed-${token}`,
    country: "CO", serviceMode: options.serviceMode ?? "table", enabledModules: [],
    enabledPaymentMethods: ["cash", "external_terminal"], salesTaxKind: "none",
    kitchenAutoFire: false, kitchenPrintEnabled: false, barPrintEnabled: false,
    invoiceAutoPrint: false, shiftPolicy: "global",
  } });
  tenants.push(restaurant.id);
  const user = await db.user.create({ data: {
    restaurantId: restaurant.id, role, name: "Personal de prueba",
    email: `mixed-${token}@example.test`, passwordHash: await bcrypt.hash(password, 4),
  } });
  const table = await db.table.create({ data: { restaurantId: restaurant.id, number: 1, qrToken: token } });
  const category = await db.category.create({ data: { restaurantId: restaurant.id, slug: "pruebas", label: "Platos" } });
  const dish = await db.menuItem.create({ data: {
    restaurantId: restaurant.id, categoryId: category.id, name: "Plato prueba combinados", priceCents: 10_000_000,
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
  await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: options.locale ?? "es", domain: application.hostname, path: "/" }]);
  const headers = { "x-real-ip": `127.8.${parseInt(token.slice(0, 2), 16)}.${parseInt(token.slice(2, 4), 16)}` };
  await page.setExtraHTTPHeaders(headers);
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const login = await page.request.post("/api/auth/callback/credentials", {
    headers: { ...headers, "X-Auth-Return-Redirect": "1" },
    form: { csrfToken: csrf.csrfToken, email: user.email, password, callbackUrl: `${application.origin}/operator/tables` },
  });
  expect(login.ok()).toBe(true);
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(user.id);
  const checkout = role === "mesero"
    ? `/mesero/cobrar/${order.id}` : `/t/${restaurant.slug}/pay/${order.id}?op=1`;
  await page.goto(checkout);
  return { restaurant, user, order, table, checkout };
}

async function chooseMixed(page: Page) {
  await page.getByRole("button", { name: /^Combinar medios/ }).click();
  await expect(page.getByLabel("Importe de este pago", { exact: true })).toBeVisible();
}

async function cash(page: Page, amount: string, change?: { tender: string; returned: string }) {
  await page.getByLabel("Importe de este pago", { exact: true }).fill(amount);
  await page.getByRole("button", { name: /^Recibir en efectivo ·/ }).click();
  if (change) {
    await page.getByLabel("Recibido del cliente", { exact: true }).fill(change.tender);
    await page.getByLabel("Devuelta dada", { exact: true }).fill(change.returned);
  }
  const posting = page.waitForResponse(response => response.url().endsWith("/pay") && response.request().method() === "POST");
  await page.getByRole("button", { name: /^Confirmar cobro ·/ }).click();
  const result = await posting;
  expect(result.ok()).toBe(true);
  return result.json() as Promise<{ paymentId: string; paid: boolean }>;
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test.afterEach(async () => {
  if (!tenants.length) return;
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.platformEvent.deleteMany({ where: { restaurantId: { in: tenants } } });
  tenants.splice(0);
});
test.afterAll(() => db.$disconnect());

for (const scenario of [
  { name: "administrator table", role: "operator", serviceMode: "table" },
  { name: "waiter counter", role: "mesero", serviceMode: "counter" },
] as const) {
  test(`${scenario.name}: cash then external terminal settles one account and one invoice`, async ({ page }, info) => {
    const f = await fixture(page, scenario);
    await chooseMixed(page);
    const first = await cash(page, "30000", { tender: "50000", returned: "20000" });
    expect(first.paid).toBe(false);
    await expect(page).toHaveURL(`${application.origin}${f.checkout}`);
    await expect.poll(() => db.payment.count({ where: { orderId: f.order.id, status: "approved" } })).toBe(1);
    expect(await db.simpleInvoice.count({ where: { orderId: f.order.id } })).toBe(0);
    expect((await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).not.toBe("paid");
    const recorded = await db.payment.findUniqueOrThrow({ where: { id: first.paymentId } });
    expect(recorded).toMatchObject({ method: "cash", amountCents: 3_000_000, tipCents: 272_727, cashTenderCents: 5_000_000, collectedByUserId: f.user.id });
    await expect(page.getByLabel("Importe de este pago", { exact: true })).toHaveValue("80.000");
    await expect(page.getByRole("region", { name: "Pagos de la cuenta", exact: true })).toContainText("Efectivo");
    // Reload must preserve the chosen account tip and the mixed-payment workflow.
    await page.reload();
    await expect(page.getByLabel("Importe de este pago", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cobrar saldo restante", exact: true }).click();
    await expect(page.getByLabel("Importe de este pago", { exact: true })).toHaveValue("80.000");
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath("mixed-cash-remainder.png"), fullPage: true });
    const requested = page.waitForResponse(response => response.url().endsWith("/pay/external-terminal-request") && response.request().method() === "POST");
    await page.getByRole("button", { name: /^Cobrar con datáfono del comercio ·/ }).click();
    expect((await requested).ok()).toBe(true);
    await expect(page).toHaveURL(`${application.origin}${f.checkout}`);
    const confirm = page.getByRole("button", { name: "Confirmar pago recibido", exact: true });
    await expect(confirm).toBeVisible();
    await expect(confirm).toBeInViewport();
    const pending = await db.payment.findFirstOrThrow({ where: { orderId: f.order.id, status: "pending" } });
    expect(pending).toMatchObject({ method: "external_terminal", amountCents: 8_000_000, tipCents: 727_273 });
    expect(await db.simpleInvoice.count({ where: { orderId: f.order.id } })).toBe(0);
    await expect(page.getByRole("button", { name: /^Recibir en efectivo ·/ })).toBeDisabled();
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath("mixed-terminal-awaiting-confirmation.png"), fullPage: true });
    const settling = page.waitForResponse(response => response.url().includes("/settle-external-terminal") && response.request().method() === "POST");
    await confirm.click();
    const settled = await settling;
    expect(settled.ok()).toBe(true);
    expect(await settled.json()).toMatchObject({ paid: true });
    await expect(page).toHaveURL(/\/done(?:\?|$)/);
    await expect.poll(() => db.simpleInvoice.count({ where: { orderId: f.order.id } })).toBe(1);
    const finished = await db.order.findUniqueOrThrow({ where: { id: f.order.id }, include: { payments: true, simpleInvoice: true } });
    expect(finished).toMatchObject({ status: "paid", totalCents: 11_000_000, tipCents: 1_000_000 });
    expect(finished.payments).toHaveLength(2);
    expect(finished.payments.every(payment => payment.status === "approved")).toBe(true);
    expect(finished.payments.reduce((sum, payment) => sum + payment.amountCents, 0)).toBe(11_000_000);
    expect(finished.payments.reduce((sum, payment) => sum + payment.tipCents, 0)).toBe(1_000_000);
    expect(finished.simpleInvoice?.totalCents).toBe(11_000_000);
    expect(await db.dianDocument.count({ where: { orderId: f.order.id } })).toBe(0);
    await page.reload();
    expect(await db.simpleInvoice.count({ where: { orderId: f.order.id } })).toBe(1);
    await noOverflow(page);
    if (scenario.role === "operator") {
      const shift = await page.request.get("/api/operator/shifts/current");
      expect(shift.ok()).toBe(true);
      expect(await shift.json()).toMatchObject({ expectedCashCents: 3_000_000, metrics: { grossCents: 11_000_000, cashCents: 3_000_000, tipCents: 1_000_000 } });
    }
  });
}

test("invalid amounts cannot charge or create payment requests", async ({ page }) => {
  const f = await fixture(page);
  await chooseMixed(page);
  const amount = page.getByLabel("Importe de este pago", { exact: true });
  for (const value of ["", "0", "110001"]) {
    await amount.fill(value);
    await expect(page.getByRole("button", { name: /^Recibir en efectivo ·/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: /^Cobrar con datáfono del comercio ·/ })).toBeDisabled();
  }
  expect(await db.payment.count({ where: { orderId: f.order.id } })).toBe(0);
  await page.getByRole("button", { name: "Cobrar saldo restante", exact: true }).click();
  await expect(amount).toHaveValue("110.000");
  await expect(page.getByRole("button", { name: /^Recibir en efectivo ·/ })).toBeEnabled();
});

test("a declined external request can be replaced, then its approved partial leaves cash balance", async ({ page }) => {
  const f = await fixture(page);
  await chooseMixed(page);
  const amount = page.getByLabel("Importe de este pago", { exact: true });
  await amount.fill("40000");
  const requestExternal = async () => {
    const response = page.waitForResponse(result => result.url().endsWith("/pay/external-terminal-request") && result.request().method() === "POST");
    await page.getByRole("button", { name: /^Cobrar con datáfono del comercio ·/ }).click();
    expect((await response).ok()).toBe(true);
    await expect(page.getByRole("button", { name: "Confirmar pago recibido", exact: true })).toBeVisible();
  };
  await requestExternal();
  page.once("dialog", dialog => dialog.accept());
  const declining = page.waitForResponse(result => result.url().includes("/settle-external-terminal") && result.request().method() === "POST");
  await page.getByRole("button", { name: "No se recibió este pago", exact: true }).click();
  const declined = await declining;
  expect(declined.ok()).toBe(true);
  expect(await db.payment.count({ where: { orderId: f.order.id, status: "declined" } })).toBe(1);
  expect(await db.simpleInvoice.count({ where: { orderId: f.order.id } })).toBe(0);
  await expect(page.getByRole("button", { name: /^Recibir en efectivo ·/ })).toBeEnabled();
  await amount.fill("40000");
  await requestExternal();
  const approving = page.waitForResponse(result => result.url().includes("/settle-external-terminal") && result.request().method() === "POST");
  await page.getByRole("button", { name: "Confirmar pago recibido", exact: true }).click();
  const approved = await approving;
  expect(approved.ok()).toBe(true);
  expect(await approved.json()).toMatchObject({ paid: false });
  await expect(page).toHaveURL(`${application.origin}${f.checkout}`);
  await expect(amount).toHaveValue("70.000");
  expect(await db.simpleInvoice.count({ where: { orderId: f.order.id } })).toBe(0);
  expect((await cash(page, "70000")).paid).toBe(true);
  await expect(page).toHaveURL(/\/done(?:\?|$)/);
  const payments = await db.payment.findMany({ where: { orderId: f.order.id, status: "approved" } });
  expect(payments).toHaveLength(2);
  expect(payments.find(payment => payment.method === "cash")?.amountCents).toBe(7_000_000);
  expect(payments.reduce((sum, payment) => sum + payment.amountCents, 0)).toBe(11_000_000);
  expect(payments.reduce((sum, payment) => sum + payment.tipCents, 0)).toBe(1_000_000);
  expect(await db.simpleInvoice.count({ where: { orderId: f.order.id } })).toBe(1);
});

test("a selected zero tip survives reload after a partial and never adds a second tip", async ({ page }) => {
  const f = await fixture(page);
  await chooseMixed(page);
  await page.getByRole("button", { name: "Sin propina", exact: true }).click();
  expect((await cash(page, "25000")).paid).toBe(false);
  await page.reload();
  await expect(page.getByLabel("Importe de este pago", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cobrar saldo restante", exact: true }).click();
  await expect(page.getByLabel("Importe de este pago", { exact: true })).toHaveValue("75.000");
  expect((await cash(page, "75000")).paid).toBe(true);
  await expect(page).toHaveURL(/\/done(?:\?|$)/);
  const approved = await db.payment.findMany({ where: { orderId: f.order.id, status: "approved" } });
  expect(approved).toHaveLength(2);
  expect(approved.reduce((sum, payment) => sum + payment.amountCents, 0)).toBe(10_000_000);
  expect(approved.reduce((sum, payment) => sum + payment.tipCents, 0)).toBe(0);
});

test("a lost cash response retries the original amount and identity without collecting twice", async ({ page }) => {
  const f = await fixture(page);
  await chooseMixed(page);
  const attempts: { key: string | undefined; body: string | null }[] = [];
  let savedPaymentId: string | undefined;
  await page.route(`${application.origin}/api/tenant/${f.restaurant.slug}/pay`, async route => {
    attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
    if (attempts.length !== 1) {
      await route.continue();
      return;
    }
    // The server commits the real local fixture; only its response is lost.
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    savedPaymentId = (await response.json()).paymentId;
    await route.abort("failed");
  });
  await page.getByLabel("Importe de este pago", { exact: true }).fill("30000");
  await page.getByRole("button", { name: /^Recibir en efectivo ·/ }).click();
  await page.getByRole("button", { name: /^Confirmar cobro ·/ }).click();
  const retry = page.getByRole("button", { name: "Verificar el mismo pago", exact: true });
  await expect(retry).toBeEnabled();
  await expect.poll(() => db.payment.count({ where: { orderId: f.order.id, status: "approved" } })).toBe(1);
  await expect(page.getByLabel("Importe de este pago", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: /^Recibir en efectivo ·/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: /^Cobrar con datáfono del comercio ·/ })).toBeDisabled();
  const verifying = page.waitForResponse(response => response.url().endsWith("/pay") && response.request().method() === "POST");
  await retry.click();
  const verified = await verifying;
  expect(verified.ok()).toBe(true);
  expect(await verified.json()).toMatchObject({ paid: false, paymentId: savedPaymentId });
  await expect(page.getByLabel("Importe de este pago", { exact: true })).toHaveValue("80.000");
  await expect(page.getByRole("button", { name: /^Recibir en efectivo ·/ })).toBeEnabled();
  expect(attempts).toHaveLength(2);
  expect(attempts[0].key).toBeTruthy();
  expect(attempts[1]).toEqual(attempts[0]);
  const recorded = await db.payment.findMany({ where: { orderId: f.order.id } });
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({ id: savedPaymentId, status: "approved", amountCents: 3_000_000, tipCents: 272_727 });
  expect(await db.simpleInvoice.count({ where: { orderId: f.order.id } })).toBe(0);
});

test("fractional cash explicitly displays its rounding tip and leaves an exact terminal remainder", async ({ page }, info) => {
  const f = await fixture(page);
  await chooseMixed(page);
  await page.getByRole("button", { name: "Sin propina", exact: true }).click();
  await page.getByLabel("Importe de este pago", { exact: true }).fill("30000,50");
  await page.getByRole("button", { name: /^Recibir en efectivo ·/ }).click();
  await expect(page.getByLabel("Recibido del cliente", { exact: true })).toHaveValue("30.001");
  await expect(page.getByText(/^Propina por vuelto:/)).toContainText("0,50");
  await expect(page.getByText("Sin propina por vuelto.", { exact: true })).toHaveCount(0);
  const confirming = page.getByRole("button", { name: "Confirmar cobro · $30.001", exact: true });
  await expect(confirming).toBeEnabled();
  await page.screenshot({ path: info.outputPath("fractional-cash-rounding-disclosed.png"), fullPage: true });
  const recording = page.waitForResponse(response => response.url().endsWith("/pay") && response.request().method() === "POST");
  await confirming.click();
  const recorded = await recording;
  expect(recorded.ok()).toBe(true);
  expect(await recorded.json()).toMatchObject({ paid: false });
  await expect(page.getByLabel("Importe de este pago", { exact: true })).toHaveValue("69.999,5");
  const first = await db.payment.findFirstOrThrow({ where: { orderId: f.order.id, method: "cash", status: "approved" } });
  expect(first).toMatchObject({ amountCents: 3_000_100, tipCents: 50, cashTenderCents: 3_000_100 });
  const requesting = page.waitForResponse(response => response.url().endsWith("/pay/external-terminal-request") && response.request().method() === "POST");
  await page.getByRole("button", { name: /^Cobrar con datáfono del comercio ·/ }).click();
  expect((await requesting).ok()).toBe(true);
  const confirmExternal = page.getByRole("button", { name: "Confirmar pago recibido", exact: true });
  await expect(confirmExternal).toBeVisible();
  await expect(confirmExternal.locator("..").getByText(/^\$\s*69\.999,50$/)).toBeVisible();
  await expect(confirmExternal.locator("..")).not.toContainText("70.000");
  const last = await db.payment.findFirstOrThrow({ where: { orderId: f.order.id, status: "pending" } });
  expect(last).toMatchObject({ amountCents: 6_999_950, tipCents: 0, method: "external_terminal" });
  const settling = page.waitForResponse(response => response.url().includes("/settle-external-terminal") && response.request().method() === "POST");
  await confirmExternal.click();
  expect((await settling).ok()).toBe(true);
  await expect(page).toHaveURL(/\/done(?:\?|$)/);
  const order = await db.order.findUniqueOrThrow({ where: { id: f.order.id }, include: { simpleInvoice: true } });
  expect(order).toMatchObject({ status: "paid", totalCents: 10_000_050, tipCents: 50 });
  expect(order.simpleInvoice?.totalCents).toBe(10_000_050);
});

test("a lost external confirmation refreshes the approved partial without collecting it twice", async ({ page }) => {
  const f = await fixture(page);
  await chooseMixed(page);
  await page.getByLabel("Importe de este pago", { exact: true }).fill("40000");
  const requesting = page.waitForResponse(response => response.url().endsWith("/pay/external-terminal-request") && response.request().method() === "POST");
  await page.getByRole("button", { name: /^Cobrar con datáfono del comercio ·/ }).click();
  expect((await requesting).ok()).toBe(true);
  const pending = await db.payment.findFirstOrThrow({ where: { orderId: f.order.id, status: "pending" } });
  let attempts = 0;
  await page.route(`${application.origin}/api/operator/payments/${pending.id}/settle-external-terminal`, async route => {
    attempts += 1;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    expect(await response.json()).toMatchObject({ paid: false });
    // Simulate loss after the real local server approved this exact request.
    await route.abort("failed");
  });
  const confirm = page.getByRole("button", { name: "Confirmar pago recibido", exact: true });
  await confirm.click();
  await expect.poll(async () => (await db.payment.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("approved");
  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Pagos de la cuenta", exact: true })).toContainText("Datáfono del comercio");
  const remaining = page.getByRole("button", { name: "Cobrar saldo restante", exact: true });
  await expect(remaining).toBeEnabled();
  await remaining.click();
  await expect(page.getByLabel("Importe de este pago", { exact: true })).toHaveValue("70.000");
  expect(attempts).toBe(1);
  expect(await db.payment.count({ where: { orderId: f.order.id } })).toBe(1);
  expect(await db.simpleInvoice.count({ where: { orderId: f.order.id } })).toBe(0);
  expect((await cash(page, "70000")).paid).toBe(true);
  await expect(page).toHaveURL(/\/done(?:\?|$)/);
  const payments = await db.payment.findMany({ where: { orderId: f.order.id } });
  expect(payments).toHaveLength(2);
  expect(payments.filter(payment => payment.method === "external_terminal")).toHaveLength(1);
  expect(payments.every(payment => payment.status === "approved")).toBe(true);
  expect(payments.reduce((sum, payment) => sum + payment.amountCents, 0)).toBe(11_000_000);
  expect(payments.reduce((sum, payment) => sum + payment.tipCents, 0)).toBe(1_000_000);
  expect(await db.simpleInvoice.count({ where: { orderId: f.order.id } })).toBe(1);
});

test("a lost Smart POS request reveals the in-flight reservation and blocks another collection", async ({ page }) => {
  const f = await fixture(page);
  await db.restaurant.update({ where: { id: f.restaurant.id }, data: {
    enabledPaymentMethods: ["cash", "external_terminal", "kushki_card_terminal"],
    kushkiMerchantId: `isolated-fixture-${f.restaurant.id}`, kushkiOnboardingStatus: "active", kushkiMode: "mock",
  } });
  await page.reload();
  await chooseMixed(page);
  await page.getByLabel("Importe de este pago", { exact: true }).fill("40000");
  let attempts = 0;
  let pushes = 0;
  await page.route(`${application.origin}/api/tenant/${f.restaurant.slug}/terminal/charge`, async route => {
    pushes += 1;
    await route.abort("blockedbyclient");
  });
  await page.route(`${application.origin}/api/tenant/${f.restaurant.slug}/pay/terminal-request`, async route => {
    attempts += 1;
    // This endpoint only creates a local pending row. There is no assigned
    // POS device, credential or provider call anywhere in this fixture.
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    expect(await response.json()).toMatchObject({ pending: true });
    await route.abort("failed");
  });
  await page.getByRole("button", { name: /^Cobrar con datáfono ·/ }).click();
  await expect(page.getByText("Pago en línea en curso", { exact: true })).toBeVisible();
  await expect(page.getByText("Datáfono Kushki", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Recibir en efectivo ·/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: /^Cobrar con datáfono del comercio ·/ })).toBeDisabled();
  await expect(page.getByLabel("Importe de este pago", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Confirmar pago recibido", exact: true })).toHaveCount(0);
  const payments = await db.payment.findMany({ where: { orderId: f.order.id } });
  expect(payments).toHaveLength(1);
  expect(payments[0]).toMatchObject({ method: "kushki_card_terminal", status: "pending", amountCents: 4_000_000, tipCents: 363_636 });
  expect(attempts).toBe(1);
  expect(pushes).toBe(0);
  expect(await db.simpleInvoice.count({ where: { orderId: f.order.id } })).toBe(0);
});

test("the diner checkout does not expose staff mixed collection controls", async ({ page }) => {
  const f = await fixture(page);
  await page.context().clearCookies();
  await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: "es", domain: application.hostname, path: "/" }]);
  const granted = await page.request.get(`/api/tenant/${f.restaurant.slug}/guest?table=${f.table.qrToken}`, { maxRedirects: 0 });
  expect(granted.status()).toBe(307);
  const grantCookie = granted.headersArray().find(header => header.name.toLowerCase() === "set-cookie" && header.value.startsWith("mesapay_guest_"));
  expect(grantCookie).toBeDefined();
  const pair = grantCookie!.value.split(";", 1)[0];
  const separator = pair.indexOf("=");
  // Retain the real server-signed guest scope. This test server uses HTTP;
  // WebKit correctly refuses its production Secure cookie on localhost.
  // Only the isolated browser fixture drops that transport-only flag.
  await page.context().addCookies([{
    name: pair.slice(0, separator), value: pair.slice(separator + 1),
    domain: application.hostname, path: "/", httpOnly: true, secure: false, sameSite: "Lax",
  }]);
  await page.goto(`/t/${f.restaurant.slug}/pay/${f.order.id}`);
  await expect(page.getByRole("button", { name: /^Todo/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Combinar medios/ })).toHaveCount(0);
  await expect(page.getByLabel("Importe de este pago", { exact: true })).toHaveCount(0);
  expect(await db.payment.count({ where: { orderId: f.order.id } })).toBe(0);
});
