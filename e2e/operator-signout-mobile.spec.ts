import { test, expect, type Page, type Locator } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import es from "../messages/es.json";

/**
 * «Cerrar sesión» a la vista del DUEÑO en el celular, AL PIE del cajón.
 *
 * Historia: el botón vivía al pie del cajón y el dueño no lo encontraba (se
 * leía como un chip y el pie es la franja que la barra del navegador puede
 * tapar); #599 lo subió arriba. Ahora el dueño lo quiere abajo, como en
 * escritorio: el bloque de cuenta (quién soy, idioma, «Cerrar sesión») es el
 * pie FIJO del cajón y la lista hace scroll por encima. Este spec falla si,
 * con el cajón abierto en un viewport de celular, el botón deja de estar
 * entero en pantalla, queda tapado, el cajón mide más que lo visible (el pie
 * quedaría debajo de la barra del navegador), el bloque deja de ser el pie o
 * se mueve al desplazar la lista.
 *
 * Los viewports bajos simulan el alto que dejan las barras de Safari: el
 * cajón debe medir exactamente eso.
 *
 * Mismas salvaguardas que operator-safe-area.spec.ts: sólo corre contra una
 * app local y una base de validación aislada (crea y borra sus propios datos).
 * El proyecto `mobile` de playwright.config.ts es WebKit (motor de Safari).
 */
const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(
  !["localhost", "127.0.0.1"].includes(databaseUrl.hostname) ||
  !/^\/mesapay_.*validation$/.test(databaseUrl.pathname) ||
  !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""),
  "An isolated local app and validation database are required",
);
const db = new PrismaClient();

/** Margen máximo entre «Cerrar sesión» y el borde inferior: el padding del pie. */
const FOOT_GAP = 16;
/** Todos los módulos con entrada en el menú: el cajón más largo posible. */
const ALL_MODULES = ["inventory", "purchasing", "recipes", "production", "staff", "accounting", "vouchers"];

const phones = [
  { name: "iPhone 13/14 con la barra de Safari minimizada", width: 390, height: 797 },
  { name: "iPhone 13/14 con las barras de Safari", width: 390, height: 664 },
  { name: "iPhone SE con las barras de Safari", width: 375, height: 553 },
  { name: "iPhone SE de primera generación", width: 320, height: 568 },
  { name: "celular en horizontal", width: 667, height: 375 },
] as const;

async function createOwner() {
  const token = randomUUID();
  const password = `Salir-${token}`;
  const restaurant = await db.restaurant.create({
    data: {
      name: "Restaurante de prueba",
      slug: `salir-${token}`,
      hasBar: true,
      reservationsEnabled: true,
      enabledModules: ALL_MODULES,
    },
  });
  const user = await db.user.create({
    data: {
      email: `salir-${token}@example.test`,
      passwordHash: await bcrypt.hash(password, 4),
      role: "operator",
      restaurantId: restaurant.id,
    },
  });
  return { restaurant, user, password };
}

async function removeOwner(owner: Awaited<ReturnType<typeof createOwner>>) {
  await db.user.deleteMany({ where: { id: owner.user.id } });
  await db.restaurant.delete({ where: { id: owner.restaurant.id } });
}

async function login(page: Page, email: string, password: string) {
  await page.goto("/signin");
  const submit = page.locator('button[type="submit"]');
  // El formulario se envía desde el cliente: esperar a que React lo hidrate
  // (antes de eso el navegador haría un envío nativo y no habría sesión).
  await expect
    .poll(() => submit.evaluate((el) => Object.keys(el).some((key) => key.startsWith("__reactProps"))), { timeout: 30_000 })
    .toBe(true);
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await submit.click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 45_000 });
}

/** Abre el cajón cuando React ya hidrató el botón (antes, el toque no hace nada). */
async function openMenu(page: Page) {
  const button = page.getByRole("button", { name: es.operator.openMenu, exact: true });
  await expect
    .poll(() => button.evaluate((el) => Object.keys(el).some((key) => key.startsWith("__reactProps"))), { timeout: 30_000 })
    .toBe(true);
  await button.click();
}

/** El botón está entero en pantalla, mide lo que debe y nada lo tapa. */
async function expectReachable(page: Page, button: Locator, viewport: { width: number; height: number }) {
  await expect(button).toBeVisible();
  await expect(button).toBeInViewport({ ratio: 1 });
  const box = (await button.boundingBox())!;
  expect(box.height, "objetivo táctil ≥ 44px").toBeGreaterThanOrEqual(44);
  expect(box.width, "objetivo táctil ≥ 44px").toBeGreaterThanOrEqual(44);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  const onTop = await button.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit === el || el.contains(hit);
  });
  expect(onTop, "nada tapa el botón").toBe(true);
  return box;
}

