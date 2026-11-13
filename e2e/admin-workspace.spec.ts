import { test, expect, type Page } from "@playwright/test";
import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

const application = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3411");
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(
  !["localhost", "127.0.0.1"].includes(application.hostname) ||
  !["localhost", "127.0.0.1"].includes(database.hostname) ||
  !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname),
  "Admin workspace tests require isolated local services",
);
test.setTimeout(90_000);
test.use({ actionTimeout: 15_000, navigationTimeout: 60_000 });
const db = new PrismaClient();
const users: string[] = [];
const restaurants: string[] = [];
const navigationLabel = "Navegación de administración";

async function isolate(page: Page) {
  await page.route(/^https?:\/\//, (route) =>
    ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname)
      ? route.fallback()
      : route.abort(),
  );
  await page.context().addCookies([
    { name: "MESAPAY_LOCALE", value: "es", domain: application.hostname, path: "/" },
  ]);
}

async function fixture(page: Page, role: Role = "platform_admin", withRestaurants = true) {
  const uid = randomUUID();
  const rows = withRestaurants ? await Promise.all([
    db.restaurant.create({ data: { name: "Café Aurora", slug: `cafeteria-del-parque-${uid}`, country: "CO", city: "Medellín" } }),
    db.restaurant.create({ data: { name: "Brasa Norte", slug: `brasa-norte-${uid}`, country: "CO", city: "Bogotá" } }),
    db.restaurant.create({ data: { name: "Casa del Río", slug: `casa-rio-${uid}`, country: "MX", city: "Monterrey" } }),
  ]) : [];
  restaurants.push(...rows.map((row) => row.id));
  const user = await db.user.create({ data: {
    email: `admin-workspace-${uid}@example.test`, name: "Equipo de prueba",
    role, restaurantId: role === "platform_admin" ? null : rows[0]?.id,
    passwordHash: await bcrypt.hash(uid, 4),
  } });
  users.push(user.id);
  await isolate(page);
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const login = await page.request.post("/api/auth/callback/credentials", {
    headers: { "X-Auth-Return-Redirect": "1" },
    form: { csrfToken: csrf.csrfToken, email: user.email, password: uid, callbackUrl: `${application.origin}/admin/restaurants` },
  });
  expect(login.ok()).toBe(true);
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(user.id);
  return rows;
}

async function openNavigation(page: Page) {
  const trigger = page.getByRole("button", { name: "Abrir menú", exact: true });
  if (await trigger.isVisible()) await trigger.click();
  const navigation = page.getByRole("navigation", { name: navigationLabel, exact: true });
  await expect(navigation).toBeVisible();
  return navigation;
}

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const content = page.locator("#admin-content");
  expect(await content.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
}

