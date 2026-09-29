import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import es from "../messages/es.json";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(
  !["localhost", "127.0.0.1"].includes(databaseUrl.hostname) ||
  !/^\/mesapay_.*validation$/.test(databaseUrl.pathname) ||
  !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""),
  "An isolated local app and validation database are required",
);
const db = new PrismaClient();
type Insets = { top: number; right: number; bottom: number; left: number };
const scenarios = [
  { name: "portrait safe area", width: 390, height: 844, insets: { top: 59, right: 0, bottom: 34, left: 0 } },
  { name: "landscape safe area", width: 740, height: 390, insets: { top: 0, right: 44, bottom: 21, left: 44 } },
  { name: "landscape sidebar safe area", width: 932, height: 430, insets: { top: 0, right: 44, bottom: 21, left: 44 } },
  { name: "ordinary mobile browser", width: 390, height: 844, insets: { top: 0, right: 0, bottom: 0, left: 0 } },
  { name: "ordinary desktop browser", width: 1440, height: 1000, insets: { top: 0, right: 0, bottom: 0, left: 0 } },
] as const;

async function login(page: Page, email: string, password: string, restaurantId: string) {
  await page.goto("/signin");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"));
  await page.context().addCookies([{ name: "mesapay_act_as", value: restaurantId, domain: "localhost", path: "/" }]);
}

async function setInsets(page: Page, insets: Insets) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets });
  // Check that the browser actually applies env(), rather than letting a
  // silently unsupported emulation produce a false-positive zero-inset test.
  expect(await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const measured = { top: parseFloat(style.paddingTop), right: parseFloat(style.paddingRight), bottom: parseFloat(style.paddingBottom), left: parseFloat(style.paddingLeft) };
    probe.remove();
    return measured;
  })).toEqual(insets);
}

