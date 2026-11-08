import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

const application = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3411");
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!["localhost", "127.0.0.1"].includes(application.hostname)
  || !["localhost", "127.0.0.1"].includes(database.hostname)
  || !/^\/mesapay_.*validation$/.test(database.pathname), "Calendar tests require isolated local services");
test.setTimeout(90_000);
test.use({ actionTimeout: 15_000, navigationTimeout: 60_000 });
const db = new PrismaClient();
const tenants = new Set<string>();

async function fixture(page: Page, locale = "es") {
  const browserErrors: string[] = [];
  page.on("pageerror", error => {
    // WebKit reports the unrelated background version fetch as a CORS failure
    // when Back/Reload cancels it. Keep application and hydration errors visible.
    if (!error.message.endsWith("/api/version due to access control checks.")) browserErrors.push(error.message);
  });
  const uid = randomUUID();
  const headers = { "x-real-ip": `127.3.${parseInt(uid.slice(0, 2), 16)}.${parseInt(uid.slice(2, 4), 16)}` };
  await page.setExtraHTTPHeaders(headers);
  const restaurant = await db.restaurant.create({ data: { name: "Prueba local del calendario", slug: `orders-calendar-${uid}`, country: "CO", businessDayCutoffHour: 5 } });
  tenants.add(restaurant.id);
  const user = await db.user.create({ data: { restaurantId: restaurant.id, email: `orders-calendar-${uid}@example.test`, role: "operator", passwordHash: await bcrypt.hash(uid, 4) } });
  const table = await db.table.create({ data: { restaurantId: restaurant.id, number: 1, qrToken: uid } });
  const orders = [];
  for (const [date, suffix] of [["2026-10-31", "A"], ["2026-11-01", "B"]]) {
    orders.push(await db.order.create({ data: { restaurantId: restaurant.id, tableId: table.id, shortCode: `CAL-${uid}-${suffix}`, status: "paid", subtotalCents: 100_000, totalCents: 100_000, createdAt: new Date("2026-10-30T18:00:00Z"), paidAt: new Date(`${date}T22:00:00Z`) } }));
  }
  await page.route(/^https?:\/\//, route => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: locale, domain: application.hostname, path: "/" }]);
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const login = await page.request.post("/api/auth/callback/credentials", { headers: { ...headers, "X-Auth-Return-Redirect": "1" }, form: { csrfToken: csrf.csrfToken, email: user.email, password: uid, callbackUrl: `${application.origin}/operator/orders` } });
  expect(login.ok()).toBe(true);
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(user.id);
  await page.goto("/operator/orders?desde=2026-10-31&hasta=2026-10-31&status=paid&q=CAL");
  return { orders, browserErrors };
}

const dateButton = (page: Page) => page.getByRole("button", { name: /sáb.*31.*oct/i });
const orderLink = (page: Page, id: string) => page.locator(`a[href="/operator/orders/${id}"]`).filter({ visible: true });
async function expectPeriod(page: Page, from: string, to = from) {
  await expect.poll(() => {
    const query = new URL(page.url()).searchParams;
    return [query.get("desde"), query.get("hasta"), query.get("status"), query.get("q"), query.get("page")];
  }).toEqual([from, to, "paid", "CAL", null]);
}

test.afterEach(async () => {
  for (const restaurantId of tenants) {
    await db.order.deleteMany({ where: { restaurantId } });
    await db.user.deleteMany({ where: { restaurantId } });
    await db.restaurant.deleteMany({ where: { id: restaurantId } });
    tenants.delete(restaurantId);
  }
});
test.afterAll(() => db.$disconnect());

test("the date opens a calendar and selecting another month filters exactly that day", async ({ page }, info) => {
  const { orders, browserErrors } = await fixture(page);
  await expect(orderLink(page, orders[0].id)).toBeVisible();
  await expect(orderLink(page, orders[1].id)).toHaveCount(0);
  await dateButton(page).click();
  const calendar = page.getByRole("dialog", { name: "Elegir un día", exact: true });
  await expect(calendar).toBeVisible();
  await expect(page.getByRole("link", { name: "Día", exact: true })).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("button", { name: "Rango", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(calendar.getByRole("grid", { name: "Octubre de 2026", exact: true })).toBeVisible();
  await calendar.getByRole("button", { name: "Mes siguiente", exact: true }).click();
  await expect(calendar.getByRole("grid", { name: "Noviembre de 2026", exact: true })).toBeVisible();
  const bounds = await calendar.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(await calendar.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("orders-day-calendar.png"), animations: "disabled" });
  await calendar.getByRole("button", { name: "domingo, 1 de noviembre de 2026", exact: true }).click();
  await expect(calendar).toHaveCount(0);
  await expectPeriod(page, "2026-11-01");
  await expect(orderLink(page, orders[1].id)).toBeVisible();
  await expect(orderLink(page, orders[0].id)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Día", exact: true })).toHaveAttribute("aria-current", "true");
  await page.goBack();
  await expectPeriod(page, "2026-10-31");
  await expect(orderLink(page, orders[0].id)).toBeVisible();
  await page.reload();
  await expectPeriod(page, "2026-10-31");
  expect(browserErrors).toEqual([]);
});

test("keyboard selection crosses months, Escape restores focus and future days stay unavailable", async ({ page }) => {
  const { browserErrors } = await fixture(page);
  const trigger = dateButton(page);
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  const calendar = page.getByRole("dialog", { name: "Elegir un día", exact: true });
  const selected = calendar.getByRole("button", { name: "sábado, 31 de octubre de 2026", exact: true });
  await expect(selected).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(calendar).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expectPeriod(page, "2026-10-31");
  await page.keyboard.press("Enter");
  await expect(selected).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(calendar.getByRole("button", { name: "domingo, 1 de noviembre de 2026", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expectPeriod(page, "2026-11-01");
  await page.getByRole("button", { name: /dom.*1.*nov/i }).click();
  const input = calendar.getByLabel("Fecha", { exact: true });
  const today = await input.getAttribute("max");
  await input.fill(today!);
  await calendar.getByRole("button", { name: "Ver día", exact: true }).click();
  await expect(calendar).toHaveCount(0);
  await page.getByRole("button", { name: "Hoy", exact: true }).click();
  await expect(calendar.getByRole("button", { name: "Mes siguiente", exact: true })).toBeDisabled();
  await expect(calendar.locator('td button[disabled]').first()).toBeDisabled();
  const currentDay = calendar.locator('button[aria-current="date"]');
  await expect(currentDay).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(currentDay).toBeFocused();
  // At the future boundary a later edit must stay in the date field, not
  // unexpectedly move back to the calendar grid.
  await input.fill("2026-10-31");
  await expect(input).toBeFocused();
  const previousMonth = calendar.getByRole("button", { name: "Mes anterior", exact: true });
  await previousMonth.click();
  await expect(previousMonth).toBeFocused();
  await expect(calendar.getByRole("grid", { name: "Septiembre de 2026", exact: true })).toBeVisible();
  const close = calendar.getByRole("button", { name: "Cerrar calendario", exact: true });
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(calendar.getByRole("button", { name: "Ver día", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Hoy", exact: true })).toBeFocused();
  expect(browserErrors).toEqual([]);
});

test("week, month and explicit range keep their navigation and calendar selection returns to day", async ({ page }) => {
  const { browserErrors } = await fixture(page);
  await page.getByRole("link", { name: "Semana", exact: true }).click();
  await expectPeriod(page, "2026-10-26", "2026-11-01");
  await page.getByRole("link", { name: "Semana anterior", exact: true }).click();
  await expectPeriod(page, "2026-10-19", "2026-10-25");
  await page.getByRole("link", { name: "Mes", exact: true }).click();
  await expectPeriod(page, "2026-10-01", "2026-10-31");
  await page.getByRole("link", { name: "Mes anterior", exact: true }).click();
  await expectPeriod(page, "2026-09-01", "2026-09-30");
  await page.getByRole("button", { name: "Rango", exact: true }).click();
  await page.getByLabel("Desde", { exact: true }).fill("2026-10-30");
  await page.getByLabel("Hasta", { exact: true }).fill("2026-11-02");
  await page.getByRole("button", { name: "Ver", exact: true }).click();
  await expectPeriod(page, "2026-10-30", "2026-11-02");
  await expect(page.getByRole("button", { name: "Rango", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /30.*oct.*2.*nov/i }).click();
  const calendar = page.getByRole("dialog", { name: "Elegir un día", exact: true });
  await calendar.getByRole("button", { name: "domingo, 1 de noviembre de 2026", exact: true }).click();
  await expectPeriod(page, "2026-11-01");
  await expect(page.getByLabel("Desde", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Día", exact: true })).toHaveAttribute("aria-current", "true");
  expect(browserErrors).toEqual([]);
});

for (const [locale, title, month, date, apply] of [
  ["en", "Choose a day", "October 2026", "Date", "View day"],
  ["pt", "Escolher um dia", "Outubro de 2026", "Data", "Ver dia"],
]) {
  test(`calendar labels and initial rendering work in ${locale}`, async ({ page }) => {
    const { browserErrors } = await fixture(page, locale);
    await page.getByTitle(title, { exact: true }).click();
    const calendar = page.getByRole("dialog", { name: title, exact: true });
    await expect(calendar.getByRole("grid", { name: month, exact: true })).toBeVisible();
    await calendar.getByLabel(date, { exact: true }).fill("2026-11-01");
    await calendar.getByRole("button", { name: apply, exact: true }).click();
    await expectPeriod(page, "2026-11-01");
    await expect(calendar).toHaveCount(0);
    expect(browserErrors).toEqual([]);
  });
}