async function captureAtTop(page: Page, path: string) {
  await page.evaluate(async () => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    document.querySelector("#admin-content")?.scrollTo({ top: 0, left: 0, behavior: "instant" });
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
}

test.afterEach(async () => {
  if (users.length) await db.user.deleteMany({ where: { id: { in: users.splice(0) } } });
  if (restaurants.length) await db.restaurant.deleteMany({ where: { id: { in: restaurants.splice(0) } } });
});
test.afterAll(() => db.$disconnect());

test("grouped administration navigation keeps every destination and marks nested routes active", async ({ page }, info) => {
  const [restaurant] = await fixture(page);
  await page.goto("/admin/restaurants");
  await expect(page.getByRole("heading", { name: "Restaurantes", exact: true, level: 1 })).toBeVisible();
  await expectNoOverflow(page);
  await captureAtTop(page, info.outputPath("admin-restaurants.png"));
  const nav = await openNavigation(page);
  for (const label of ["Comercios", "Finanzas", "Plataforma"]) await expect(nav.getByText(label, { exact: true })).toBeVisible();
  for (const href of ["/admin/resumen", "/admin/restaurants", "/admin/groups", "/admin/plans", "/admin/audit", "/admin/comisiones", "/admin/wallet", "/admin/configuracion", "/comercial"]) {
    await expect(nav.locator(`a[href="${href}"]`)).toHaveCount(1);
  }
  await expect(nav.getByRole("link", { name: "Restaurantes", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  if (info.project.name === "desktop") {
    const navBox = await nav.boundingBox();
    const mainBox = await page.locator("#admin-content").boundingBox();
    expect(navBox && mainBox && navBox.x + navBox.width <= mainBox.x + 1).toBe(true);
  }
  if (info.project.name === "mobile") await page.keyboard.press("Escape");
  await page.goto(`/admin/restaurants/${restaurant.id}`);
  const nestedNav = await openNavigation(page);
  await expect(nestedNav.getByRole("link", { name: "Restaurantes", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(nestedNav.locator('[aria-current="page"]')).toHaveCount(1);
  if (info.project.name === "mobile") await page.keyboard.press("Escape");
  await expectNoOverflow(page);
});

test("section search supports keyboard shortcuts, no results, Escape and navigation", async ({ page }, info) => {
  await fixture(page);
  await page.goto("/admin/restaurants");
  const trigger = page.getByRole("button", { name: "Ir a una sección", exact: true });
  await trigger.focus();
  await page.keyboard.press("Meta+k");
  const dialog = page.getByRole("dialog", { name: "Ir a una sección", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("searchbox")).toBeFocused();
  await dialog.getByRole("searchbox").fill("seccion-inexistente-123");
  await expect(dialog.getByRole("status")).toContainText("No encontramos coincidencias");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Control+k");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("searchbox").fill("configuracion");
  await expect(dialog.getByRole("link")).toHaveCount(1);
  await captureAtTop(page, info.outputPath("admin-section-search.png"));
  await dialog.getByRole("link", { name: /^Configuración/ }).click();
  await expect(page).toHaveURL(/\/admin\/configuracion$/);
  await expect(dialog).toHaveCount(0);
  await expectNoOverflow(page);
  const nav = await openNavigation(page);
  await expect(nav.getByRole("link", { name: "Configuración", exact: true })).toHaveAttribute("aria-current", "page");
});

test("mobile drawer traps focus, closes on Escape and navigation, and remains usable on short screens", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Desktop uses the persistent sidebar");
  await fixture(page);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/admin/restaurants");
  const trigger = page.getByRole("button", { name: "Abrir menú", exact: true });
  await trigger.click();
  const drawer = page.getByRole("dialog", { name: "Abrir menú", exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Cerrar menú", exact: true })).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  expect(await drawer.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Tab");
  expect(await drawer.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await captureAtTop(page, info.outputPath("admin-mobile-drawer.png"));
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await drawer.getByRole("link", { name: "Configuración", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/configuracion$/);
  await expect(drawer).toHaveCount(0);
  await expect(trigger).toBeVisible();
  const triggerBox = await trigger.boundingBox();
  expect(triggerBox && triggerBox.x >= 0 && triggerBox.y >= 0 && triggerBox.x + triggerBox.width <= 320).toBe(true);
  await expectNoOverflow(page);
  await trigger.click();
  await expect(drawer).toBeVisible();
  await page.setViewportSize({ width: 820, height: 568 });
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: navigationLabel, exact: true })).toBeVisible();
  expect(await page.locator("body").evaluate((node) => getComputedStyle(node).position)).not.toBe("fixed");
  await expectNoOverflow(page);
});

test("mobile shell and drawer reserve the device safe area", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Chrome DevTools can emulate nonzero safe-area insets");
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 44, bottom: 34, left: 12, right: 12 } });
  await page.goto("/admin/restaurants");
  const trigger = page.getByRole("button", { name: "Abrir menú", exact: true });
  const box = await trigger.boundingBox();
  expect(box && box.y >= 44 && box.x >= 12 && box.x + box.width <= 378).toBe(true);
  const bottomPadding = await page.locator("#admin-content").evaluate((node) => parseFloat(getComputedStyle(node).paddingBottom));
  expect(bottomPadding).toBeGreaterThanOrEqual(34);
  await trigger.click();
  const drawer = page.getByRole("dialog", { name: "Abrir menú", exact: true });
  const close = drawer.getByRole("button", { name: "Cerrar menú", exact: true });
  const closeBox = await close.boundingBox();
  expect(closeBox && closeBox.y >= 44).toBe(true);
  await captureAtTop(page, info.outputPath("admin-safe-area-drawer.png"));
  await close.click();
  await expect(trigger).toBeFocused();
  await expectNoOverflow(page);
  await session.detach();
});

test("navigation resets the content scroll and print keeps content without workspace chrome", async ({ page }, info) => {
  const [restaurant] = await fixture(page);
  await page.goto(`/admin/restaurants/${restaurant.id}`);
  const content = page.locator("#admin-content");
  await content.evaluate((node) => node.scrollTo({ top: node.scrollHeight, behavior: "instant" }));
  await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBeGreaterThan(100);
  const nav = await openNavigation(page);
  await nav.getByRole("link", { name: "Resumen", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/resumen$/);
  await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBe(0);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoOverflow(page);
  await captureAtTop(page, info.outputPath("admin-summary.png"));
  await page.emulateMedia({ media: "print" });
  await expect(page.getByRole("button", { name: "Ir a una sección", exact: true })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Abrir menú", exact: true })).not.toBeVisible();
  await expect(page.getByRole("navigation", { name: navigationLabel, exact: true })).not.toBeVisible();
  await expect(content).toBeVisible();
  expect(await content.evaluate((node) => !["hidden", "auto", "scroll"].includes(getComputedStyle(node).overflowY))).toBe(true);
  await captureAtTop(page, info.outputPath("admin-summary-print.png"));
});

test("the printed restaurant directory includes the figures from collapsed cards", async ({ page }, info) => {
  const [restaurant] = await fixture(page);
  // A4 portrait is narrower than the desktop table breakpoint. The print
  // must keep the restaurant figures even when its screen card is folded.
  await page.setViewportSize({ width: 794, height: 1123 });
  await page.goto("/admin/restaurants");
  await page.emulateMedia({ media: "print" });
  const table = page.locator("#admin-content").getByRole("table");
  await expect(table).toBeVisible();
  const row = table.getByRole("row").filter({ has: page.locator(`a[href="/admin/restaurants/${restaurant.id}"]`) });
  await expect(row).toBeVisible();
  for (const name of ["Operadores", "Menú", "Mesas", "Órdenes", "Pagadas", "Última"]) {
    await expect(table.getByRole("columnheader", { name, exact: true })).toBeVisible();
  }
  await expect(row.getByRole("cell")).toHaveCount(10);
  const box = await table.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 795).toBe(true);
  await expect(page.getByRole("navigation", { name: navigationLabel, exact: true })).not.toBeVisible();
  await captureAtTop(page, info.outputPath("admin-restaurants-print.png"));
});

test("restaurant search matches name or slug, combines location filters, and clears all filters", async ({ page }, info) => {
  const rows = await fixture(page);
  await page.goto("/admin/restaurants");
  const search = page.getByRole("searchbox", { name: "Buscar restaurante", exact: true });
  const submit = page.getByRole("button", { name: "Buscar", exact: true });
  const result = (id: string) => page.locator(`#admin-content a[href="/admin/restaurants/${id}"]:visible`);
  await search.fill("Aurora");
  await submit.click();
  await expect(page).toHaveURL(/q=Aurora/);
  await expect(result(rows[0].id)).toHaveCount(1);
  await expect(result(rows[1].id)).toHaveCount(0);
  await search.fill("cafeteria-del-parque");
  await page.getByRole("combobox", { name: /^Filtrar por país/ }).selectOption("CO");
  await page.getByRole("combobox", { name: /^Filtrar por ciudad/ }).selectOption("Medellín");
  await submit.click();
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("cafeteria-del-parque");
  expect(new URL(page.url()).searchParams.get("country")).toBe("CO");
  expect(new URL(page.url()).searchParams.get("city")).toBe("Medellín");
  await expect(result(rows[0].id)).toHaveCount(1);
  await page.reload();
  await expect(search).toHaveValue("cafeteria-del-parque");
  await expect(page.getByRole("combobox", { name: /^Filtrar por país/ })).toHaveValue("CO");
  await expect(page.getByRole("combobox", { name: /^Filtrar por ciudad/ })).toHaveValue("Medellín");
  await page.getByRole("combobox", { name: /^Filtrar por ciudad/ }).selectOption("Bogotá");
  await submit.click();
  await expect(page.getByText("No encontramos restaurantes", { exact: true })).toBeVisible();
  await expect(page.getByText("Todavía no hay cuentas", { exact: true })).toHaveCount(0);
  await captureAtTop(page, info.outputPath("admin-restaurant-search-empty.png"));
  await page.getByRole("link", { name: "Limpiar filtros", exact: true }).first().click();
  await expect(page).toHaveURL(/\/admin\/restaurants$/);
  await expect(search).toHaveValue("");
  for (const row of rows) await expect(result(row.id)).toHaveCount(1);
  await expectNoOverflow(page);
});

test("an empty restaurant catalog remains distinct from an unsuccessful search", async ({ page }) => {
  await fixture(page, "platform_admin", false);
  await page.goto("/admin/restaurants");
  await expect(page.getByText("Todavía no hay cuentas", { exact: true })).toBeVisible();
  await expect(page.getByText("No encontramos restaurantes", { exact: true })).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Buscar restaurante", exact: true }).fill("sin-coincidencias");
  await page.getByRole("button", { name: "Buscar", exact: true }).click();
  await expect(page.getByText("No encontramos restaurantes", { exact: true })).toBeVisible();
  await expect(page.getByText("Todavía no hay cuentas", { exact: true })).toHaveCount(0);
});

test("anonymous users are redirected to sign in without exposing administration", async ({ page }) => {
  await isolate(page);
  await page.goto("/admin/restaurants");
  await expect(page).toHaveURL(/\/signin\?callbackUrl=/);
  await expect(page.getByRole("navigation", { name: navigationLabel, exact: true })).toHaveCount(0);
  await expect(page.locator("#admin-content")).toHaveCount(0);
});

for (const role of ["operator", "mesero"] as const) {
  test(`${role} users cannot enter the platform workspace`, async ({ page }) => {
    await fixture(page, role);
    for (const path of ["/admin/restaurants", "/admin/configuracion"]) {
      await page.goto(path);
      await expect.poll(() => new URL(page.url()).pathname.startsWith("/admin")).toBe(false);
      await expect(page.getByRole("navigation", { name: navigationLabel, exact: true })).toHaveCount(0);
      await expect(page.locator("#admin-content")).toHaveCount(0);
    }
  });
}
