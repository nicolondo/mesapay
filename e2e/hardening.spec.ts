import bcrypt from "bcryptjs";
import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

const base = new URL(
  process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3300",
);
const database = new URL(
  process.env.DATABASE_URL ?? "postgresql://localhost/invalid",
);
const local =
  ["localhost", "127.0.0.1"].includes(base.hostname) &&
  ["localhost", "127.0.0.1"].includes(database.hostname) &&
  /^\/mesapay_.*(?:test|validation)$/.test(database.pathname);
test.skip(
  !local,
  "This suite requires an explicit isolated local database and local application",
);
const db = new PrismaClient();
const slug = `e2e-${randomUUID()}`;
let restaurantId: string;
let tableId: string;
let menuItemId: string;
const qrToken = randomUUID();
const email = `${slug}@example.test`;
const password = `Fixture-${randomUUID()}`;

test.beforeAll(async () => {
  restaurantId = (
    await db.restaurant.create({
      data: {
        slug,
        name: "Restaurante de prueba",
        country: "CO",
        enabledPaymentMethods: ["cash"],
        serviceMode: "table",
      },
    })
  ).id;
  await db.user.create({
    data: {
      restaurantId,
      email,
      role: "operator",
      passwordHash: await bcrypt.hash(password, 10),
    },
  });
  tableId = (
    await db.table.create({ data: { restaurantId, number: 1, qrToken } })
  ).id;
  const category = await db.category.create({
    data: { restaurantId, slug: "pruebas", label: "Platos" },
  });
  menuItemId = (
    await db.menuItem.create({
      data: {
        restaurantId,
        categoryId: category.id,
        name: "Plato de prueba",
        priceCents: 1000000,
        available: true,
      },
    })
  ).id;
});
test.afterAll(async () => {
  if (restaurantId) {
    await db.financialOperation.deleteMany({
      where: { key: { startsWith: `${slug}:` } },
    });
    await db.restaurant.delete({ where: { id: restaurantId } });
    await db.platformEvent.deleteMany({ where: { restaurantId } });
  }
  await db.$disconnect();
});

