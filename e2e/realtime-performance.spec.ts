import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(
  !["localhost", "127.0.0.1"].includes(database.hostname) ||
    !/^\/mesapay_.*validation$/.test(database.pathname) ||
    !/^http:\/\/localhost:/.test(process.env.PLAYWRIGHT_BASE_URL ?? ""),
  "Isolated local application and validation database required",
);
test.setTimeout(90_000);
const db = new PrismaClient();
const fixtureTenantIds: string[] = [];

type Probe = {
  sources: { readyState: number; dispatchEvent(event: Event): boolean }[];
  vibrations: number[][];
};

async function fixture() {
  const token = randomUUID();
  const password = `Performance-${token}`;
  const restaurant = await db.restaurant.create({
    data: { slug: `performance-e2e-${token}`, name: "Performance original", hasBar: true, kitchenAutoFire: false, barAutoFire: false, kitchenPrintEnabled: false, barPrintEnabled: false },
  });
  fixtureTenantIds.push(restaurant.id);
  const user = await db.user.create({
    data: { restaurantId: restaurant.id, role: "operator", email: `${token}@example.test`, name: "Performance operator", passwordHash: await bcrypt.hash(password, 4) },
  });
  const tables = await Promise.all([1, 2, 3, 4].map(number => db.table.create({
    data: { restaurantId: restaurant.id, number, label: `Performance table ${number}`, qrToken: randomUUID() },
  })));
  const category = await db.category.create({ data: { restaurantId: restaurant.id, label: "Validation dishes", slug: "validation" } });
  const menuItem = await db.menuItem.create({ data: { restaurantId: restaurant.id, categoryId: category.id, name: "Performance dish original", priceCents: 100000, prepMinutes: 30 } });
  const now = new Date();
  const order = await db.order.create({ data: { restaurantId: restaurant.id, tableId: tables[0].id, shortCode: token, status: "ready", placedAt: now, subtotalCents: 100000, totalCents: 100000 } });
  const round = await db.round.create({ data: { orderId: order.id, seq: 1, status: "ready", placedAt: now, readyAt: now, kitchenStartedAt: now } });
  const item = await db.orderItem.create({ data: { orderId: order.id, roundId: round.id, menuItemId: menuItem.id, nameSnapshot: "Performance dish original", qty: 1, priceCentsSnapshot: 100000, kitchenStatus: "ready", station: "kitchen", preparationStartedAt: now, preparationFirstStartedAt: now } });
  return { restaurant, user, password, tables, menuItem, order, item };
}

async function installProbe(page: Page) {
  // Only the event transport is simulated. Authentication, pages, server
  // components, data reads and updates all use the isolated local app/DB.
  await page.route(/^https?:\/\//, route => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    const probe: Probe = { sources: [], vibrations: [] };
    Object.defineProperty(window, "__performanceProbe", { value: probe });
    class LocalEventSource extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      readonly url: string;
      readyState = 1;
      withCredentials = false;
      constructor(url: string | URL) {
        super();
        this.url = String(url);
        probe.sources.push(this);
      }
      close() { this.readyState = 2; }
    }
    Object.defineProperty(window, "EventSource", { configurable: true, value: LocalEventSource });
    Object.defineProperty(navigator, "vibrate", { configurable: true, value: (pattern: number | number[]) => { probe.vibrations.push(Array.isArray(pattern) ? pattern : [pattern]); return true; } });
  });
}

