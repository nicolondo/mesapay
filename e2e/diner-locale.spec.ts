import { test, expect, request, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import es from "../messages/es.json";
import en from "../messages/en.json";
import pt from "../messages/pt.json";

const application = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3411");
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(
  !["localhost", "127.0.0.1"].includes(application.hostname) ||
    !["localhost", "127.0.0.1"].includes(database.hostname) ||
    !/^\/mesapay_.*validation$/.test(database.pathname),
  "Diner language tests require an explicitly selected isolated local application and database",
);
test.setTimeout(60_000);
// A local TLS proxy mirrors production's Secure guest cookie in WebKit.
test.use({ ignoreHTTPSErrors: application.protocol === "https:" });
const db = new PrismaClient();
const messages = { es, en, pt };
type Locale = keyof typeof messages;
const restaurantIds = new Set<string>();
const translationEntityIds = new Set<string>();
const waterNames = { es: "Agua de prueba", en: "Test water", pt: "Água de teste" };

async function fixture() {
  const id = randomUUID();
  const restaurant = await db.restaurant.create({ data: { name: "Carta de idiomas", slug: `diner-locale-${id}` } });
  restaurantIds.add(restaurant.id);
  const menu = await db.menu.create({ data: { restaurantId: restaurant.id, slug: "carta", label: "Carta" } });
  const category = await db.category.create({ data: { restaurantId: restaurant.id, menuId: menu.id, label: "Bebidas", slug: "bebidas" } });
  const item = await db.menuItem.create({ data: { restaurantId: restaurant.id, categoryId: category.id, name: waterNames.es, description: "Agua mineral de prueba.", priceCents: 500000 } });
  const tables = await Promise.all([1, 2].map(number => db.table.create({ data: { restaurantId: restaurant.id, number, qrToken: randomUUID() } })));
  const content = [
    { entityType: "Menu", entityId: menu.id, field: "label", original: menu.label, en: "Menu", pt: "Cardápio" },
    { entityType: "Category", entityId: category.id, field: "label", original: category.label, en: "Drinks", pt: "Bebidas" },
    { entityType: "MenuItem", entityId: item.id, field: "name", original: item.name, en: waterNames.en, pt: waterNames.pt },
    { entityType: "MenuItem", entityId: item.id, field: "description", original: item.description!, en: "Test mineral water.", pt: "Água mineral de teste." },
  ];
  for (const entity of content) translationEntityIds.add(entity.entityId);
  await db.translation.createMany({ data: content.flatMap(entity => (["en", "pt"] as const).map(locale => ({
    entityType: entity.entityType, entityId: entity.entityId, field: entity.field, locale,
    value: entity[locale], source: "manual", sourceHash: createHash("sha1").update(entity.original).digest("hex").slice(0, 16),
  }))) });
  return { restaurant, item, tables, qr: tables.map(table => `/t/${restaurant.slug}/menu?table=${table.qrToken}`) };
}

async function prepare(context: BrowserContext) {
  await context.route(/^https?:\/\//, route =>
    ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort(),
  );
}

async function visitQr(page: Page, url: string, locale: Locale) {
  const response = await page.goto(url);
  expect(response?.ok()).toBe(true);
  // The first HTML is localized on the server, before any client correction.
  const initialLanguage = /<html[^>]*\blang="([^"]+)"/.exec(await response!.text())?.[1];
  expect(initialLanguage).toBe(locale);
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  await expect(page).toHaveURL(new URL(url, application).href);
  await expect(page.locator(".mp-locale-switcher select:visible")).toHaveValue(locale);
  return response!;
}

