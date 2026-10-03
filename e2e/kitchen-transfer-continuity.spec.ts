import { test, expect, type Page, type Locator } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*validation$/.test(database.pathname) || !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""), "Isolated local application and validation database required");
const db = new PrismaClient();
const fixtureTenantIds: string[] = [];
test.setTimeout(120_000);

async function fixture(station: "kitchen" | "bar") {
  const token = randomUUID(), password = `Transfer-${token}`, now = Date.now();
  const placedAt = new Date(now - 31 * 60_000 - 10_000), startedAt = new Date(now - 21 * 60_000 - 10_000), readyAt = new Date(now - 12 * 60_000 - 10_000);
  const restaurant = await db.restaurant.create({ data: { slug: `transfer-e2e-${token}`, name: "Transfer browser validation", hasBar: true, kitchenAutoFire: false, barAutoFire: false, kitchenPrintEnabled: false, barPrintEnabled: false } });
  fixtureTenantIds.push(restaurant.id);
  const admin = await db.user.create({ data: { restaurantId: restaurant.id, role: "operator", name: "Transfer administrator", email: `${token}-admin@example.test`, passwordHash: await bcrypt.hash(password, 4) } });
  const waiter = await db.user.create({ data: { restaurantId: restaurant.id, role: "mesero", name: "Original waiter", email: `${token}-waiter@example.test`, passwordHash: "fixture" } });
  const tables = await Promise.all([1, 2, 3, 4].map(number => db.table.create({ data: { restaurantId: restaurant.id, number, qrToken: randomUUID() } })));
  const category = await db.category.create({ data: { restaurantId: restaurant.id, label: "Transfer fixtures", slug: "transfer" } });
  const menuItem = await db.menuItem.create({ data: { restaurantId: restaurant.id, categoryId: category.id, name: "Transfer fixture", priceCents: 100000, prepMinutes: 120, prepStation: station } });
  const order = await db.order.create({ data: { restaurantId: restaurant.id, tableId: tables[0].id, shortCode: token, status: "in_kitchen", placedAt, subtotalCents: 300000, totalCents: 300000 } });
  const items = [];
  for (const [index, state] of (["in_kitchen", "ready", "served"] as const).entries()) {
    const round = await db.round.create({ data: { orderId: order.id, seq: index + 1, status: state, placedAt, kitchenStartedAt: startedAt, readyAt: state === "in_kitchen" ? null : readyAt, placedByUserId: waiter.id, placedByName: waiter.name, placedByRole: "mesero" } });
    items.push(await db.orderItem.create({ data: { orderId: order.id, roundId: round.id, menuItemId: menuItem.id, nameSnapshot: `${station} ${state} fixture`, qty: 1, priceCentsSnapshot: 100000, station, kitchenStatus: state === "served" ? "ready" : state, servedAt: state === "served" ? new Date(now - 5 * 60_000) : null, prepMinutesSnapshot: 120, preparationStartedAt: startedAt, preparationFirstStartedAt: startedAt } }));
  }
  return { restaurant, admin, waiter, password, tables, order, items, menuItem, placedAt, startedAt };
}

