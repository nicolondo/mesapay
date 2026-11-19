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

async function fixture(page: Page, options: { role?: Role } = {}) {
  const token = randomUUID();
  const password = `Serial-split-${token}`;
  const role = options.role ?? "operator";
  const restaurant = await db.restaurant.create({ data: {
    name: "Restaurante de cobros en serie", slug: `serial-${token}`,
    country: "CO", serviceMode: "table", enabledModules: [],
    enabledPaymentMethods: ["cash", "external_terminal"], salesTaxKind: "none",
    kitchenAutoFire: false, kitchenPrintEnabled: false, barPrintEnabled: false,
    invoiceAutoPrint: false, shiftPolicy: "global",
  } });
  tenants.push(restaurant.id);
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
    ? `/mesero/cobrar/${order.id}` : `/t/${restaurant.slug}/pay/${order.id}?op=1`;
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
