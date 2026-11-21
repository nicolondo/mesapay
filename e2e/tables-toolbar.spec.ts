import { test, expect, type Locator, type Page, type Request as BrowserRequest } from "@playwright/test";
import { Prisma, PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import es from "../messages/es.json";
import en from "../messages/en.json";
import pt from "../messages/pt.json";

const application = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3411");
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(
  !["localhost", "127.0.0.1"].includes(application.hostname) ||
    !["localhost", "127.0.0.1"].includes(database.hostname) ||
    !/^\/mesapay_.*validation$/.test(database.pathname),
  "Table toolbar tests require an isolated local application and validation database",
);
test.setTimeout(120_000);
test.use({ actionTimeout: 15_000, navigationTimeout: 60_000 });

const db = new PrismaClient();
const restaurantIds = new Set<string>();
const messages = { es: es.opTables, en: en.opTables, pt: pt.opTables };
type FixtureOptions = { role?: "operator" | "mesero"; counter?: boolean; map?: boolean; manuals?: boolean };

async function fixture(page: Page, { role = "operator", counter = false, map = true, manuals = true }: FixtureOptions = {}) {
  const uid = randomUUID();
  const errors: string[] = [];
  const pendingRsc = new Set<BrowserRequest>();
  let lastRscActivity = Date.now();
  page.on("request", request => {
    if (new URL(request.url()).searchParams.has("_rsc")) {
      pendingRsc.add(request);
      lastRscActivity = Date.now();
    }
  });
  const finishRsc = (request: BrowserRequest) => {
    if (pendingRsc.delete(request)) lastRscActivity = Date.now();
  };
  page.on("requestfinished", finishRsc);
  page.on("requestfailed", finishRsc);
  page.on("pageerror", error => {
    // WebKit reports an interrupted SSE/session fetch during a reload as a
    // CORS exception; retain all errors outside those exact background paths.
    const interruptedBackground = error.message.endsWith(" due to access control checks.") &&
      /\/(?:api\/(?:version|auth\/session|tenant\/tables-toolbar-[^/]+\/events)|__nextjs_original-stack-frames) due/.test(error.message);
    if (!interruptedBackground) errors.push(error.message);
  });
  await page.route(/^https?:\/\//, route =>
    ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort(),
  );
  const headers = { "x-real-ip": `127.6.${parseInt(uid.slice(0, 2), 16)}.${parseInt(uid.slice(2, 4), 16)}` };
  await page.setExtraHTTPHeaders(headers);
  const restaurant = await db.restaurant.create({ data: {
    name: "Salón de prueba", slug: `tables-toolbar-${uid}`, country: "CO",
    serviceMode: counter ? "counter" : "table",
    ...(map ? { floorPlan: { version: 2, v2: { zones: [], markers: [] } } } : {}),
  } });
  restaurantIds.add(restaurant.id);
  const user = await db.user.create({ data: {
    restaurantId: restaurant.id, email: `tables-toolbar-${uid}@example.test`, role,
    passwordHash: await bcrypt.hash(uid, 4),
  } });
  await db.table.createMany({ data: Array.from({ length: 50 }, (_, index) => ({
    restaurantId: restaurant.id, number: index + 1, kind: "standard" as const, qrToken: randomUUID(),
    ...(map ? { floorX: 2 + (index % 10) * 3, floorY: 2 + Math.floor(index / 10) * 3, floorW: 1, floorH: 1, floorRotation: 0 } : {}),
  })) });
  const tables = await db.table.findMany({ where: { restaurantId: restaurant.id }, orderBy: { number: "asc" } });
  await db.order.create({ data: { restaurantId: restaurant.id, tableId: tables[0].id, shortCode: `ACTIVE-${uid}`, status: "open" } });
  await db.order.create({ data: { restaurantId: restaurant.id, tableId: tables[1].id, shortCode: `PAID-${uid}`, status: "paid", paidAt: new Date() } });
  for (const number of manuals ? [-100, -101] : []) {
    const table = await db.table.create({ data: { restaurantId: restaurant.id, number, kind: "manual", qrToken: randomUUID() } });
    await db.order.create({ data: { restaurantId: restaurant.id, tableId: table.id, shortCode: `MANUAL-${number}-${uid}`, status: "open" } });
  }
  await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: "es", domain: application.hostname, path: "/" }]);
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const login = await page.request.post("/api/auth/callback/credentials", {
    headers: { ...headers, "X-Auth-Return-Redirect": "1" },
    form: { csrfToken: csrf.csrfToken, email: user.email, password: uid, callbackUrl: `${application.origin}/operator/tables` },
  });
  expect(login.ok()).toBe(true);
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(user.id);
  await page.goto(role === "mesero" ? "/mesero/mesas" : "/operator/tables");
  await expect(page.getByRole("heading", { name: counter ? es.opTables.headerCounter : es.opTables.headerTables, exact: true })).toBeVisible();
  // Allow the actual LiveRefresh request to finish before an intentional
  // full reload; interrupting it creates unrelated WebKit CORS exceptions.
  const settle = () => expect.poll(() => pendingRsc.size === 0 && Date.now() - lastRscActivity >= 150).toBe(true);
  return { restaurant, user, tables, errors, settle };
}