test("QR guest can order; forged access, demo payment and closed-order edits are rejected", async ({
  page,
  request,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const payload = {
    tableId,
    items: [{ menuItemId, qty: 1 }],
    guestName: "Prueba",
  };
  const withoutQr = await request.post(`/api/tenant/${slug}/orders`, {
    data: payload,
  });
  expect(withoutQr.status()).toBe(403);
  const wrongToken = await request.get(
    `/api/tenant/${slug}/guest?table=${tableId}`,
  );
  expect(wrongToken.status()).toBe(404);

  await page.goto(`/t/${slug}/menu?table=${qrToken}`);
  await expect(
    page.getByText("Plato de prueba", { exact: true }).first(),
  ).toBeVisible();
  expect(
    (await context.cookies()).some((c) => c.name.startsWith("mesapay_guest_")),
  ).toBe(true);
  const placed = await page.request.post(`/api/tenant/${slug}/orders`, {
    data: payload,
  });
  expect(placed.status()).toBe(200);
  const { orderId } = await placed.json();
  const demo = await page.request.post(`/api/tenant/${slug}/pay`, {
    data: { orderId, method: "demo_card", amountCents: 1000000 },
  });
  expect(demo.status()).toBe(403);
  expect(await db.payment.count({ where: { orderId } })).toBe(0);

  const unauthorizedSettle = await page.request.post(
    `/api/tenant/${slug}/pay`,
    {
      data: {
        orderId,
        method: "demo_cash",
        amountCents: 1000000,
        settleNow: true,
      },
    },
  );
  expect(unauthorizedSettle.status()).toBe(403);
  await db.order.update({
    where: { id: orderId },
    data: { status: "paid", paidAt: new Date() },
  });
  const append = await page.request.post(`/api/tenant/${slug}/orders`, {
    data: { ...payload, orderId },
  });
  expect(append.status()).toBe(409);
  expect(await db.orderItem.count({ where: { orderId } })).toBe(1);
  expect(errors).toEqual([]);
});

test("operator records one verified reconciliation from the payment detail", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const order = await db.order.create({
    data: {
      restaurantId,
      tableId,
      shortCode: randomUUID(),
      subtotalCents: 1000000,
      totalCents: 1000000,
      status: "placed",
    },
  });
  const payment = await db.payment.create({
    data: {
      orderId: order.id,
      method: "kushki_card",
      status: "approved",
      amountCents: 1000000,
      refundReservedCents: 500000,
      reconciliationRequired: true,
    },
  });
  await db.financialOperation.create({
    data: {
      key: `${slug}:refund`,
      paymentId: payment.id,
      kind: "refund",
      amountCents: 500000,
      status: "uncertain",
    },
  });
  await db.order.update({
    where: { id: order.id },
    data: { status: "paid", paidAt: new Date() },
  });
  await page.goto("/signin");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"));
  await page.goto(`/operator/orders/${order.id}`);
  await page
    .getByRole("button", { name: "Conciliar pago", exact: true })
    .click();
  const save = page.getByRole("button", {
    name: "Guardar conciliación",
    exact: true,
  });
  await expect(save).toBeDisabled();
  await page
    .getByLabel("Referencia o caso de soporte")
    .fill("fixture-refund-reference");
  await page
    .getByLabel("Evidencia de la verificación")
    .fill(
      "Confirmed with the isolated payment fixture; no real payment involved.",
    );
  await page
    .getByLabel("Verifiqué el estado definitivo y el importe con el proveedor.")
    .check();
  if (testInfo.project.name === "mobile")
    await page.screenshot({
      path: testInfo.outputPath("reconcile-mobile.png"),
      fullPage: true,
    });
  await save.click();
  await expect(
    page.getByRole("button", { name: "Conciliar pago", exact: true }),
  ).toHaveCount(0);
  const settled = await db.payment.findUniqueOrThrow({
    where: { id: payment.id },
  });
  expect(settled.refundedCents).toBe(500000);
  expect(settled.refundReservedCents).toBe(0);
  expect(
    await db.auditEvent.count({
      where: { targetId: payment.id, kind: "payment.reconciled" },
    }),
  ).toBe(1);
  expect(errors).toEqual([]);
});

async function signInOperator(page: import("@playwright/test").Page) {
  await page.goto("/signin");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"));
}

