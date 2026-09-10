import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import bcrypt from "bcryptjs";

const url = new URL(
  process.env.DATABASE_URL ?? "postgresql://localhost/invalid",
);
const local =
  ["localhost", "127.0.0.1"].includes(url.hostname) &&
  /^\/mesapay_.*validation$/.test(url.pathname) &&
  /^http:\/\/(localhost|127\.0\.0\.1):/.test(
    process.env.PLAYWRIGHT_BASE_URL ?? "",
  );
test.skip(!local, "Requires isolated local application and database");
const db = new PrismaClient();

for (const width of [390, 1440]) {
  test(`welcome activation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    const slug = `welcome-ui-${randomUUID().slice(0, 8)}`;
    const email = `${slug}@example.test`;
    const adminEmail = `admin-${email}`;
    const adminPassword = `Admin-${randomUUID()}`;
    const admin = await db.user.create({
      data: {
        email: adminEmail,
        role: "platform_admin",
        passwordHash: await bcrypt.hash(adminPassword, 10),
      },
    });
    let restaurantId: string | undefined;
    try {
      await page.goto("/signin");
      await page.getByLabel("Correo", { exact: true }).fill(adminEmail);
      await page.getByLabel("Contraseña", { exact: true }).fill(adminPassword);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL((u) => !u.pathname.startsWith("/signin"));
      await page.goto("/admin/restaurants/new");
      await expect(page.locator('input[name="ownerPassword"]')).toHaveCount(0);
      await page
        .locator('input[name="restaurantName"]')
        .fill("Fixture bienvenida");
      await page.locator('input[name="restaurantSlug"]').fill(slug);
      await page.locator('input[name="ownerName"]').fill("Fixture Owner");
      await page.locator('input[name="ownerEmail"]').fill(email);
      await page.locator('select[name="country"]').selectOption("CO");
      await page.locator('form button[type="submit"]').last().click();
      await page.waitForURL(
        (u) =>
          u.pathname === "/admin/restaurants" &&
          u.searchParams.get("ok") === slug,
      );
      await expect(page.getByText(/el correo quedó pendiente/)).toBeVisible();
      const user = await db.user.findUniqueOrThrow({ where: { email } });
      restaurantId = user.restaurantId!;
      expect(user.passwordHash).toBe("!pending-restaurant-welcome");
      // La entrega de correo se simula. Se introduce un enlace de prueba conocido
      // en la misma tabla para recorrer su página pública y canje real.
      const token = randomBytes(32).toString("hex");
      await db.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
      await page.context().clearCookies();
      await page.goto(`/restablecer/${token}`);
      await expect(
        page.getByRole("heading", { name: "Crea tu contraseña" }),
      ).toBeVisible();
      await page
        .getByLabel("Nueva contraseña", { exact: true })
        .fill("FixtureWelcome123");
      await page
        .getByLabel("Confirmar contraseña", { exact: true })
        .fill("MismatchPassword");
      await page
        .getByRole("button", { name: "Guardar contraseña", exact: true })
        .click();
      await expect(
        page.getByText("Las contraseñas no coinciden.", { exact: true }),
      ).toBeVisible();
      await page
        .getByLabel("Confirmar contraseña", { exact: true })
        .fill("FixtureWelcome123");
      await page
        .getByRole("button", { name: "Guardar contraseña", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "¡Tu cuenta está lista!" }),
      ).toBeVisible();
      expect(
        await bcrypt.compare(
          "FixtureWelcome123",
          (await db.user.findUniqueOrThrow({ where: { email } })).passwordHash,
        ),
      ).toBe(true);
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "Enlace inválido o vencido" }),
      ).toBeVisible();
    } finally {
      if (!restaurantId)
        restaurantId = (await db.restaurant.findUnique({ where: { slug } }))
          ?.id;
      if (restaurantId)
        await db.restaurant.delete({ where: { id: restaurantId } });
      await db.user.delete({ where: { id: admin.id } });
    }
  });
}

test("public registration shows welcome delivery and resend without automatic login", async ({
  page,
}) => {
  await page.route("**/api/countries", (r) =>
    r.fulfill({ json: { countries: [{ code: "CO" }] } }),
  );
  await page.route("**/api/auth/register-restaurant", (r) => {
    expect(r.request().postDataJSON()).not.toHaveProperty("password");
    return r.fulfill({ json: { ok: true, emailSent: true } });
  });
  await page.goto("/signup/restaurant");
  await page.getByPlaceholder("La Cocina de Mamá").fill("Fixture public");
  await page.locator('form > input[type="text"]').last().fill("Fixture Owner");
  await page.locator('input[type="email"]').fill("fixture@example.test");
  await page
    .getByRole("combobox", { name: "País", exact: true })
    .selectOption("CO");
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page
    .getByRole("button", { name: "Crear restaurante", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Tu restaurante está creado" }),
  ).toBeVisible();
  await expect(
    page.getByText(/Enviamos un correo de bienvenida a fixture@example.test/),
  ).toBeVisible();
  await page.route("**/api/auth/resend-restaurant-welcome", (r) =>
    r.fulfill({ json: { ok: true } }),
  );
  await page
    .getByRole("button", { name: "Reenviar bienvenida", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "pendiente de activación",
  );
});

test.afterAll(async () => {
  await db.$disconnect();
});
