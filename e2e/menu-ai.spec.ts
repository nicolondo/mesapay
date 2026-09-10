import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";

const url = new URL(
  process.env.DATABASE_URL ?? "postgresql://localhost/invalid",
);
test.skip(
  !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/^\/mesapay_.*validation$/.test(url.pathname) ||
    !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""),
  "Isolated local app required",
);
const db = new PrismaClient();
for (const width of [390, 1440]) {
  test(`shared AI settings and dish preview at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1100 });
    const id = randomUUID();
    const email = `menu-ai-${id}@example.test`;
    const password = `Fixture-${id}`;
    const previous = await db.platformConfig.findUnique({
      where: { id: "singleton" },
    });
    const restaurant = await db.restaurant.create({
      data: { name: "Fixture IA", slug: `ai-${id}` },
    });
    const user = await db.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(password, 10),
        role: "platform_admin",
      },
    });
    const category = await db.category.create({
      data: {
        restaurantId: restaurant.id,
        label: "Entradas",
        slug: "entradas",
      },
    });
    const dish = await db.menuItem.create({
      data: {
        restaurantId: restaurant.id,
        categoryId: category.id,
        name: "Sopa de tomate",
        description: "Tomate y albahaca",
        priceCents: 1800000,
        tags: [],
      },
    });
    try {
      await page.goto("/signin");
      await page.getByLabel("Correo", { exact: true }).fill(email);
      await page.getByLabel("Contraseña", { exact: true }).fill(password);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL((u) => !u.pathname.startsWith("/signin"));
      await page.goto("/admin/configuracion");
      const key = page.getByLabel("Llave API de Anthropic", { exact: true });
      await key.fill("sk-ant-local-fixture-never-use");
      await page
        .getByRole("button", { name: "Guardar configuración", exact: true })
        .click();
      await expect(
        page.getByText(
          "Configuración guardada. Se aplicará en la próxima generación.",
        ),
      ).toBeVisible();
      await expect(key).toHaveValue("");
      const cfg = await db.platformConfig.findUniqueOrThrow({
        where: { id: "singleton" },
      });
      expect(cfg.menuAiKeyEnc).not.toContain("sk-ant-local-fixture");
      await page.screenshot({
        path: `/Users/nicolas/Documents/Codex/2026-09-08/files-mentioned-by-the-user-scr/UI-UX-MESAPAY/ia-admin-${width}.png`,
        fullPage: true,
      });
      await page
        .getByLabel("Permitir generación en todos los comercios")
        .uncheck();
      await page
        .getByRole("button", { name: "Guardar configuración", exact: true })
        .click();
      await expect(
        page.getByText(
          "Configuración guardada. Se aplicará en la próxima generación.",
        ),
      ).toBeVisible();
      await page
        .context()
        .addCookies([
          {
            name: "mesapay_act_as",
            value: restaurant.id,
            domain: "localhost",
            path: "/",
          },
        ]);
      const disabled = await page.request.post(
        "/api/operator/menu-items/describe",
        { data: { name: dish.name, categoryId: category.id } },
      );
      expect(disabled.status()).toBe(503);
      expect(await disabled.json()).toMatchObject({ error: "ai_disabled" });
      await page.goto("/operator/menu");
      await page.getByText("Sopa de tomate", { exact: true }).first().click();
      const generate = page.getByRole("button", {
        name: "Generar descripción con IA",
        exact: true,
      });
      await generate.click();
      await expect(page.getByRole("alert").filter({ hasText: "La generación con IA" })).toHaveText(
        "La generación con IA está desactivada por el administrador general.",
      );
      await page.route("**/api/operator/menu-items/describe", async (route) => {
        expect(route.request().postDataJSON()).toMatchObject({
          name: dish.name,
          categoryId: category.id,
          description: "Tomate y albahaca",
        });
        await route.fulfill({
          json: {
            description:
              "Una suave sopa de tomate con el aroma fresco de la albahaca",
          },
        });
      });
      await generate.click();
      const proposal = page.getByLabel("Descripción sugerida", { exact: true });
      await expect(proposal).toBeVisible();
      expect(
        (await db.menuItem.findUniqueOrThrow({ where: { id: dish.id } }))
          .description,
      ).toBe("Tomate y albahaca");
      await proposal.fill("");
      await expect(proposal).toBeVisible();
      await expect(page.getByRole("button", { name: "Usar descripción", exact: true })).toBeDisabled();
      await proposal.fill("Sopa suave de tomate y albahaca fresca");
      await page.screenshot({
        path: `/Users/nicolas/Documents/Codex/2026-09-08/files-mentioned-by-the-user-scr/UI-UX-MESAPAY/ia-plato-${width}.png`,
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "Usar descripción", exact: true })
        .click();
      await expect(proposal).toHaveCount(0);
      await expect(page.locator("textarea").first()).toHaveValue(
        "Sopa suave de tomate y albahaca fresca",
      );
      expect(
        (await db.menuItem.findUniqueOrThrow({ where: { id: dish.id } }))
          .description,
      ).toBe("Tomate y albahaca");
      await page.getByRole("button", { name: "Guardar", exact: true }).click();
      await expect.poll(async () => (await db.menuItem.findUniqueOrThrow({ where: { id: dish.id } })).description).toBe("Sopa suave de tomate y albahaca fresca");
      await page.getByRole("button", { name: "+ Producto", exact: true }).click();
      await expect(generate).toBeDisabled();
      await page.getByRole("textbox", { name: "Nombre", exact: true }).fill(dish.name);
      await page.locator("textarea").first().fill("Tomate y albahaca");
      await generate.click();
      await expect(proposal).toBeVisible();
      await page.getByRole("button", { name: "Descartar", exact: true }).click();
      await expect(proposal).toHaveCount(0);
      await expect(page.locator("textarea").first()).toHaveValue("Tomate y albahaca");
    } finally {
      await db.restaurant.delete({ where: { id: restaurant.id } });
      await db.user.delete({ where: { id: user.id } });
      await db.platformConfig.upsert({
        where: { id: "singleton" },
        create: { id: "singleton", menuAiEnabled: previous?.menuAiEnabled ?? true, menuAiKeyEnc: previous?.menuAiKeyEnc ?? null },
        update: {
          menuAiKeyEnc: previous?.menuAiKeyEnc ?? null,
          menuAiEnabled: previous?.menuAiEnabled ?? true,
        },
      });
    }
  });
}
test.afterAll(() => db.$disconnect());