function filter(page: Page, label: string) {
  return page.getByRole("button", { name: new RegExp(`^${label}\\s*\\d+$`) });
}

async function fullyVisible(page: Page, control: Locator, minimumHeight = 44) {
  await expect(control).toBeVisible();
  const box = (await control.boundingBox())!;
  const width = page.viewportSize()!.width;
  expect(box.x, "control starts inside the viewport").toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, "control ends inside the viewport").toBeLessThanOrEqual(width + 1);
  expect(box.height, "touch target remains comfortable").toBeGreaterThanOrEqual(minimumHeight);
  expect(await control.evaluate(element => {
    const rect = element.getBoundingClientRect();
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX)) {
        const clipping = parent.getBoundingClientRect();
        if (rect.left < clipping.left - 1 || rect.right > clipping.right + 1) return false;
      }
    }
    return true;
  }), "control is not clipped by a horizontal scrolling ancestor").toBe(true);
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

async function legibleFilter(page: Page, control: Locator) {
  await fullyVisible(page, control);
  const label = control.locator(":scope > span").nth(0);
  const count = control.locator(":scope > span").nth(1);
  const labelBox = (await label.boundingBox())!, countBox = (await count.boundingBox())!;
  expect(labelBox.x + labelBox.width, "filter label does not collide with its count").toBeLessThanOrEqual(countBox.x + 1);
  expect(await label.evaluate(element => element.scrollWidth <= element.clientWidth + 1), "filter label wraps inside its own space").toBe(true);
}

test.afterEach(async () => {
  for (const restaurantId of restaurantIds) {
    await db.order.deleteMany({ where: { restaurantId } });
    await db.user.deleteMany({ where: { restaurantId } });
    await db.restaurant.delete({ where: { id: restaurantId } });
    restaurantIds.delete(restaurantId);
  }
});
test.afterAll(() => db.$disconnect());

test("all four filters remain visible and filter the tables in every language", async ({ page }, info) => {
  const f = await fixture(page);
  const widths = info.project.name === "mobile" ? [390, 320] : [1280, 1100];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    for (const locale of ["es", "en", "pt"] as const) {
      const t = messages[locale];
      await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: locale, domain: application.hostname, path: "/" }]);
      await f.settle();
      await page.reload();
      await expect(filter(page, t.filterAll)).toHaveAttribute("aria-pressed", "true");
      await page.screenshot({ path: info.outputPath(`filters-${width}-${locale}.png`), animations: "disabled" });
      // Start with the last filter: the previous horizontal strip clipped it.
      for (const label of [t.filterFree, t.filterAll, t.filterByPay, t.filterRecent]) await legibleFilter(page, filter(page, label));
      await noHorizontalOverflow(page);
      await filter(page, t.filterByPay).click();
      await expect(filter(page, t.filterByPay)).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(".mp-table-grid > *")).toHaveCount(1);
      await filter(page, t.filterRecent).click();
      await expect(page.locator(".mp-table-grid > *")).toHaveCount(1);
      await filter(page, t.filterFree).click();
      await expect(page.locator(".mp-table-grid > *")).toHaveCount(48);
      await filter(page, t.filterAll).click();
      await expect(page.locator(".mp-table-grid > *")).toHaveCount(50);
    }
  }
  expect(f.errors).toEqual([]);
});