async function firstHtmlWithLanguages(url: string, languages: string) {
  // Browser emulation sets a single Accept-Language. A separate HTTP context
  // exercises the real QR redirect with a full preference list and no cookies.
  const client = await request.newContext({
    ignoreHTTPSErrors: application.protocol === "https:",
    extraHTTPHeaders: { "Accept-Language": languages },
  });
  try {
    let target = new URL(url, application);
    for (let redirects = 0; redirects < 5; redirects++) {
      // API requests do not use browser routing; guard each redirect explicitly.
      expect(target.origin).toBe(application.origin);
      const response = await client.get(target.href, { maxRedirects: 0 });
      if ([301, 302, 303, 307, 308].includes(response.status())) {
        const location = response.headers().location;
        expect(location).toBeTruthy();
        target = new URL(location, target);
        continue;
      }
      expect(response.status()).toBe(200);
      expect(redirects).toBeGreaterThan(0);
      expect(target.href).toBe(new URL(url, application).href);
      const initialLanguage = /<html[^>]*\blang="([^"]+)"/.exec(await response.text())?.[1];
      const cookies = (await client.storageState()).cookies;
      expect(cookies.some(cookie => cookie.name === "MESAPAY_LOCALE")).toBe(false);
      return { initialLanguage, cookies };
    }
    throw new Error("The synthetic QR did not complete its guest redirect");
  } finally {
    await client.dispose();
  }
}

async function reopenWithDeviceLanguage(browser: Browser, current: BrowserContext, locale: string, info: TestInfo) {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = info.project.use;
  return browser.newContext({
    viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, locale, baseURL: application.origin,
    ignoreHTTPSErrors: application.protocol === "https:", storageState: await current.storageState(),
  });
}