async function loginAndFakeAudio(page: Page, email: string, password: string) {
  await page.route(/^https?:\/\//, route => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    localStorage.setItem("mesapay.newOrderChime.kitchen", "on");
    localStorage.setItem("mesapay.newOrderChime.bar", "on");
    const root = window as unknown as { __transferOscillators: number };
    root.__transferOscillators = 0;
    const parameter = () => ({ setValueAtTime() {}, linearRampToValueAtTime() {} });
    class FakeAudioContext {
      state = "running";
      destination = {};
      get currentTime() { return performance.now() / 1000; }
      async resume() {}
      async close() {}
      addEventListener() {}
      removeEventListener() {}
      createOscillator() { root.__transferOscillators++; return { type: "square", frequency: parameter(), connect() {}, disconnect() {}, start() {}, stop() {}, onended: null }; }
      createGain() { return { gain: parameter(), connect() {}, disconnect() {} }; }
    }
    Object.defineProperty(window, "AudioContext", { configurable: true, value: FakeAudioContext });
  });
  await page.goto("/signin");
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(url => !url.pathname.startsWith("/signin"));
}
const soundCount = (page: Page) => page.evaluate(() => (window as unknown as { __transferOscillators: number }).__transferOscillators);
const card = (page: Page, name: string) => page.locator("li.rounded-xl.border-2:visible").filter({ hasText: name });
const column = (page: Page, label: string) => page.locator("div.font-display.text-lg:visible").filter({ hasText: new RegExp(`^${label}$`) }).locator("../..");
async function tableUpdated(page: Page, entry: Locator, number: number) {
  await expect(entry).toContainText(`Mesa ${number}`, { timeout: 15_000 });
  // Let effects for the refreshed server component commit before reading the audio probe.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

for (const station of ["kitchen", "bar"] as const) {
  test(`${station}: transfers preserve preparation, age and author without new-order sound; new items still sound`, async ({ page }) => {
    const f = await fixture(station);
    try {
      await loginAndFakeAudio(page, f.admin.email, f.password);
      await page.goto(`/operator/${station}`);
      const preparing = card(page, f.items[0].nameSnapshot), ready = card(page, f.items[1].nameSnapshot);
      await expect(preparing).toBeVisible();
      await expect(ready).toBeVisible();
      await expect(page.getByText(f.items[2].nameSnapshot, { exact: false })).toHaveCount(0);
      expect(await soundCount(page)).toBe(0);
      await page.getByRole("button", { name: "Probar sonido", exact: true }).click();
      await expect.poll(() => soundCount(page)).toBe(3);
      await page.waitForTimeout(800); // The three-beep controller intentionally suppresses overlap for 640ms.
      const baseline = await soundCount(page);
      for (const number of [2, 3]) {
        const response = await page.request.post(`/api/operator/order-items/${f.items[0].id}/move`, { data: { targetTableId: f.tables[number - 1].id } });
        expect(response.ok(), await response.text()).toBe(true);
        await tableUpdated(page, preparing, number);
        expect.soft(await soundCount(page), "A transferred item is not a newly fired item").toBe(baseline);
        await expect.soft(preparing).toContainText("Original waiter");
        await expect.soft(preparing).toContainText(/3[1-3]m/);
        await expect(column(page, station === "bar" ? "En preparación" : "En cocina")).toContainText(f.items[0].nameSnapshot);
        if (station === "bar") await expect(preparing).toContainText(/9[6-8]:[0-5][0-9]/);
      }
      const beforeWholeMove = await soundCount(page);
      const preparingItem = await db.orderItem.findUniqueOrThrow({ where: { id: f.items[0].id } });
      expect((await page.request.post(`/api/operator/orders/${preparingItem.orderId}/move`, { data: { targetTableId: f.tables[3].id } })).ok()).toBe(true);
      await tableUpdated(page, preparing, 4);
      expect.soft(await soundCount(page), "Moving the whole account also stays silent").toBe(beforeWholeMove);
      expect((await page.request.post(`/api/operator/order-items/${f.items[1].id}/move`, { data: { targetTableId: f.tables[1].id } })).ok()).toBe(true);
      await tableUpdated(page, ready, 2);
      await expect.soft(ready).toContainText(/Listo hace 1[2-4]m/);
      await expect(column(page, "Listo")).toContainText(f.items[1].nameSnapshot);
      expect.soft(await soundCount(page)).toBe(baseline);
      expect((await page.request.post(`/api/operator/order-items/${f.items[2].id}/move`, { data: { targetTableId: f.tables[1].id } })).ok()).toBe(true);
      await expect(page.getByText(f.items[2].nameSnapshot, { exact: false })).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath(`${station}-transfer-continuity.png`), fullPage: true });
      await page.waitForTimeout(800);
      const beforeNew = await soundCount(page);
      // A new line in an already visible round must ring as well (round identity is unchanged).
      await db.$transaction(async tx => {
        await tx.orderItem.create({ data: { orderId: preparingItem.orderId, roundId: preparingItem.roundId, menuItemId: f.menuItem.id, nameSnapshot: `${station} genuinely new fixture`, qty: 1, priceCentsSnapshot: 100000, station, kitchenStatus: "placed", prepMinutesSnapshot: 120 } });
        await tx.order.update({ where: { id: preparingItem.orderId }, data: { subtotalCents: { increment: 100000 }, totalCents: { increment: 100000 } } });
      });
      await expect(page.getByText(`${station} genuinely new fixture`, { exact: false }).filter({ visible: true })).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => soundCount(page), { timeout: 10_000 }).toBe(beforeNew + 3);
    } finally {
      await page.goto("about:blank");
      await db.restaurant.delete({ where: { id: f.restaurant.id } });
      await db.platformEvent.deleteMany({ where: { restaurantId: f.restaurant.id } });
    }
  });
}
test.afterAll(async () => {
  // Also clean partial fixtures if setup failed before the test acquired its result.
  await db.restaurant.deleteMany({ where: { id: { in: fixtureTenantIds } } });
  await db.platformEvent.deleteMany({ where: { restaurantId: { in: fixtureTenantIds } } });
  await db.$disconnect();
});