for (const phone of phones) {
  test(`el dueño ve «Cerrar sesión» al pie del menú — ${phone.name} (${phone.width}×${phone.height})`, async ({ page }) => {
    test.setTimeout(90_000);
    const owner = await createOwner();
    try {
      await page.setViewportSize({ width: phone.width, height: phone.height });
      await page.route(/^https?:\/\//, (route) => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
      await login(page, owner.user.email, owner.password);
      await page.goto("/operator", { waitUntil: "domcontentloaded" });
      await expect(page.locator(".op-app-shell")).toBeVisible();

      await openMenu(page);
      const drawer = page.locator("dialog.mp-navigation-drawer");
      await expect(drawer).toBeVisible();
      const signOut = drawer.getByRole("button", { name: es.operator.signOutFull, exact: true });
      await expect(signOut).toHaveCount(1);
      const account = drawer.getByRole("group", { name: es.operator.accountSection, exact: true });
      const nav = drawer.locator(".mp-rail-nav");

      // 1) Recién abierto: entero a la vista, sin desplazarse.
      const box = await expectReachable(page, signOut, phone);

      // 2) El cajón mide exactamente lo visible: ni más (el pie quedaría
      //    debajo de la barra del navegador) ni menos.
      const drawerBox = (await drawer.boundingBox())!;
      expect(drawerBox.y).toBe(0);
      expect(drawerBox.y + drawerBox.height, "el cajón no pasa del borde visible").toBeLessThanOrEqual(phone.height + 0.5);
      expect(drawerBox.y + drawerBox.height, "el cajón llega al borde visible").toBeGreaterThanOrEqual(phone.height - 0.5);

      // 3) Al PIE: el bloque de cuenta cierra el cajón, debajo de la lista,
      //    y «Cerrar sesión» queda pegado al borde inferior.
      const accountBox = (await account.boundingBox())!;
      const navBox = (await nav.boundingBox())!;
      expect(accountBox.y + accountBox.height, "el bloque de cuenta es el pie del cajón").toBeCloseTo(drawerBox.y + drawerBox.height, 0);
      expect(accountBox.y, "el pie va debajo de la lista").toBeGreaterThanOrEqual(navBox.y + navBox.height - 0.5);
      expect(box.y, "«Cerrar sesión» va en el pie").toBeGreaterThanOrEqual(accountBox.y);
      const gap = phone.height - (box.y + box.height);
      expect(gap, "«Cerrar sesión» al pie del cajón").toBeGreaterThanOrEqual(0);
      expect(gap, "«Cerrar sesión» al pie del cajón").toBeLessThanOrEqual(FOOT_GAP);
      // Compacto: le deja alto a la lista (más todavía en pantallas bajas).
      expect(accountBox.height).toBeLessThanOrEqual(phone.height <= 600 ? 96 : 120);
      // Lo acompañan quién tiene la sesión abierta y el idioma, a la vista.
      await expect(account).toContainText(owner.user.email);
      await expect(account.getByText(owner.user.email)).toBeInViewport({ ratio: 1 });
      const locale = account.locator(".mp-locale-switcher");
      await expect(locale).toBeInViewport({ ratio: 1 });
      expect((await locale.boundingBox())!.height, "objetivo táctil del idioma ≥ 44px").toBeGreaterThanOrEqual(44);

      // 4) Menú largo: con todos los grupos desplegados la lista es la que
      //    hace scroll, por encima del pie, y el botón no se mueve.
      const groups = drawer.locator("button[aria-controls]");
      const total = await groups.count();
      expect(total).toBeGreaterThanOrEqual(5);
      for (let i = 0; i < total; i++) {
        if ((await groups.nth(i).getAttribute("aria-expanded")) !== "true") {
          await groups.nth(i).evaluate((el: HTMLElement) => el.click());
        }
      }
      expect(await nav.evaluate((el) => el.scrollHeight > el.clientHeight), "la lista es la que hace scroll").toBe(true);
      await nav.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      const after = await expectReachable(page, signOut, phone);
      expect(after.y).toBeCloseTo(box.y, 0);
      // El último ítem de la lista sube entero por encima del pie.
      const lastLink = nav.getByRole("link").last();
      await expect(lastLink).toBeInViewport({ ratio: 1 });
      const lastBox = (await lastLink.boundingBox())!;
      expect(lastBox.y + lastBox.height, "el pie no tapa el final de la lista").toBeLessThanOrEqual(accountBox.y + 0.5);
      // El cajón no se desplaza entero ni mueve la página de atrás.
      expect(await drawer.locator(".mp-rail").evaluate((el) => el.scrollTop)).toBe(0);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ animations: "disabled", path: test.info().outputPath(`cerrar-sesion-${phone.width}x${phone.height}.png`) });

      // 5) Y funciona: cierra la sesión de verdad.
      await signOut.click();
      await page.waitForURL((url) => !url.pathname.startsWith("/operator"), { timeout: 30_000 });
      // Sin sesión, el panel manda a iniciar sesión. Con reintento: la
      // redirección de la salida puede seguir en curso e interrumpir el goto.
      await expect(async () => {
        await page.goto("/operator", { waitUntil: "domcontentloaded" });
        expect(new URL(page.url()).pathname).toBe("/signin");
      }).toPass({ timeout: 30_000 });
    } finally {
      await removeOwner(owner);
    }
  });
}

test("en escritorio «Cerrar sesión» sigue al pie del riel, siempre visible", async ({ page }) => {
  test.setTimeout(90_000);
  const owner = await createOwner();
  try {
    const viewport = { width: 1280, height: 560 };
    await page.setViewportSize(viewport);
    await page.route(/^https?:\/\//, (route) => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    await login(page, owner.user.email, owner.password);
    await page.goto("/operator", { waitUntil: "domcontentloaded" });
    const rail = page.locator(".op-app-shell > aside");
    await expect(rail).toBeVisible();
    const signOut = rail.getByRole("button", { name: es.operator.signOutFull, exact: true });
    const box = await expectReachable(page, signOut, viewport);
    // Al pie: debajo de la lista de navegación, que es la que hace scroll.
    const nav = (await rail.locator(".mp-rail-nav").boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(nav.y + nav.height);
    // El selector de idioma y el botón caben en la misma fila, sin desbordar.
    const footer = rail.locator(".mp-rail-account");
    expect(await footer.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await signOut.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  } finally {
    await removeOwner(owner);
  }
});

test.afterAll(() => db.$disconnect());
