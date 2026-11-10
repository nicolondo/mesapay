import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

const application = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3411");
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!["localhost", "127.0.0.1"].includes(application.hostname) || !["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname), "Wallet balance tests require isolated local services");
test.setTimeout(90_000);
test.use({ actionTimeout: 15_000, navigationTimeout: 60_000 });
const db = new PrismaClient();
let restaurantId: string | null = null;
let userId: string | null = null;
type Surface = "admin" | "operator";
type Balance = { availableCents: number; pendingCents?: number | null; pendingStatus?: "reported" | "not_reported" | "unavailable"; pendingUpdatedAt?: string | null };

async function captureAtTop(page: Page, path: string) {
  await page.evaluate(async () => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    for (const id of ["admin-content", "operator-content"]) {
      document.getElementById(id)?.scrollTo({ top: 0, left: 0, behavior: "instant" });
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
}

async function fixture(page: Page, surface: Surface, initial: Balance) {
  const uid = randomUUID();
  if (surface === "operator") restaurantId = (await db.restaurant.create({ data: {
    name: "Wallet pending fixture", slug: `wallet-pending-${uid}`, country: "CO",
    kushkiMerchantId: "local-wallet-only", kushkiOnboardingStatus: "active",
    bankInfo: { bankName: "Banco de prueba", accountNumber: "123456789", accountType: "ahorros", holderName: "Fixture" },
  } })).id;
  const user = await db.user.create({ data: { email: `wallet-pending-${uid}@example.test`, role: surface === "admin" ? "platform_admin" : "operator", restaurantId, passwordHash: await bcrypt.hash(uid, 4) } });
  userId = user.id;
  await page.route(/^https?:\/\//, route => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.fallback() : route.abort());
  await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: "es", domain: application.hostname, path: "/" }]);
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const login = await page.request.post("/api/auth/callback/credentials", { headers: { "X-Auth-Return-Redirect": "1" }, form: { csrfToken: csrf.csrfToken, email: user.email, password: uid, callbackUrl: `${application.origin}/${surface}/wallet` } });
  expect(login.ok()).toBe(true);
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(userId);
  let current = initial;
  let requests = 0;
  let balanceFailed = false;
  let payouts = 0;
  let trackingStatus: "active" | "unavailable" = "active";
  let estimate: number | null = 12_500_000;
  await page.route(`**/api/${surface}/wallet/tracking**`, route => route.fulfill({ json: {
    accountId: "wallet-pending-account", restaurantId, trackingId: "local-tracking", trackingKey: "local-key", mode: "sandbox", currency: "COP",
    startedAt: "2026-11-10T15:00:00Z", excludesEarlier: true, baselineAvailableCents: 45_000_000, openingPendingCents: 0,
    snapshotAt: "2026-11-10T15:05:00Z", lastComparedAt: "2026-11-10T15:05:00Z", status: trackingStatus,
    estimatedPendingCents: estimate, signedDifferenceCents: estimate, totals: { chargesCents: estimate ?? 0, refundsCents: 0, registeredFeesCents: 0, effectiveOutgoingCents: 0, adjustmentsCents: 0, incorporatedHistoryCents: 0 }, ambiguousOutgoingCount: 0, excludedSourceCount: 0, reasons: [],
  } }));
  await page.route(`**/api/${surface}/wallet/balance`, async route => {
    requests++;
    if (balanceFailed) return route.fulfill({ status: 502, json: { error: "balance_failed" } });
    await route.fulfill({ json: { accountId: "wallet-pending-account", currency: "COP", onboarded: true, queriedAt: "2026-11-06T15:00:00.000Z", balanceDate: null, ...current } });
  });
  await page.route(`**/api/${surface}/wallet/banks`, route => route.fulfill({ json: { accountId: "wallet-pending-account", banks: [{ id: "1007", name: "Banco de prueba" }] } }));
  await page.route(`**/api/${surface}/wallet/payouts`, route => {
    if (route.request().method() !== "GET") payouts++;
    return route.fulfill({ json: { payouts: [], nextCursor: null } });
  });
  await page.route(`**/api/${surface}/wallet/incoming?*`, route => route.fulfill({ json: {
    accountId: "wallet-pending-account", restaurantId, status: "credentials_missing", reportMode: null,
    periodStart: "2026-11-01T05:00:00.000Z", periodEnd: "2026-11-06T15:00:00.000Z",
    queriedAt: "2026-11-06T15:00:00.000Z", reportThrough: "2026-11-05",
    localCharges: [], localTruncated: false, unmatchedReportCount: 0, reportComplete: false,
  } }));
  await page.route("**/api/operator/wallet/disperse", route => { payouts++; return route.fulfill({ status: 409, json: { error: "test_no_real_payout" } }); });
  if (surface === "admin") await page.route("**/api/admin/wallet/config", route => route.fulfill({ json: { account: { id: "wallet-pending-account", label: "Suscripciones de prueba", mode: "sandbox", publicKey: "local-public-fixture", hasPrivateKey: true, createdAt: "2026-11-06T15:00:00.000Z" }, billingConfigured: true } }));
  await page.goto(`/${surface}/wallet`);
  await expect.poll(() => requests).toBeGreaterThan(0);
  return { setEstimate: (value: number | null) => { estimate = value; trackingStatus = value === null ? "unavailable" : "active"; }, setBalance: (value: Balance) => { current = value; }, requests: () => requests, failBalance: (value: boolean) => { balanceFailed = value; }, payouts: () => payouts };
}

test.afterEach(async () => {
  if (userId) await db.user.deleteMany({ where: { id: userId } });
  if (restaurantId) await db.restaurant.deleteMany({ where: { id: restaurantId } });
  userId = null; restaurantId = null;
});
test.afterAll(() => db.$disconnect());

for (const surface of ["admin", "operator"] as const) {
  test(`${surface}: local estimate stays independent of legacy provider fields and balance failures`, async ({ page }, info) => {
    const h = await fixture(page, surface, { availableCents: 45_000_000, pendingCents: 99_000_000, pendingStatus: "reported", pendingUpdatedAt: "2026-11-06T14:30:00Z" });
    const pending = page.getByRole("region", { name: "Pendiente estimado por ingresar", exact: true });
    const tracking = page.getByRole("region", { name: "Seguimiento de cobros", exact: true });
    await expect(pending).toContainText("125.000,00"); await expect(pending).not.toContainText("990.000");
    await expect(pending).toContainText("No disponible para dispersar");
    await expect(page.getByText(/\$\s*450[.,]000/, { exact: true }).first()).toBeVisible();
    h.setBalance({ availableCents: 45_000_000, pendingCents: null, pendingStatus: "unavailable" });
    await page.getByRole("button", { name: "Actualizar saldo", exact: true }).click(); await expect(pending).toContainText("125.000,00");
    h.setEstimate(0); await tracking.getByRole("button", { name: "Actualizar seguimiento", exact: true }).click(); await expect(pending).toContainText(/\$\s*0,00/);
    h.setEstimate(null); await tracking.getByRole("button", { name: "Actualizar seguimiento", exact: true }).click(); await expect(pending).toContainText("No disponible"); await expect(pending).not.toContainText(/\$\s*0/);
    await expect(page.getByText(/\$\s*450[.,]000/, { exact: true }).first()).toBeVisible();
    h.setEstimate(12_500_000); await tracking.getByRole("button", { name: "Actualizar seguimiento", exact: true }).click();
    h.failBalance(true); await page.getByRole("button", { name: "Actualizar saldo", exact: true }).click();
    await expect(pending).toContainText("125.000,00"); await expect(page.getByText("Saldo no disponible", { exact: true }).first()).toBeVisible();
    if (surface === "admin") await expect(page.getByRole("button", { name: "Revisar transferencia", exact: true })).toBeDisabled();
    else await expect(page.getByRole("button", { name: "Transferir a otra cuenta", exact: true })).toBeDisabled();
    expect(h.payouts()).toBe(0); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await captureAtTop(page, info.outputPath(`${surface}-estimate-independent.png`));
  });
  test(`${surface}: a positive estimate never becomes available payout funds`, async ({ page }, info) => {
    const h = await fixture(page, surface, { availableCents: 0, pendingCents: 99_000_000, pendingStatus: "reported", pendingUpdatedAt: null });
    const pending = page.getByRole("region", { name: "Pendiente estimado por ingresar", exact: true });
    await expect(pending).toContainText("125.000,00"); await expect(pending).not.toContainText("990.000");
    if (surface === "admin") await expect(page.getByRole("button", { name: "Revisar transferencia", exact: true })).toBeDisabled();
    else { await expect(page.getByRole("button", { name: "Pasar al banco", exact: true })).toBeDisabled(); await expect(page.getByRole("button", { name: "Transferir a otra cuenta", exact: true })).toBeDisabled(); }
    expect(h.payouts()).toBe(0); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await captureAtTop(page, info.outputPath(`${surface}-estimate-not-spendable.png`));
  });
}
