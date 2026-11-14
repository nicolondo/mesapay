import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

/**
 * «Recordar mis datos» en la factura personalizada del comensal, en un
 * navegador de verdad. El dueño: «quiero que sea desplegable, no que
 * aparezca todo completo ocupando espacio, y que por defecto esté activo».
 *
 * Este spec falla si la casilla no viene marcada, si el resumen («¿Qué
 * guardamos?») no arranca cerrado, o si no abre y cierra con el mouse y con
 * el teclado (Enter / Espacio) manteniendo `aria-expanded` al día.
 *
 * Salvaguardas como operator-signout-mobile.spec.ts: sólo corre contra una
 * app local y una base de validación aislada; crea y borra sus datos.
 */
const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(
  !["localhost", "127.0.0.1"].includes(databaseUrl.hostname) ||
  !/^\/mesapay_.*validation$/.test(databaseUrl.pathname) ||
  !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""),
  "An isolated local app and validation database are required",
);
const db = new PrismaClient();
const created: string[] = [];

test.use({ viewport: { width: 390, height: 844 } });

test.afterAll(async () => {
  if (created.length) await db.restaurant.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
});

async function openOrder() {
  const token = randomUUID().slice(0, 8);
  const restaurant = await db.restaurant.create({
    data: { name: "Casa de prueba", slug: `recordar-${token}`, enabledPaymentMethods: ["cash"] },
  });
  created.push(restaurant.id);
  const table = await db.table.create({ data: { restaurantId: restaurant.id, number: 1, qrToken: `qr-${token}` } });
  const order = await db.order.create({
    data: { restaurantId: restaurant.id, tableId: table.id, shortCode: token, status: "served", subtotalCents: 2_500_000, totalCents: 2_500_000 },
  });
  await db.orderItem.create({
    data: { orderId: order.id, qty: 1, nameSnapshot: "Plato de prueba", priceCentsSnapshot: 2_500_000, kitchenStatus: "ready" },
  });
  return { slug: restaurant.slug, qrToken: table.qrToken, orderId: order.id };
}

test("la casilla viene marcada y «¿Qué guardamos?» arranca cerrado y abre/cierra con mouse y teclado", async ({ page }) => {
  const { slug, qrToken, orderId } = await openOrder();
  // Primer escaneo del QR: deja la cookie de invitado de la mesa.
  await page.goto(`/t/${slug}/menu?table=${qrToken}`);
  await page.goto(`/t/${slug}/pay/${orderId}`);
  await page.getByRole("button", { name: /Factura electrónica personalizada/ }).first().click();
  await page.getByLabel("Número de identificación").fill("7766554433");
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByLabel("Nombre o razón social")).toBeVisible();

  const remember = page.getByRole("checkbox", { name: "Recordar mis datos para mis próximas facturas en Casa de prueba" });
  await expect(remember).toBeChecked();

  const toggle = page.getByRole("button", { name: "¿Qué guardamos?" });
  const summary = page.getByText("solo verás una parte de tus datos", { exact: false });
  const policy = page.getByRole("link", { name: "Política de privacidad" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(summary).toBeHidden();
  await expect(policy).toBeHidden();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(summary).toBeVisible();
  await expect(policy).toHaveAttribute("href", "/privacidad");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(summary).toBeHidden();

  // Teclado: Enter abre, Espacio cierra.
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // Fácil de desmarcar.
  await remember.uncheck();
  await expect(remember).not.toBeChecked();
});
