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
 * cajón debe medir exactamente eso, también si el alto cambia con el cajón
 * abierto (la barra que aparece y desaparece).
 *
 * Mismo cajón en el admin de plataforma. Reporte del dueño (iOS): el cajón
 * no llegaba al borde de abajo, asomaba una franja crema y «Salir» quedaba
 * cortado. Con el cajón abierto el body queda fijo y Safari de iOS 26 no
 * pinta contenido fijo más allá de su viewport de fijos, que puede ser más
 * corto que la pantalla. Eso no se reproduce en Playwright: se SIMULA con
 * CSS (viewport de fijos 60px más corto y nada fijo pintado debajo) y se
 * exige que el pie siga entero y que la franja salga del color del riel.
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

/** El cajón va de borde a borde vertical y nada de la página asoma debajo. */
async function expectEdgeToEdge(page: Page, drawer: Locator, viewport: { width: number; height: number }) {
  const box = (await drawer.boundingBox())!;
  expect(box.y, "el cajón arranca arriba").toBe(0);
  expect(box.y + box.height, "el cajón llega al borde de abajo, sin pasarse").toBeCloseTo(viewport.height, 0);
  const bottomHit = await page.evaluate(
    ({ y }) => document.elementFromPoint(4, y)?.closest("dialog.mp-navigation-drawer") != null,
    { y: viewport.height - 1 },
  );
  expect(bottomHit, "la última fila de la pantalla es del cajón (sin franja)").toBe(true);
  return box;
}

/** El pie (y su botón de salir) cierra el cajón, entero y pegado al borde. */
async function expectFooterAtBottom(page: Page, drawer: Locator, footer: Locator, button: Locator, viewport: { width: number; height: number }) {
  const drawerBox = await expectEdgeToEdge(page, drawer, viewport);
  const box = await expectReachable(page, button, viewport);
  const footerBox = (await footer.boundingBox())!;
  expect(footerBox.y + footerBox.height, "el pie cierra el cajón").toBeCloseTo(drawerBox.y + drawerBox.height, 0);
  const gap = viewport.height - (box.y + box.height);
  expect(gap, "el botón de salir va al pie").toBeGreaterThanOrEqual(0);
  expect(gap, "el botón de salir va al pie").toBeLessThanOrEqual(FOOT_GAP + 20);
  return box;
}

/** Con el cajón abierto, la pantalla se alarga y se acorta (la barra del navegador). */
async function expectSurvivesResize(page: Page, drawer: Locator, footer: Locator, button: Locator, viewport: { width: number; height: number }) {
  for (const delta of [140, -90]) {
    const resized = { width: viewport.width, height: Math.max(320, viewport.height + delta) };
    await page.setViewportSize(resized);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(drawer).toBeVisible();
    await expectFooterAtBottom(page, drawer, footer, button, resized);
  }
  await page.setViewportSize(viewport);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/**
 * Simulación del caso de iOS: el viewport de los elementos fijos queda
 * `strip` px más corto que la pantalla y nada fijo se pinta por debajo (el
 * body, fijo con el cajón abierto, tampoco). Lo único visible ahí es el
 * fondo del documento.
 */
function iosShortFixedViewport(strip: number) {
  return `
    dialog.mp-navigation-drawer, dialog.mp-navigation-drawer::backdrop { bottom: ${strip}px !important; }
    body, dialog.mp-navigation-drawer, dialog.mp-navigation-drawer::backdrop {
      clip-path: inset(0 0 max(0px, calc(100% - 100vh + ${strip}px)) 0) !important;
    }
    nextjs-portal { display: none !important; }`;
}

/** Color [r, g, b] del píxel (en px CSS) de una captura de la página. */
async function pixelAt(page: Page, x: number, y: number) {
  const png = await page.screenshot({ scale: "css", animations: "disabled" });
  return page.evaluate(async ({ b64, x, y }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    return Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
  }, { b64: png.toString("base64"), x, y });
}

const RAIL_RGB = [0x15, 0x11, 0x09];
const BONE_RGB = [0xf5, 0xf1, 0xea];
const near = (a: number[], b: number[], tolerance = 6) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);

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

      // 3b) De borde a borde y estable si la pantalla cambia de alto con el
      //     cajón abierto (la barra del navegador que aparece y desaparece).
      await expectEdgeToEdge(page, drawer, phone);
      await expectSurvivesResize(page, drawer, account, signOut, phone);
      // Mientras está abierto, el fondo del documento es el del riel bajo
      // el cajón (si el navegador deja pantalla sin pintar, no hay franja).
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundImage)).toContain("gradient");

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

test("la página pide pantalla completa (viewport-fit=cover) y barra de estado translúcida en la PWA", async ({ page }) => {
  await page.goto("/signin", { waitUntil: "domcontentloaded" });
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/);
  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute("content", "black-translucent");
  const manifest = await (await page.request.get((await page.locator('link[rel="manifest"]').getAttribute("href"))!)).json();
  expect(manifest.display).toBe("standalone");
});