async function expectNoOverflow(page: import("@playwright/test").Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const main = page.locator("#operator-content");
  if (await main.count())
    expect(
      await main.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
}

test("workspace chart, section search and mobile drawer work with keyboard navigation", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await db.order.create({
    data: {
      restaurantId,
      tableId,
      shortCode: randomUUID(),
      status: "paid",
      subtotalCents: 1200000,
      totalCents: 1200000,
      paidAt: new Date(),
    },
  });
  await signInOperator(page);
  await expect(
    page.getByRole("heading", { name: "Tu servicio, de un vistazo" }),
  ).toBeVisible();
  expect(
    await page
      .locator(".mp-sales-bar")
      .evaluateAll((nodes) =>
        nodes.some((n) => n.getBoundingClientRect().height > 30),
      ),
  ).toBe(true);
  await expectNoOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("workspace.png") });
  await page
    .getByRole("button", { name: "Ir a una sección", exact: true })
    .focus();
  await page.keyboard.press("Control+k");
  const search = page.getByRole("dialog", { name: "Ir a una sección" });
  await expect(search).toBeVisible();
  await search.getByRole("searchbox").fill("configuracion");
  await search.getByRole("link", { name: /Configuración/ }).click();
  await expect(page).toHaveURL(/\/operator\/settings$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("searchbox", { name: "Buscar en configuración" })
    .fill("facturacion");
  await expect(page.locator(".mp-setting-row")).toHaveCount(1);
  await expect(page.locator(".mp-setting-row")).toContainText("Resolución");
  await page
    .getByRole("searchbox", { name: "Buscar en configuración" })
    .fill("sin-coincidencia-123");
  await page
    .getByRole("button", { name: "Limpiar búsqueda", exact: true })
    .click();
  expect(await page.locator(".mp-setting-row").count()).toBeGreaterThan(5);
  await expectNoOverflow(page);
  if (testInfo.project.name === "mobile") {
    const trigger = page.getByRole("button", {
      name: "Abrir menú",
      exact: true,
    });
    await trigger.click();
    const drawer = page.getByRole("dialog", { name: "Abrir menú" });
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    expect(
      await drawer.evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
  expect(errors).toEqual([]);
});

test("payments can be paginated, filtered and opened for review", async ({
  page,
}) => {
  const shortCode = "SEARCH-" + randomUUID().slice(0, 8);
  const paymentsTable = await db.table.create({
    data: { restaurantId, number: 77, qrToken: randomUUID() },
  });
  const order = await db.order.create({
    data: {
      restaurantId,
      tableId: paymentsTable.id,
      shortCode,
      status: "placed",
      subtotalCents: 1000000,
      totalCents: 1000000,
    },
  });
  await db.payment.createMany({
    data: Array.from({ length: 53 }, () => ({
      orderId: order.id,
      method: "kushki_card" as const,
      status: "declined" as const,
      amountCents: 10000,
    })),
  });
  await db.payment.create({
    data: {
      orderId: order.id,
      method: "kushki_card",
      status: "pending",
      amountCents: 10000,
      reconciliationRequired: true,
    },
  });
  await signInOperator(page);
  await page.goto(`/operator/payments?q=${shortCode}`);
  await expect(
    page.getByRole("link", { name: shortCode, exact: true }),
  ).toHaveCount(50);
  await page.getByRole("link", { name: "Siguiente", exact: true }).click();
  await expect(
    page.getByRole("link", { name: shortCode, exact: true }),
  ).toHaveCount(4);
  await expectNoOverflow(page);
  await page
    .getByRole("combobox", { name: "Estado", exact: true })
    .selectOption("review");
  await page.getByRole("button", { name: "Filtrar", exact: true }).click();
  await expect(
    page.getByRole("link", { name: shortCode, exact: true }),
  ).toHaveCount(1);
  await page.getByRole("link", { name: /Requiere revisión/ }).click();
  await expect(page).toHaveURL(new RegExp(`/operator/orders/${order.id}$`));
});

test("diner can browse first, then supply a name before sending the cart", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/t/${slug}/menu?table=${qrToken}`);
  await expect(
    page.getByText("Plato de prueba", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Añadir al pedido", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: /Ver pedido/ }).click();
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "¿Cómo te llamamos?" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Guardar", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("Tu nombre o apodo").fill("Cliente de prueba");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page
    .getByRole("button", { name: "Enviar a cocina", exact: true })
    .click();
  await expect
    .poll(() =>
      db.orderItem.count({
        where: { order: { restaurantId }, guestName: "Cliente de prueba" },
      }),
    )
    .toBe(1);
  await expectNoOverflow(page);
  expect(errors).toEqual([]);
});

test("sign-in keeps password visibility accessible and recovers after a connection error", async ({
  page,
}) => {
  await page.goto("/signin");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  const passwordField = page.getByLabel("Contraseña", { exact: true });
  await passwordField.fill(password);
  await page
    .getByRole("button", { name: "Mostrar contraseña", exact: true })
    .click();
  await expect(passwordField).toHaveAttribute("type", "text");
  await page
    .getByRole("button", { name: "Ocultar contraseña", exact: true })
    .click();
  await expect(passwordField).toHaveAttribute("type", "password");
  await page.route("**/api/auth/callback/credentials", (route) =>
    route.abort("failed"),
  );
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Ingresar", exact: true }),
  ).toBeEnabled();
  await expectNoOverflow(page);
});

test("revoked print devices can be removed while preserving printing history", async ({
  page,
}) => {
  const agent = await db.printAgent.create({
    data: {
      restaurantId,
      label: "PC retirado",
      tokenHash: randomUUID(),
      revokedAt: new Date(),
    },
  });
  const active = await db.printAgent.create({
    data: { restaurantId, label: "PC activo", tokenHash: randomUUID() },
  });
  const printer = await db.printer.create({
    data: {
      restaurantId,
      agentId: agent.id,
      label: "Cocina histórica",
      host: "127.0.0.1",
      port: 9100,
      station: "kitchen",
      active: false,
    },
  });
  const job = await db.printJob.create({
    data: {
      restaurantId,
      printerId: printer.id,
      payload: { test: true },
      status: "printed",
    },
  });
  await page.goto("/signin");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"));
  await page.goto("/operator/settings/impresoras");
  await expect(
    page.getByRole("button", { name: "Eliminar equipo", exact: true }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "Eliminar equipo", exact: true })
    .click();
  await expect(
    page.getByText("¿Eliminar «PC retirado»?", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancelar", exact: true }).click();
  expect(
    (await db.printAgent.findUniqueOrThrow({ where: { id: agent.id } }))
      .deletedAt,
  ).toBeNull();
  await page
    .getByRole("button", { name: "Eliminar equipo", exact: true })
    .click();
  const endpoint = `/api/operator/print-agents/${agent.id}`;
  await page.route(`**${endpoint}`, (route) => route.abort());
  await page
    .getByRole("button", { name: "Sí, eliminar equipo", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "No se pudo eliminar" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sí, eliminar equipo", exact: true }),
  ).toBeEnabled();
  await page.unroute(`**${endpoint}`);
  await page
    .getByRole("button", { name: "Sí, eliminar equipo", exact: true })
    .click();
  await expect(page.getByText("PC retirado", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("PC retirado", { exact: true })).toHaveCount(0);
  await expect(page.getByText("PC activo", { exact: true })).toBeVisible();
  expect(
    (await db.printAgent.findUniqueOrThrow({ where: { id: agent.id } }))
      .deletedAt,
  ).not.toBeNull();
  expect(await db.printJob.count({ where: { id: job.id } })).toBe(1);
  expect(await db.printer.count({ where: { id: printer.id } })).toBe(1);
  expect((await page.request.delete(endpoint)).status()).toBe(200);
  expect(
    (
      await page.request.delete(`/api/operator/print-agents/${active.id}`)
    ).status(),
  ).toBe(409);
});

test("onboarding separates a valid NIT DV and reports undelivered documents honestly", async ({
  page,
}) => {
  await db.restaurant.update({
    where: { id: restaurantId },
    data: {
      legalName: "SON Y MELONA S.A.S.",
      taxId: "901944469-1",
      kushkiOnboardingStatus: "in_review",
      kushkiOnboardingNotes: "SFTP: 0/2 docs + manifiesto falló",
      bankInfo: {
        bankName: "Banco de prueba",
        accountType: "ahorros",
        accountNumber: "123456789",
        holderName: "SON Y MELONA S.A.S",
        holderDocType: "NIT",
        holderDocNumber: "901944469",
      },
    },
  });
  await db.kushkiDocument.createMany({
    data: [
      {
        restaurantId,
        kind: "rut",
        fileName: "test-rut.pdf",
        fileUrl: "/uploads/onboarding/test-rut.pdf",
        mimeType: "application/pdf",
        fileSize: 1,
      },
      {
        restaurantId,
        kind: "bank_cert",
        fileName: "test-bank.pdf",
        fileUrl: "/uploads/onboarding/test-bank.pdf",
        mimeType: "application/pdf",
        fileSize: 1,
      },
    ],
  });
  await page.goto("/signin");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"));
  await page.goto("/operator/settings/pagos");
  await expect(
    page.getByText(
      "El documento del titular de la cuenta coincide con el RUT.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("El titular de la cuenta no coincide con el RUT", {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Entrega pendiente a Kushki", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Documentos entregados: 0 de 2/)).toBeVisible();
  await expectNoOverflow(page);
  await db.restaurant.update({
    where: { id: restaurantId },
    data: { taxId: "901944469-2" },
  });
  await page.reload();
  await expect(
    page.getByText("El titular de la cuenta no coincide con el RUT", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "El documento del titular de la cuenta coincide con el RUT.",
      { exact: true },
    ),
  ).toHaveCount(0);
});