async function identify(page: Page, locale: Locale) {
  const t = messages[locale].menu;
  const dialog = page.getByRole("dialog", { name: t.whatToCallYou, exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: t.namePlaceholder, exact: true }).fill("Comensal de prueba");
  await dialog.getByRole("button", { name: t.save, exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function chooseLanguage(page: Page, locale: Locale) {
  const selector = page.locator(".mp-locale-switcher select:visible");
  await selector.selectOption(locale);
  await expect(selector).toBeEnabled();
  await expect(selector).toHaveValue(locale);
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  await expect.poll(async () => (await page.context().cookies(application.origin)).find(cookie => cookie.name === "MESAPAY_LOCALE")?.value).toBe(locale);
}

test.afterEach(async () => {
  try {
    expect(await db.order.count({ where: { restaurantId: { in: [...restaurantIds] } } })).toBe(0);
  } finally {
    await db.translation.deleteMany({ where: { entityId: { in: [...translationEntityIds] } } });
    await db.restaurant.deleteMany({ where: { id: { in: [...restaurantIds] } } });
    restaurantIds.clear();
    translationEntityIds.clear();
  }
});
test.afterAll(() => db.$disconnect());

for (const sample of [
  { device: "es-CO", header: "es-CO,es;q=0.9,en;q=0.8", expected: "es" },
  { device: "en-US", header: "en-US,en;q=0.9,es;q=0.8", expected: "en" },
  { device: "pt-BR", header: "pt-BR,pt;q=0.9,en;q=0.8", expected: "pt" },
  { device: "fr-FR", header: "fr-FR,fr;q=0.9,en;q=0.8", expected: "es" },
  { device: "de-DE", header: "de-DE,de;q=0.9,pt;q=0.8", expected: "es" },
] as const) {
  test.describe(`Device ${sample.device}`, () => {
    test.use({ locale: sample.device });
    test(`first QR opens in ${sample.expected}, including the guest redirect and initial name prompt`, async ({ page }, info) => {
      const f = await fixture();
      await prepare(page.context());
      expect((await page.context().cookies()).find(cookie => cookie.name === "MESAPAY_LOCALE")).toBeUndefined();
      const response = await visitQr(page, f.qr[0], sample.expected);
      expect((await response.request().allHeaders())["accept-language"].split(/[;,]/)[0]).toBe(sample.device);
      await expect(page.getByRole("dialog", { name: messages[sample.expected].menu.whatToCallYou, exact: true })).toBeVisible();
      await expect(page.locator(`#menu-item-${f.item.id}`)).toContainText(waterNames[sample.expected]);
      const cookies = await page.context().cookies(application.origin);
      expect(cookies.some(cookie => cookie.name === `mesapay_guest_${f.tables[0].id}`)).toBe(true);
      expect(cookies.some(cookie => cookie.name === "MESAPAY_LOCALE")).toBe(false);
      const explicitPreferences = await firstHtmlWithLanguages(f.qr[0], sample.header);
      expect(explicitPreferences.initialLanguage).toBe(sample.expected);
      expect(explicitPreferences.cookies.some(cookie => cookie.name === `mesapay_guest_${f.tables[0].id}`)).toBe(true);
      await page.screenshot({ path: info.outputPath("first-qr-language.png"), animations: "disabled" });
    });
  });
}

test.describe("Manual language preference", () => {
  test.use({ locale: "en-US" });
  test("remembers the latest choice on reload, another table and a reopened browser with another device language", async ({ page, browser }, info) => {
    const f = await fixture();
    await prepare(page.context());
    await visitQr(page, f.qr[0], "en");
    await identify(page, "en");
    await chooseLanguage(page, "pt");
    await expect(page.locator(`#menu-item-${f.item.id}`)).toContainText(waterNames.pt);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "pt");
    await chooseLanguage(page, "es");
    await expect(page.locator(`#menu-item-${f.item.id}`)).toContainText(waterNames.es);
    await visitQr(page, f.qr[1], "es");
    await expect(page.getByRole("dialog", { name: es.menu.whatToCallYou, exact: true })).toBeVisible();
    const preference = (await page.context().cookies(application.origin)).find(cookie => cookie.name === "MESAPAY_LOCALE")!;
    expect(preference).toMatchObject({ value: "es", path: "/", sameSite: "Lax" });
    expect(preference.expires).toBeGreaterThan(Date.now() / 1000 + 360 * 24 * 3600);
    const reopened = await reopenWithDeviceLanguage(browser, page.context(), "pt-BR", info);
    try {
      await prepare(reopened);
      const newPage = await reopened.newPage();
      await visitQr(newPage, f.qr[0], "es");
      await expect(newPage.locator(`#menu-item-${f.item.id}`)).toContainText(waterNames.es);
      await expect(newPage.getByRole("dialog", { name: es.menu.whatToCallYou })).toHaveCount(0);
      await newPage.screenshot({ path: info.outputPath("remembered-language.png"), animations: "disabled" });
      expect(await newPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await reopened.close();
    }
  });
});

test.describe("Automatic language remains automatic", () => {
  test.use({ locale: "pt-BR" });
  test("an invalid saved language does not override the device preference", async ({ page }) => {
    const f = await fixture();
    await prepare(page.context());
    await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: "invalid-locale", domain: application.hostname, path: "/" }]);
    await visitQr(page, f.qr[0], "pt");
    await expect(page.getByRole("dialog", { name: pt.menu.whatToCallYou, exact: true })).toBeVisible();
  });
  test("a visitor who has not chosen a language follows the next device preference on the same QR", async ({ page, browser }, info) => {
    const f = await fixture();
    await prepare(page.context());
    await visitQr(page, f.qr[0], "pt");
    expect((await page.context().cookies()).some(cookie => cookie.name === "MESAPAY_LOCALE")).toBe(false);
    const reopened = await reopenWithDeviceLanguage(browser, page.context(), "en-GB", info);
    try {
      await prepare(reopened);
      const newPage = await reopened.newPage();
      await visitQr(newPage, f.qr[0], "en");
      await expect(newPage.getByRole("dialog", { name: en.menu.whatToCallYou, exact: true })).toBeVisible();
      await expect(newPage.locator(`#menu-item-${f.item.id}`)).toContainText(waterNames.en);
      expect((await reopened.cookies()).some(cookie => cookie.name === "MESAPAY_LOCALE")).toBe(false);
    } finally {
      await reopened.close();
    }
  });
});
