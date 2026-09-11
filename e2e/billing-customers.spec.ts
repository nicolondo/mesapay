import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(
  !["127.0.0.1", "localhost"].includes(databaseUrl.hostname) ||
    !/^\/mesapay_.*validation$/.test(databaseUrl.pathname) ||
    !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""),
  "Isolated local app and validation database required",
);
const db = new PrismaClient();

async function login(page: Page, email: string, password: string) {
  await page.goto("/signin");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"));
}

async function selectRestaurant(page: Page, restaurantId: string) {
  await page.context().addCookies([
    { name: "mesapay_act_as", value: restaurantId, domain: "localhost", path: "/" },
  ]);
}

async function fillCustomer(page: Page, name: string, docType: "CC" | "NIT", doc: string) {
  await page.getByLabel("Nombre o razón social", { exact: true }).fill(name);
  await page.getByLabel("Tipo de documento", { exact: true }).selectOption(docType);
  await page.getByLabel("Número de documento", { exact: true }).fill(doc);
  await page.getByLabel("Correo electrónico", { exact: true }).fill("facturas@example.test");
  await page.getByLabel("Teléfono", { exact: true }).fill("3005550101");
  await page.getByLabel("Dirección", { exact: true }).fill("Calle 10 # 20-30");
  await page.getByLabel("Municipio", { exact: true }).fill("Medell");
  await page.getByRole("option", { name: /Medellín, Antioquia/ }).click();
  await expect(page.getByLabel("Departamento", { exact: true })).toHaveValue("Antioquia");
}

for (const width of [390, 1440]) {
  test(`billing clients persist, edit and prefill an unpaid invoice at ${width}px`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 1100 });
    // No third-party scripts or requests are necessary to exercise this flow.
    await page.route(/^https?:\/\//, (route) => {
      const host = new URL(route.request().url()).hostname;
      return ["localhost", "127.0.0.1"].includes(host) ? route.continue() : route.abort();
    });
    const token = randomUUID();
    const email = `billing-${token}@example.test`, password = `Fixture-${token}`;
    const restaurant = await db.restaurant.create({ data: { name: "Clientes de prueba", slug: `billing-${token}` } });
    const user = await db.user.create({ data: { email, passwordHash: await bcrypt.hash(password, 10), role: "platform_admin" } });
    try {
      await login(page, email, password);
      await selectRestaurant(page, restaurant.id);
      await page.goto("/operator/clientes");
      await expect(page.getByRole("heading", { name: "Clientes para facturación", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Crear cliente", exact: true }).click();
      await fillCustomer(page, "Cliente particular de prueba", "CC", "1020304050");
      await page.getByRole("button", { name: "Guardar cliente", exact: true }).click();
      await expect.poll(() => db.billingCustomer.count({ where: { restaurantId: restaurant.id } })).toBe(1);
      const cc = await db.billingCustomer.findFirstOrThrow({ where: { restaurantId: restaurant.id, docType: "CC" } });
      expect(cc).toMatchObject({ docNumber: "1020304050", verificationDigit: null, municipalityCode: "05001", city: "Medellín", department: "Antioquia", address: "Calle 10 # 20-30" });

      await page.reload();
      await page.getByRole("button", { name: "Crear cliente", exact: true }).click();
      await fillCustomer(page, "Empresa de prueba SAS", "NIT", "901944469");
      await page.screenshot({ path: `/Users/nicolas/Documents/Codex/2026-09-08/files-mentioned-by-the-user-scr/UI-UX-MESAPAY/cliente-formulario-${width}.png`, fullPage: true });
      await page.getByRole("button", { name: "Guardar cliente", exact: true }).click();
      await expect.poll(() => db.billingCustomer.count({ where: { restaurantId: restaurant.id } })).toBe(2);
      const nit = await db.billingCustomer.findFirstOrThrow({ where: { restaurantId: restaurant.id, docType: "NIT" } });
      expect(nit).toMatchObject({ docNumber: "901944469", verificationDigit: "1", country: "CO" });

      await page.reload();
      await page.getByLabel("Buscar clientes para facturación", { exact: true }).fill("901944469");
      const edit = page.getByRole("button", { name: "Editar Empresa de prueba SAS", exact: true });
      await expect(edit).toBeVisible();
      await expect(page.getByRole("button", { name: "Editar Cliente particular de prueba", exact: true })).toHaveCount(0);
      await edit.click();
      await expect(page.getByLabel("Municipio", { exact: true })).toHaveValue(/Medellín/);
      await expect(page.getByLabel("Dígito de verificación", { exact: true })).toHaveValue("1");
      await page.getByLabel("Dirección", { exact: true }).fill("Carrera 43 # 10-20");
      await page.getByRole("button", { name: "Guardar cambios", exact: true }).click();
      await expect.poll(async () => (await db.billingCustomer.findUniqueOrThrow({ where: { id: nit.id } })).address).toBe("Carrera 43 # 10-20");
      await page.reload();
      await page.getByLabel("Buscar clientes para facturación", { exact: true }).fill("Empresa");
      await expect(edit).toBeVisible();
      await page.screenshot({ path: `/Users/nicolas/Documents/Codex/2026-09-08/files-mentioned-by-the-user-scr/UI-UX-MESAPAY/clientes-facturacion-${width}.png`, fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      const duplicate = await page.request.post("/api/operator/billing-customers", {
        data: { customerName: "Empresa duplicada", docType: "NIT", docNumber: "901.944.469-1", email: "otra@example.test", address: "Calle 10 # 20-30", municipalityCode: "05001" },
      });
      expect(duplicate.status()).toBe(409);
      expect(await db.billingCustomer.count({ where: { restaurantId: restaurant.id } })).toBe(2);

      for (const [locale, heading] of [["en", "Billing customers"], ["pt", "Clientes para faturamento"]]) {
        await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: locale, domain: "localhost", path: "/" }]);
        await page.reload();
        await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      }
      await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: "es", domain: "localhost", path: "/" }]);

      const table = await db.table.create({ data: { restaurantId: restaurant.id, number: 1, qrToken: randomUUID() } });
      const order = await db.order.create({ data: {
        restaurantId: restaurant.id, tableId: table.id, shortCode: randomUUID(), status: "placed", subtotalCents: 1000000, totalCents: 1000000,
        items: { create: { nameSnapshot: "Plato de prueba", priceCentsSnapshot: 1000000, qty: 1 } },
      } });
      await page.goto(`/t/${restaurant.slug}/pay/${order.id}?op=1`);
      await page.getByRole("button", { name: "Factura electrónica personalizada", exact: true }).click();
      await page.getByLabel("Buscar cliente registrado", { exact: true }).fill("901944469");
      await page.getByRole("button", { name: "Usar Empresa de prueba SAS", exact: true }).click();
      await expect(page.getByLabel("Nombre o razón social", { exact: true })).toHaveValue("Empresa de prueba SAS");
      await expect(page.getByLabel("Tipo", { exact: true })).toHaveValue("NIT");
      await expect(page.getByLabel("Número de identificación", { exact: true })).toHaveValue("901944469-1");
      await expect(page.getByLabel("Correo electrónico")).toHaveValue("facturas@example.test");
      await expect(page.getByLabel("Dirección")).toHaveValue("Carrera 43 # 10-20");
      await expect(page.getByLabel("Ciudad", { exact: true })).toHaveValue("Medellín");
      await expect(page.getByLabel("Departamento", { exact: true })).toHaveValue("Antioquia");
      // Selection is only a draft: no fiscal emission, email, payment or print.
      expect(await db.invoiceRequest.count({ where: { orderId: order.id } })).toBe(0);
      expect(await db.payment.count({ where: { orderId: order.id } })).toBe(0);
      expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("placed");
    } finally {
      await db.restaurant.delete({ where: { id: restaurant.id } });
      await db.user.delete({ where: { id: user.id } });
    }
  });
}