async function createPlatformAdmin() {
  const token = randomUUID();
  const password = `Admin-${token}`;
  const user = await db.user.create({
    data: {
      email: `admin-cajon-${token}@example.test`,
      passwordHash: await bcrypt.hash(password, 4),
      role: "platform_admin",
    },
  });
  return { user, password };
}

async function openAdminDrawer(page: Page, viewport: { width: number; height: number }) {
  const admin = await createPlatformAdmin();
  await page.setViewportSize(viewport);
  await page.route(/^https?:\/\//, (route) => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await login(page, admin.user.email, admin.password);
  await page.waitForURL((url) => url.pathname.startsWith("/admin/"), { timeout: 45_000 });
  await expect(page.locator(".mp-admin-shell")).toBeVisible();
  const trigger = page.getByRole("button", { name: es.opAdmin.openMenu, exact: true });
  await expect
    .poll(() => trigger.evaluate((el) => Object.keys(el).some((key) => key.startsWith("__reactProps"))), { timeout: 30_000 })
    .toBe(true);
  await trigger.click();
  const drawer = page.locator("dialog.mp-navigation-drawer");
  await expect(drawer).toBeVisible();
  const footer = drawer.locator(".mp-admin-footer");
  const signOut = drawer.getByRole("button", { name: es.opAdmin.signOutFull, exact: true });
  await expect(signOut).toContainText(es.opAdmin.signOut);
  return { admin, drawer, footer, signOut };
}

for (const phone of phones.filter((p) => p.width < p.height)) {
  test(`admin de plataforma: el cajón va de borde a borde y «Salir» queda entero al pie — ${phone.name} (${phone.width}×${phone.height})`, async ({ page }) => {
    test.setTimeout(90_000);
    let adminId: string | undefined;
    try {
      const { admin, drawer, footer, signOut } = await openAdminDrawer(page, phone);
      adminId = admin.user.id;
      await expectFooterAtBottom(page, drawer, footer, signOut, phone);
      await expectSurvivesResize(page, drawer, footer, signOut, phone);
      await expect(footer.locator(".mp-locale-switcher")).toBeInViewport({ ratio: 1 });
      expect(await drawer.locator(".mp-admin-navigation").evaluate((el) => el.contains(document.querySelector("dialog .mp-admin-signout")))).toBe(false);
    } finally {
      if (adminId) await db.user.delete({ where: { id: adminId } });
    }
  });
}

test.describe("simulación de iOS: el viewport de los fijos más corto que la pantalla", () => {
  const STRIP = 60;
  const viewport = { width: 390, height: 844 };

  async function expectNoCreamStrip(page: Page, button: Locator) {
    await page.addStyleTag({ content: iosShortFixedViewport(STRIP) });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    // El pie cae dentro de lo que se pinta: entero, por encima de la franja.
    const box = await expectReachable(page, button, viewport);
    expect(box.y + box.height, "el botón de salir no cae en la franja sin pintar").toBeLessThanOrEqual(viewport.height - STRIP);
    // La franja sale del color del riel bajo el cajón, y velada al lado: nunca crema.
    const under = await pixelAt(page, 12, viewport.height - 12);
    expect(near(under, RAIL_RGB), `bajo el cajón la franja es del riel (${under})`).toBe(true);
    const beside = await pixelAt(page, viewport.width - 12, viewport.height - 12);
    expect(near(beside, BONE_RGB, 40), `al lado del cajón la franja va velada (${beside})`).toBe(false);
  }

  test("cajón del operador", async ({ page }) => {
    test.setTimeout(90_000);
    const owner = await createOwner();
    try {
      await page.setViewportSize(viewport);
      await page.route(/^https?:\/\//, (route) => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
      await login(page, owner.user.email, owner.password);
      await page.goto("/operator", { waitUntil: "domcontentloaded" });
      await expect(page.locator(".op-app-shell")).toBeVisible();
      await openMenu(page);
      const drawer = page.locator("dialog.mp-navigation-drawer");
      await expect(drawer).toBeVisible();
      await expectNoCreamStrip(page, drawer.getByRole("button", { name: es.operator.signOutFull, exact: true }));
      // Al cerrar el cajón el documento recupera su fondo.
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundImage)).toBe("none");
    } finally {
      await removeOwner(owner);
    }
  });

  test("cajón del admin de plataforma", async ({ page }) => {
    test.setTimeout(90_000);
    let adminId: string | undefined;
    try {
      const { admin, signOut } = await openAdminDrawer(page, viewport);
      adminId = admin.user.id;
      await expectNoCreamStrip(page, signOut);
    } finally {
      if (adminId) await db.user.delete({ where: { id: adminId } });
    }
  });
});

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