async function login(page: Page, f: Awaited<ReturnType<typeof fixture>>) {
  await page.goto("/signin");
  await page.getByLabel("Correo", { exact: true }).fill(f.user.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(f.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(url => !url.pathname.startsWith("/signin"));
}

async function signal(page: Page, type: string, count = 1) {
  await page.evaluate(({ type, count }) => {
    const { sources } = (window as unknown as { __performanceProbe: Probe }).__performanceProbe;
    for (let i = 0; i < count; i++) {
      for (const source of sources.filter(source => source.readyState !== 2)) {
        source.dispatchEvent(type === "open" ? new Event("open") : new MessageEvent("message", { data: JSON.stringify({ type, orderId: "local-validation-event" }) }));
      }
    }
  }, { type, count });
}

function rscTraffic(page: Page) {
  const requests: { pathname: string; prefetch: boolean }[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (request.method() === "GET" && (request.headers().rsc === "1" || url.searchParams.has("_rsc"))) {
      requests.push({ pathname: url.pathname, prefetch: request.headers()["next-router-prefetch"] === "1" });
    }
  });
  return requests;
}

for (const surface of ["dashboard", "kitchen", "serve", "menu"] as const) {
  test(`${surface}: connection and 100 event burst keep the latest data with one refresh each`, async ({ page }) => {
    const f = await fixture();
    try {
      await installProbe(page);
      if (surface !== "menu") await login(page, f);
      const path = surface === "dashboard" ? "/operator" : surface === "menu" ? `/t/${f.restaurant.slug}/menu` : `/operator/${surface}`;
      const url = surface === "menu" ? `${path}?table=${f.tables[0].qrToken}` : path;
      const requests = rscTraffic(page);
      await page.goto(url);
      if (surface === "menu") {
        const dialog = page.getByRole("dialog");
        await dialog.getByRole("textbox").fill("Performance diner");
        await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
      }
      await expect.poll(() => page.evaluate(() => (window as unknown as { __performanceProbe: Probe }).__performanceProbe.sources.length)).toBeGreaterThan(0);
      const visible = (name: string) => page.getByText(name, { exact: surface === "dashboard" }).filter({ visible: true }).first();
      await expect(visible(surface === "dashboard" ? f.restaurant.name : f.item.nameSnapshot)).toBeVisible();
      const refreshes = () => requests.filter(request => request.pathname === path && !request.prefetch).length;
      const beforeConnect = refreshes();
      await signal(page, "open");
      await expect.poll(refreshes).toBeGreaterThan(beforeConnect);
      // A hello received after the open callback must not request the same page again.
      await page.waitForTimeout(100);
      await signal(page, "hello");
      await page.waitForTimeout(500);
      const connectionRefreshes = refreshes() - beforeConnect;
      expect.soft(connectionRefreshes, "open catches up once; hello is only a transport handshake").toBe(1);

      const updateName = async (name: string) => {
        if (surface === "dashboard") await db.restaurant.update({ where: { id: f.restaurant.id }, data: { name } });
        else if (surface === "menu") await db.menuItem.update({ where: { id: f.menuItem.id }, data: { name } });
        else await db.orderItem.update({ where: { id: f.item.id }, data: { nameSnapshot: name } });
      };
      await updateName("Performance intermediate");
      const beforeBurst = refreshes();
      const burstStarted = Date.now();
      // Five separate browser tasks ensure this catches request bursts that
      // React's same-task coalescing would otherwise hide. The final mutation
      // lands after the first event, catching leading-edge throttle data loss.
      for (let batch = 0; batch < 5; batch++) {
        if (batch === 3) await updateName("Performance final");
        await signal(page, "order.updated", 20);
        await page.waitForTimeout(30);
      }
      const burstDurationMs = Date.now() - burstStarted;
      expect.soft(burstDurationMs, "The fixture must emit its burst within the 250ms grouping window").toBeLessThan(250);
      await expect.soft(visible("Performance final")).toBeVisible({ timeout: 5000 });
      await page.waitForTimeout(500);
      const burstRefreshes = refreshes() - beforeBurst;
      expect.soft(burstRefreshes, "100 events within one batch window need one current-page request").toBe(1);

      // Native EventSource reconnects reuse the object: every open, not only
      // visibility reopening, must catch changes missed while disconnected.
      await updateName("Performance reconnect");
      const beforeReconnect = refreshes();
      await signal(page, "open");
      await expect(visible("Performance reconnect")).toBeVisible({ timeout: 5000 });
      await page.waitForTimeout(400);
      expect.soft(refreshes() - beforeReconnect).toBe(1);

      // Simulate a tab becoming hidden while its batching timer is pending.
      // Visibility itself is controlled; the real hook must close its source,
      // cancel the pending refresh and reconnect/catch up when shown again.
      await updateName("Performance hidden final");
      const beforeHidden = refreshes();
      await signal(page, "order.updated");
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.waitForTimeout(400);
      expect.soft(refreshes() - beforeHidden, "Hidden pages must not execute pending refresh work").toBe(0);
      expect(await page.evaluate(() => (window as unknown as { __performanceProbe: Probe }).__performanceProbe.sources.every(source => source.readyState === 2))).toBe(true);
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      const beforeVisible = refreshes();
      await signal(page, "open");
      await expect(visible("Performance hidden final")).toBeVisible({ timeout: 5000 });
      await page.waitForTimeout(400);
      expect.soft(refreshes() - beforeVisible, "Returning to a tab catches up exactly once").toBe(1);

      if (surface === "serve") {
        await signal(page, "order.ready");
        expect(await page.evaluate(() => (window as unknown as { __performanceProbe: Probe }).__performanceProbe.vibrations)).toContainEqual([120, 60, 120]);
      }
      console.log(JSON.stringify({ surface, connectionRefreshes, burstRefreshes, burstDurationMs }));
      await test.info().attach("refresh-counts", { body: JSON.stringify({ surface, connectionRefreshes, burstRefreshes, burstDurationMs, requests }, null, 2), contentType: "application/json" });
    } finally {
      await page.goto("about:blank");
      await db.restaurant.delete({ where: { id: f.restaurant.id } });
      await db.platformEvent.deleteMany({ where: { restaurantId: f.restaurant.id } });
    }
  });
}

test("table overview does not preload unopened menus or staff screens", async ({ page }) => {
  const f = await fixture();
  try {
    await installProbe(page);
    await login(page, f);
    const requests = rscTraffic(page);
    await page.goto("/operator/tables");
    await expect(page.getByText("Performance table 2", { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await page.waitForTimeout(1200); // Allow Next's viewport-prefetch queue to drain.
    const unrequested = () => requests.filter(request => request.pathname !== "/operator/tables");
    const initialUnrequested = unrequested().length;
    await signal(page, "open");
    await signal(page, "order.updated", 100);
    await page.waitForTimeout(1000);
    console.log(JSON.stringify({ surface: "tables", initialUnrequested, totalUnrequested: unrequested().length, requests }));
    await test.info().attach("table-rsc-requests", { body: JSON.stringify({ initialUnrequested, requests }, null, 2), contentType: "application/json" });
    expect(unrequested(), "Viewing/updating the floor must not load each table's entire menu or every navigation destination").toEqual([]);
    // Explicit navigation remains available once speculative requests are disabled.
    await page.getByRole("link", { name: /Cocina/ }).first().click();
    await expect(page).toHaveURL(/\/operator\/kitchen$/);
    await expect(page.getByText(f.item.nameSnapshot, { exact: false }).filter({ visible: true }).first()).toBeVisible();
  } finally {
    await page.goto("about:blank");
    await db.restaurant.delete({ where: { id: f.restaurant.id } });
    await db.platformEvent.deleteMany({ where: { restaurantId: f.restaurant.id } });
  }
});

test.afterAll(async () => {
  await db.restaurant.deleteMany({ where: { id: { in: fixtureTenantIds } } });
  await db.platformEvent.deleteMany({ where: { restaurantId: { in: fixtureTenantIds } } });
  await db.$disconnect();
});