test("billing clients stay scoped to their restaurant and waiters cannot create them", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const token = randomUUID(), password = `Fixture-${token}`;
  const passwordHash = await bcrypt.hash(password, 10);
  const first = await db.restaurant.create({ data: { name: "Comercio A", slug: `billing-a-${token}` } });
  const second = await db.restaurant.create({ data: { name: "Comercio B", slug: `billing-b-${token}` } });
  const admin = await db.user.create({ data: { email: `billing-admin-${token}@example.test`, passwordHash, role: "platform_admin" } });
  const waiter = await db.user.create({ data: { email: `billing-waiter-${token}@example.test`, passwordHash, role: "mesero", restaurantId: first.id } });
  const payload = { customerName: "Cliente privado comercio A", docType: "CC", docNumber: "1020304050", email: "privado@example.test", address: "Calle 10 # 20-30", municipalityCode: "05001" };
  const waiterContext = await browser.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL, locale: "es-CO" });
  try {
    await login(page, admin.email, password);
    await selectRestaurant(page, first.id);
    const created = await page.request.post("/api/operator/billing-customers", { data: payload });
    expect(created.status()).toBe(201);
    const customer = await db.billingCustomer.findFirstOrThrow({ where: { restaurantId: first.id } });
    await selectRestaurant(page, second.id);
    const search = await page.request.get("/api/operator/billing-customers?q=1020304050");
    expect(search.status()).toBe(200);
    expect(await search.text()).not.toContain(customer.id);
    await page.goto("/operator/clientes");
    await page.getByLabel("Buscar clientes para facturación", { exact: true }).fill("1020304050");
    await expect(page.getByRole("button", { name: "Editar Cliente privado comercio A", exact: true })).toHaveCount(0);
    const patch = await page.request.patch(`/api/operator/billing-customers/${customer.id}`, { data: { ...payload, customerName: "Cambio ajeno" } });
    expect(patch.status()).toBe(404);
    expect((await db.billingCustomer.findUniqueOrThrow({ where: { id: customer.id } })).customerName).toBe(payload.customerName);
    const sameIdentityOtherMerchant = await page.request.post("/api/operator/billing-customers", { data: { ...payload, customerName: "Cliente propio comercio B" } });
    expect(sameIdentityOtherMerchant.status()).toBe(201);
    const waiterPage = await waiterContext.newPage();
    await login(waiterPage, waiter.email, password);
    const forbidden = await waiterPage.request.post("/api/operator/billing-customers", { data: { ...payload, docNumber: "1020304051" } });
    expect([401, 403]).toContain(forbidden.status());
    expect(await db.billingCustomer.count({ where: { restaurantId: first.id } })).toBe(1);
  } finally {
    await waiterContext.close();
    await db.restaurant.deleteMany({ where: { id: { in: [first.id, second.id] } } });
    await db.user.delete({ where: { id: admin.id } });
  }
});

test.afterAll(() => db.$disconnect());