for (const scenario of scenarios) {
  test(`operator cockpit respects ${scenario.name}`, async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "CDP safe-area emulation requires Chromium");
    test.setTimeout(60_000);
    const token = randomUUID(), password = `Safe-area-${token}`;
    const restaurant = await db.restaurant.create({ data: { name: "Panel de prueba", slug: `safe-area-${token}` } });
    const user = await db.user.create({ data: { email: `safe-area-${token}@example.test`, passwordHash: await bcrypt.hash(password, 4), role: "platform_admin" } });
    const category = await db.category.create({ data: { restaurantId: restaurant.id, label: "Productos de prueba", slug: "productos" } });
    await db.menuItem.createMany({ data: Array.from({ length: 12 }, (_, i) => ({ restaurantId: restaurant.id, categoryId: category.id, name: `Producto de prueba ${String(i).padStart(2, "0")}`, priceCents: 100000 })) });
    try {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.route(/^https?:\/\//, (route) => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
      await login(page, user.email, password, restaurant.id);
      await setInsets(page, scenario.insets);
      await page.goto("/operator");
      const shell = page.locator(".op-app-shell");
      await expect(shell).toBeVisible();
      const main = shell.locator("main");
      const mainBox = (await main.boundingBox())!;
      const isMobile = scenario.width < 768;
      if (isMobile) {
        const trigger = page.getByRole("button", { name: es.operator.openMenu, exact: true });
        await expect(trigger).toBeVisible();
        const headerBox = (await trigger.locator("..").boundingBox())!;
        const triggerBox = (await trigger.boundingBox())!;
        expect(headerBox.y).toBeCloseTo(scenario.insets.top, 0);
        expect(headerBox.height).toBeCloseTo(56, 0);
        expect(triggerBox.y).toBeGreaterThanOrEqual(scenario.insets.top);
        expect(triggerBox.x).toBeGreaterThanOrEqual(scenario.insets.left);
      } else {
        const rail = (await shell.locator(":scope > aside").boundingBox())!;
        expect(rail.x).toBeCloseTo(scenario.insets.left, 0);
        expect(rail.y).toBeCloseTo(scenario.insets.top, 0);
        expect(rail.y + rail.height).toBeLessThanOrEqual(scenario.height - scenario.insets.bottom + 1);
      }
      expect(mainBox.x).toBeGreaterThanOrEqual(scenario.insets.left);
      expect(mainBox.x + mainBox.width).toBeLessThanOrEqual(scenario.width - scenario.insets.right + 1);
      expect(mainBox.y + mainBox.height).toBeCloseTo(scenario.height - scenario.insets.bottom, 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ animations: "disabled", path: test.info().outputPath(`operator-${scenario.name.replaceAll(" ", "-")}-${scenario.width}-dashboard.png`) });

      if (isMobile) {
        await page.getByRole("button", { name: es.operator.openMenu, exact: true }).click();
        const close = page.getByRole("button", { name: es.operator.closeMenu, exact: true });
        await expect(close).toBeVisible();
        const box = (await close.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(scenario.insets.top);
        expect(box.x + box.width).toBeLessThanOrEqual(scenario.width - scenario.insets.right + 1);
        await page.screenshot({ animations: "disabled", path: test.info().outputPath(`operator-${scenario.name.replaceAll(" ", "-")}-${scenario.width}-drawer.png`) });
        await close.click();
      }

      await page.goto("/operator/menu");
      const scrollable = shell.locator("main");
      expect(await scrollable.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      await scrollable.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      const lastProduct = scrollable.getByText("Producto de prueba 11", { exact: true }).filter({ visible: true });
      await expect(lastProduct).toBeInViewport();
      const lastBox = (await lastProduct.boundingBox())!;
      expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(scenario.height - scenario.insets.bottom + 1);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await page.screenshot({ animations: "disabled", path: test.info().outputPath(`operator-${scenario.name.replaceAll(" ", "-")}-${scenario.width}-scrolled.png`) });
      await page.emulateMedia({ media: "print" });
      expect(await shell.evaluate((element) => getComputedStyle(element).padding)).toBe("0px");
      expect(await scrollable.evaluate((element) => getComputedStyle(element).overflowY)).toBe("visible");
    } finally {
      await db.restaurant.delete({ where: { id: restaurant.id } });
      await db.user.delete({ where: { id: user.id } });
    }
  });
}

test("classic operator shell reserves the same portrait safe area", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "CDP safe-area emulation requires Chromium");
  const token = randomUUID(), password = `Safe-area-${token}`;
  const restaurant = await db.restaurant.create({ data: { name: "Panel clásico", slug: `safe-classic-${token}` } });
  const user = await db.user.create({ data: { email: `safe-classic-${token}@example.test`, passwordHash: await bcrypt.hash(password, 4), role: "platform_admin" } });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route(/^https?:\/\//, (route) => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    await login(page, user.email, password, restaurant.id);
    await page.context().addCookies([{ name: "mp_shell", value: "classic", domain: "localhost", path: "/" }]);
    await setInsets(page, { top: 59, right: 0, bottom: 34, left: 0 });
    await page.goto("/operator");
    const shell = page.locator(".op-app-shell");
    await expect(shell.locator(":scope > header")).toBeVisible();
    const styles = await shell.evaluate((element) => ({ top: getComputedStyle(element).paddingTop, bottom: getComputedStyle(element).paddingBottom }));
    expect(styles).toEqual({ top: "59px", bottom: "34px" });
    const trigger = page.getByRole("button", { name: es.operator.openMenu, exact: true });
    expect((await trigger.boundingBox())!.y).toBeGreaterThanOrEqual(59);
    const main = (await shell.locator("main").boundingBox())!;
    expect(main.y + main.height).toBeLessThanOrEqual(811);
    await page.screenshot({ animations: "disabled", path: test.info().outputPath("operator-classic-390.png") });
  } finally {
    await db.restaurant.delete({ where: { id: restaurant.id } });
    await db.user.delete({ where: { id: user.id } });
  }
});

test.afterAll(() => db.$disconnect());