test("map choice and grouped management remain usable without mixing invoice actions", async ({ page }, info) => {
  await page.setViewportSize({ width: info.project.name === "mobile" ? 390 : 1280, height: 900 });
  const f = await fixture(page);
  const t = messages.es;
  const manage = page.getByRole("button", { name: "Gestionar mesas", exact: true });
  const view = page.getByRole("group", { name: t.viewLabel, exact: true });
  const map = view.getByRole("button", { name: t.viewMap, exact: true });
  await fullyVisible(page, manage);
  await fullyVisible(page, map);
  await expect(page.getByRole("link", { name: t.printQrs, exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: t.newTableAdd, exact: true })).toBeHidden();
  const createInvoice = page.getByRole("button", { name: /Factura manual/ }).filter({ visible: true });
  const pending = page.locator('a[href="/operator/facturas-manuales"]').filter({ visible: true });
  await fullyVisible(page, createInvoice);
  await fullyVisible(page, pending);
  await expect(pending).toContainText("2");
  const createBox = (await createInvoice.boundingBox())!, pendingBox = (await pending.boundingBox())!;
  expect(Math.abs(createBox.y - pendingBox.y), "invoice actions occupy one deliberate row").toBeLessThanOrEqual(2);
  await map.click();
  await expect(map).toHaveAttribute("aria-pressed", "true");
  await f.settle();
  await page.reload();
  await expect(map).toHaveAttribute("aria-pressed", "true");
  await manage.click();
  await expect(manage).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("link", { name: t.printQrs, exact: true })).toHaveAttribute("href", "/operator/tables/print");
  await page.getByRole("button", { name: t.newTableAdd, exact: true }).click();
  const form = page.locator("form").filter({ has: page.getByLabel(t.newTableLabel, { exact: true }) });
  await expect(form).toBeVisible();
  const management = page.getByRole("group", { name: "Gestionar mesas", exact: true });
  expect((await form.boundingBox())!.width).toBeGreaterThan((await management.boundingBox())!.width * 0.85);
  await page.screenshot({ path: info.outputPath("management-add-table.png"), animations: "disabled" });
  await noHorizontalOverflow(page);
  await form.getByRole("button", { name: t.newTableCancel, exact: true }).click();
  await page.getByRole("button", { name: t.editTables, exact: true }).click();
  const done = page.getByRole("button", { name: t.editDone, exact: true });
  await expect(done).toBeVisible();
  await expect(map).toBeHidden();
  await expect(page.locator(".mp-table-grid > button")).toHaveCount(50);
  await page.screenshot({ path: info.outputPath("management-edit-tables.png"), animations: "disabled" });
  await done.click();
  await expect(map).toHaveAttribute("aria-pressed", "true");
  await manage.click();
  await page.getByRole("button", { name: t.editTables, exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(manage).toHaveAttribute("aria-expanded", "false");
  await expect(manage).toBeFocused();
  await noHorizontalOverflow(page);
  expect(f.errors).toEqual([]);
});

test("waiters retain table filters and views without administration or invoicing", async ({ page }, info) => {
  await page.setViewportSize({ width: info.project.name === "mobile" ? 320 : 1280, height: 900 });
  const f = await fixture(page, { role: "mesero" });
  for (const label of [es.opTables.filterAll, es.opTables.filterByPay, es.opTables.filterRecent, es.opTables.filterFree]) await fullyVisible(page, filter(page, label));
  await expect(page.getByRole("group", { name: es.opTables.viewLabel, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Gestionar mesas", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: es.opTables.newTableAdd, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: es.opTables.editTables, exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: es.opTables.printQrs, exact: true })).toHaveCount(0);
  await expect(page.locator('a[href="/operator/facturas-manuales"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Factura manual/ })).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath("waiter-tables.png"), animations: "disabled" });
  expect(f.errors).toEqual([]);
});

test("counter mode and a restaurant without a floor plan omit unavailable actions", async ({ page }, info) => {
  await page.setViewportSize({ width: info.project.name === "mobile" ? 320 : 1280, height: 900 });
  const f = await fixture(page, { counter: true, map: true, manuals: false });
  await expect(page.getByRole("group", { name: es.opTables.viewLabel, exact: true })).toHaveCount(0);
  const invoices = page.getByRole("group", { name: es.opTables.manualInvoicesLabel, exact: true });
  const createInvoice = invoices.getByRole("button", { name: es.opTables.manualInvoiceButton, exact: true });
  await expect(invoices.getByRole("link")).toHaveCount(0);
  await expect(invoices.getByRole("button")).toHaveCount(1);
  if (info.project.name === "mobile") {
    expect((await createInvoice.boundingBox())!.width, "a single invoice action uses the full row").toBeGreaterThan((await invoices.boundingBox())!.width * 0.9);
  }
  await page.getByRole("button", { name: "Gestionar mesas", exact: true }).click();
  await expect(page.getByRole("button", { name: es.opTables.newTableAdd, exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: es.opTables.printQr, exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath("counter-management.png"), animations: "disabled" });
  await db.restaurant.update({ where: { id: f.restaurant.id }, data: { serviceMode: "table", floorPlan: Prisma.DbNull } });
  await f.settle();
  await page.reload();
  await expect(page.getByRole("heading", { name: es.opTables.headerTables, exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: es.opTables.viewLabel, exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Gestionar mesas", exact: true }).click();
  await expect(page.getByRole("button", { name: es.opTables.newTableAdd, exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  expect(f.errors).toEqual([]);
});
