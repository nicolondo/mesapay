import { test, expect, type Page, type Route } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import type { WalletIncomingView } from "../src/lib/walletIncoming/contracts";

const application = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3411");
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!["localhost", "127.0.0.1"].includes(application.hostname) || !["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname), "Wallet incoming tests require isolated local services");
test.setTimeout(90_000);
test.use({ actionTimeout: 15_000, navigationTimeout: 60_000 });
const db = new PrismaClient();
const users = new Set<string>(), restaurants = new Set<string>();
type Surface = "admin" | "operator";
const incoming = (source: "order" | "subscription" = "order"): WalletIncomingView => ({
  status: "permission_required", reportMode: "production",
  periodStart: "2026-11-02T05:00:00.000Z", periodEnd: "2026-11-09T15:00:00.000Z",
  queriedAt: "2026-11-09T15:00:00.000Z", reportThrough: "2026-11-08",
  localCharges: [
    { id: "known-charge", source, occurredAt: "2026-11-08T18:00:00.000Z", dateBasis: "payment", amountCents: 1_000_000, refundedCents: 100_000, currency: "COP" },
    { id: "unknown-currency", source, occurredAt: "2026-11-08T17:00:00.000Z", dateBasis: "payment", amountCents: 99_000_000, refundedCents: 0, currency: null },
    { id: "registration-only", source: "reservation", occurredAt: "2026-11-07T17:00:00.000Z", dateBasis: "record", amountCents: 50_000, refundedCents: 0, currency: "COP" },
  ],
  localTruncated: false, unmatchedReportCount: 0, reportComplete: false,
});
type View = WalletIncomingView;
async function captureActivity(page: Page, path: string) {
  await page.locator("#wallet-incoming").evaluate(async (section) => {
    section.scrollIntoView({ block: "start", behavior: "instant" });
    for (const id of ["admin-content", "operator-content"]) document.getElementById(id)?.scrollBy({ top: -144, behavior: "instant" });
    window.scrollBy({ top: -144, behavior: "instant" });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await page.screenshot({ path, animations: "disabled" });
}
async function fixture(page: Page, surface: Surface) {
  const uid = randomUUID();
  let restaurantId: string | null = null;
  if (surface === "operator") {
    restaurantId = (await db.restaurant.create({ data: { name: "Conciliación local de prueba", slug: "wallet-incoming-" + uid, country: "CO", kushkiMerchantId: "local-only", kushkiOnboardingStatus: "active" } })).id;
    restaurants.add(restaurantId);
  }
  const user = await db.user.create({ data: { restaurantId, role: surface === "admin" ? "platform_admin" : "operator", email: "wallet-incoming-" + uid + "@example.test", passwordHash: await bcrypt.hash(uid, 4) } });
  users.add(user.id);
  await page.route(/^https?:\/\//, route => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.fallback() : route.abort());
  const headers = { "x-real-ip": "127.9." + parseInt(uid.slice(0, 2), 16) + "." + parseInt(uid.slice(2, 4), 16) };
  await page.setExtraHTTPHeaders(headers);
  await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: "es", domain: application.hostname, path: "/" }]);
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  await page.request.post("/api/auth/callback/credentials", { headers: { ...headers, "X-Auth-Return-Redirect": "1" }, form: { csrfToken: csrf.csrfToken, email: user.email, password: uid, callbackUrl: application.origin + "/" + surface + "/wallet" } });
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(user.id);
  let view: View = incoming(surface === "admin" ? "subscription" : "order");
  let accountId = "incoming-account-a", wrongScope = false, requestFailure = false, requests = 0, payoutRequests = 0;
  const held: Route[] = [], scopes: string[] = [];
  let hold = false;
  await page.route("**/api/" + surface + "/wallet/tracking**", route => route.fulfill({ status: 503, json: { error: "tracking_unavailable" } }));
  await page.route("**/api/" + surface + "/wallet/balance", route => route.fulfill({ status: 502, json: { error: "balance_failed" } }));
  await page.route("**/api/" + surface + "/wallet/banks", route => route.fulfill({ json: { accountId, banks: [] } }));
  await page.route("**/api/" + surface + "/wallet/payouts", route => {
    if (route.request().method() !== "GET") payoutRequests++;
    return route.fulfill({ json: { payouts: [], nextCursor: null } });
  });
  await page.route("**/api/operator/wallet/disperse", route => { payoutRequests++; return route.abort(); });
  if (surface === "admin") await page.route("**/api/admin/wallet/config", async route => {
    if (route.request().method() === "PUT") accountId = "incoming-account-b";
    return route.fulfill({ json: { billingConfigured: true, account: { id: accountId, label: "Suscripciones de prueba", mode: "sandbox", publicKey: "public-local-only", hasPrivateKey: true, createdAt: "2026-11-09T15:00:00.000Z" } } });
  });
  await page.route("**/api/" + surface + "/wallet/incoming?*", async route => {
    requests++;
    const query = new URL(route.request().url()).searchParams;
    expect(query.get(surface === "admin" ? "accountId" : "restaurantId")).toBe(surface === "admin" ? accountId : restaurantId);
    scopes.push(query.get(surface === "admin" ? "accountId" : "restaurantId")!);
    if (hold && accountId === "incoming-account-a") { held.push(route); return; }
    if (requestFailure) return route.fulfill({ status: 502, json: { error: "incoming_failed" } });
    return route.fulfill({ json: { ...view, ...(surface === "admin" ? { accountId: wrongScope ? "other-account" : accountId } : { restaurantId: wrongScope ? "other-restaurant" : restaurantId }) } });
  });
  return {
    goto: async () => { await page.goto("/" + surface + "/wallet"); await page.getByText("Consultar reportes de Kushki (opcional)", { exact: true }).click(); }, setView: (value: View) => { view = value; }, getView: () => view,
    wrongScope: (value: boolean) => { wrongScope = value; }, fail: (value: boolean) => { requestFailure = value; },
    hold: () => { hold = true; }, requests: () => requests, payoutRequests: () => payoutRequests,
    heldCount: () => held.length, requestedScopes: () => scopes,
    release: async () => { for (const route of held.splice(0)) { const older = incoming("subscription"); older.localCharges[0].amountCents = 88_880_000; await route.fulfill({ json: { ...older, accountId: "incoming-account-a" } }).catch(() => {}); } },
  };
}
test.afterEach(async () => {
  if (users.size) await db.user.deleteMany({ where: { id: { in: [...users] } } });
  if (restaurants.size) await db.restaurant.deleteMany({ where: { id: { in: [...restaurants] } } });
  users.clear(); restaurants.clear();
});
test.afterAll(() => db.$disconnect());
for (const surface of ["admin", "operator"] as const) {
  test(surface + ": local charges remain visible without balance or settlement permission, and reports never claim wallet credit", async ({ page }, info) => {
    const h = await fixture(page, surface);
    await h.goto();
    const section = page.getByRole("region", { name: "Cobros de MESAPAY y conciliación", exact: true });
    await expect(section).toBeVisible();
    await expect(section).toContainText("Kushki no tiene habilitada la consulta de liquidaciones de esta cuenta.");
    await expect(section).toContainText("Reporte de producción");
    if (surface === "admin") await expect(section).toContainText("Puede ser distinta de la cuenta configurada para dispersar");
    await expect(section).toContainText("10.000");
    await expect(section).toContainText("Devolución registrada");
    const unknownCurrency = section.getByRole("listitem").filter({ hasText: "Moneda sin confirmar" });
    await expect(unknownCurrency).toContainText("Importe registrado");
    await expect(unknownCurrency).toContainText("990.000");
    await expect(unknownCurrency).not.toContainText("COP");
    await expect(unknownCurrency).not.toContainText("$");
    await expect(section).toContainText("Fecha de registro");
    await expect(page.getByText("Saldo no disponible", { exact: true }).first()).toBeVisible();
    await captureActivity(page, info.outputPath(surface + "-incoming-permission.png"));
    const matched: View = {
      ...h.getView(), status: "available", localTruncated: false, unmatchedReportCount: 2, reportComplete: true,
      localCharges: h.getView().localCharges.map((charge, index) => index === 1 ? charge : {
        ...charge, report: { grossCents: charge.amountCents, netCents: index === 0 ? 950_030 : -530, currency: "COP", paymentDate: "2026-11-08" },
      }),
    };
    h.setView(matched);
    await section.getByRole("button", { name: "Actualizar conciliación", exact: true }).click();
    await expect(section).toContainText("Neto reportado");
    await expect(section).toContainText("9.500,30");
    await expect(section.getByRole("listitem").filter({ hasText: "Cobro de reserva" })).toContainText(/-\$\s*5,30/);
    await expect(section).toContainText("Fecha informada en el reporte");
    await expect(section).toContainText("no confirma ingresos en esta wallet");
    await expect(section).toContainText("2 registros del reporte");
    expect(h.payoutRequests()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await captureActivity(page, info.outputPath(surface + "-incoming-report.png"));
    // Even an inconsistent response must not present matches when coverage is incomplete.
    h.setView({ ...matched, localTruncated: true, reportComplete: false });
    await section.getByRole("button", { name: "Actualizar conciliación", exact: true }).click();
    await expect(section).toContainText("El reporte no está completo");
    await expect(section).toContainText("Mostramos sólo una parte");
    await expect(section).not.toContainText("Neto reportado");
    await expect(section).not.toContainText("9.500,30");
    await expect(section).toContainText("10.000");
  });
  test(surface + ": rejects another scope and clears old results on refresh failure", async ({ page }) => {
    const h = await fixture(page, surface);
    h.wrongScope(true);
    await h.goto();
    const section = page.getByRole("region", { name: "Cobros de MESAPAY y conciliación", exact: true });
    await expect(section.getByRole("alert")).toContainText("La cuenta cambió");
    await expect(section).not.toContainText("10.000");
    h.wrongScope(false);
    await section.getByRole("button", { name: "Actualizar conciliación", exact: true }).click();
    await expect(section).toContainText("10.000");
    h.fail(true);
    await section.getByRole("button", { name: "Actualizar conciliación", exact: true }).click();
    await expect(section.getByRole("alert")).toContainText("No pudimos actualizar");
    await expect(section).not.toContainText("10.000");
    h.fail(false);
    for (const [status, text] of [
      ["credentials_missing", "Falta configurar la cuenta de recaudo"],
      ["unsupported", "La consulta de liquidaciones no está disponible"],
      ["unavailable", "No pudimos consultar el reporte de liquidaciones"],
    ] as const) {
      h.setView({ ...h.getView(), status, reportMode: null, localCharges: [] });
      await section.getByRole("button", { name: "Actualizar conciliación", exact: true }).click();
      await expect(section).toContainText(text);
      await expect(section).toContainText("Esto no confirma que la wallet no tenga abonos pendientes");
      await expect(section).not.toContainText("Reporte de producción");
    }
    expect(h.payoutRequests()).toBe(0);
  });
}
test("admin: changing the wallet discards an older incoming request", async ({ page }) => {
  const h = await fixture(page, "admin");
  h.hold();
  await h.goto();
  await expect.poll(h.heldCount).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Configurar cuenta de dispersión", exact: true }).click();
  await page.getByRole("textbox", { name: "Nombre de la cuenta", exact: true }).fill("Cuenta nueva de prueba");
  await page.getByRole("button", { name: "Guardar cuenta", exact: true }).click();
  await expect.poll(h.requestedScopes).toContain("incoming-account-b");
  const section = page.getByRole("region", { name: "Cobros de MESAPAY y conciliación", exact: true });
  await expect(section).toContainText("10.000");
  await h.release();
  await expect(section.getByRole("alert")).toHaveCount(0);
  await expect(section).toContainText("10.000");
  await expect(section).not.toContainText("888.800");
});
