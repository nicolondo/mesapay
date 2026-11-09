import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

const application = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3410");
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
test.skip(!["localhost", "127.0.0.1"].includes(application.hostname) || !["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname), "Only isolated local wallet validation is allowed");
test.setTimeout(90_000);
test.use({ actionTimeout: 15_000, navigationTimeout: 60_000 });
const db = new PrismaClient();
let userId = "";
let savedConfig: Awaited<ReturnType<typeof db.platformConfig.findUnique>>;
const labels = { publicKey: "Llave pública de dispersión", privateKey: "Llave privada de dispersión" };
type Transfer = { id: string; idempotencyKey: string; accountId: string; accountLabel: string; mode: string; amountCents: number; currency: string; bankName: string; accountType: string; accountLast4: string; holderName: string; description: string; status: string; ticketNumber: string | null; providerRef: string | null; reference: string; errorCode: string | null; createdAt: string; settledAt: string | null };

async function fixture(page: Page) {
  const uuid = randomUUID();
  savedConfig = await db.platformConfig.findUnique({ where: { id: "singleton" } });
  if (savedConfig) await db.platformConfig.update({ where: { id: "singleton" }, data: { platformWalletAccountId: null } });
  const user = await db.user.create({ data: { role: "platform_admin", email: `wallet-${uuid}@example.test`, name: "Wallet test admin", passwordHash: await bcrypt.hash(uuid, 4) } });
  userId = user.id;
  await page.route(/^https?:\/\//, route => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.fallback() : route.abort());
  await page.context().addCookies([{ name: "MESAPAY_LOCALE", value: "es", domain: application.hostname, path: "/" }]);
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const login = await page.request.post("/api/auth/callback/credentials", { headers: { "X-Auth-Return-Redirect": "1" }, form: { csrfToken: csrf.csrfToken, email: user.email, password: uuid, callbackUrl: `${application.origin}/admin/wallet` } });
  expect(login.ok()).toBe(true);
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(userId);
  const transfers: Transfer[] = [];
  const submissions: Record<string, unknown>[] = [];
  let loseResponse = false;
  let balanceFails = false;
  let unknownSend = false;
  const statusRequests: unknown[] = [];
  await page.route("**/api/admin/wallet/balance", async route => {
    const config = await db.platformConfig.findUnique({ where: { id: "singleton" } });
    await route.fulfill({ status: balanceFails ? 502 : 200, json: balanceFails ? { error: "balance_failed" } : { accountId: config?.platformWalletAccountId, availableCents: 50_000_000_000, currency: "COP", queriedAt: new Date().toISOString(), balanceDate: new Date().toISOString() } });
  });
  await page.route("**/api/admin/wallet/banks", async route => {
    const config = await db.platformConfig.findUnique({ where: { id: "singleton" } });
    await route.fulfill({ json: { accountId: config?.platformWalletAccountId, banks: [{ id: "1007", name: "Bancolombia" }] } });
  });
  await page.route("**/api/admin/wallet/incoming?*", route => route.fulfill({ json: {
    accountId: new URL(route.request().url()).searchParams.get("accountId"), status: "credentials_missing", reportMode: null,
    periodStart: "2026-11-01T05:00:00.000Z", periodEnd: "2026-11-06T15:00:00.000Z",
    queriedAt: "2026-11-06T15:00:00.000Z", reportThrough: "2026-11-05",
    localCharges: [], localTruncated: false, unmatchedReportCount: 0, reportComplete: false,
  } }));
  await page.route(/\/api\/admin\/wallet\/payouts(?:\?.*)?$/, async route => {
    if (route.request().method() === "GET") {
      const key = new URL(route.request().url()).searchParams.get("idempotencyKey");
      return route.fulfill({ json: { payouts: key ? transfers.filter(t => t.idempotencyKey === key) : transfers, nextCursor: null } });
    }
    const body = route.request().postDataJSON();
    submissions.push(body);
    const existing = transfers.find(t => t.idempotencyKey === body.idempotencyKey);
    const payout: Transfer = existing ?? { id: randomUUID(), idempotencyKey: body.idempotencyKey, accountId: body.accountId, accountLabel: "Suscripciones de prueba", mode: "sandbox", amountCents: body.amountCents, currency: "COP", bankName: "Bancolombia", accountType: body.destination.accountType, accountLast4: body.destination.accountNumber.slice(-4), holderName: body.destination.holderName, description: body.description, status: "initialized", ticketNumber: "1234567890", providerRef: randomUUID(), reference: randomUUID(), errorCode: null, createdAt: new Date().toISOString(), settledAt: null };
    if (unknownSend && !existing) { payout.status = "unknown"; payout.ticketNumber = null; payout.providerRef = null; payout.errorCode = "payout_unknown"; }
    if (!existing) transfers.unshift(payout);
    if (loseResponse) { loseResponse = false; return route.abort("failed"); }
    return route.fulfill({ json: { payout } });
  });
  await page.route(/\/api\/admin\/wallet\/payouts\/[^/]+\/refresh$/, async route => {
    statusRequests.push(route.request().postDataJSON());
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    const payout = transfers.find(t => t.id === id)!;
    payout.status = "approved"; payout.settledAt = new Date().toISOString(); payout.errorCode = null;
    return route.fulfill({ json: { payout } });
  });
  await page.goto("/admin/wallet");
  await expect(page.getByRole("heading", { name: "Wallet", exact: true })).toBeVisible();
  return { submissions, transfers, statusRequests, loseNextResponse: () => { loseResponse = true; }, failBalance: (value: boolean) => { balanceFails = value; }, unknownNextSend: () => { unknownSend = true; } };
}
async function configure(page: Page) {
  const name = page.getByRole("textbox", { name: "Nombre de la cuenta", exact: true });
  await expect(name).toBeVisible();
  await name.fill("Suscripciones de prueba");
  await page.getByRole("combobox", { name: "Ambiente", exact: true }).selectOption("sandbox");
  await page.getByLabel(labels.publicKey, { exact: true }).fill("wallet-public-local-fixture");
  await page.getByLabel(labels.privateKey, { exact: true }).fill("wallet-private-local-fixture");
  const saved = page.waitForResponse(r => r.url().endsWith("/api/admin/wallet/config") && r.request().method() === "PUT");
  await page.getByRole("button", { name: "Guardar cuenta", exact: true }).click();
  expect((await saved).status()).toBe(200);
  const config = await db.platformConfig.findUniqueOrThrow({ where: { id: "singleton" }, include: { platformWalletAccount: true } });
  expect(config.platformWalletAccount?.privateKeyEnc).not.toBe("wallet-private-local-fixture");
  await expect(page.getByText("Saldo disponible para dispersar", { exact: true })).toBeVisible();
}
async function fillTransfer(page: Page) {
  await page.getByLabel("Monto (COP)", { exact: true }).fill("25000000");
  await expect(page.getByLabel("Monto (COP)", { exact: true })).toHaveValue("25.000.000");
  await page.getByRole("combobox", { name: "Banco destino", exact: true }).selectOption("1007");
  await page.getByRole("combobox", { name: "Tipo de cuenta", exact: true }).selectOption("ahorros");
  await page.getByLabel("Número de cuenta", { exact: true }).fill("123456789012");
  await page.getByRole("combobox", { name: "Tipo de documento", exact: true }).selectOption("NIT");
  await page.getByLabel("Número de documento", { exact: true }).fill("901234567");
  await page.getByLabel("Nombre del titular", { exact: true }).fill("Beneficiario sintético");
  await page.getByLabel("Concepto (opcional)", { exact: true }).fill("Pago de prueba");
  await page.getByRole("button", { name: "Revisar transferencia", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirmar transferencia", exact: true })).toBeVisible();
}

test.afterEach(async () => {
  const config = await db.platformConfig.findUnique({ where: { id: "singleton" } });
  if (config) await db.platformConfig.update({ where: { id: "singleton" }, data: { platformWalletAccountId: savedConfig?.platformWalletAccountId ?? null } });
  await db.platformPayout.deleteMany({ where: { account: { createdById: userId } } });
  await db.platformWalletAccount.deleteMany({ where: { createdById: userId } });
  await db.auditEvent.deleteMany({ where: { actorUserId: userId } });
  if (userId) await db.user.deleteMany({ where: { id: userId } });
  if (!savedConfig && config) await db.platformConfig.delete({ where: { id: "singleton" } });
});
test.afterAll(() => db.$disconnect());

test("configures a separate wallet, reviews the destination before sending and shows status history", async ({ page }, info) => {
  const h = await fixture(page);
  await configure(page);
  if (info.project.name === "desktop") {
    for (const width of [1536, 1920, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  await fillTransfer(page);
  expect(h.submissions).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath("wallet-transfer-review.png"), fullPage: true });
  await page.getByRole("button", { name: "Confirmar transferencia", exact: true }).click();
  await expect.poll(() => h.submissions.length).toBe(1);
  expect(h.submissions[0]).toMatchObject({ amountCents: 2_500_000_000, confirmed: true, destination: { bankId: "1007", accountNumber: "123456789012" } });
  await expect(page.getByRole("button", { name: "Consultar estado", exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Consultar estado", exact: true }).first().click();
  await expect(page.getByText("Aprobada", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Nueva transferencia", exact: true })).toContainText("Aprobada");
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath("wallet-history-approved.png"), fullPage: true });
});

test("recovers a lost response by its original identifier and never persists bank data or secrets in browser storage", async ({ page }, info) => {
  const h = await fixture(page);
  await configure(page); await fillTransfer(page);
  h.loseNextResponse();
  await page.getByRole("button", { name: "Confirmar transferencia", exact: true }).click();
  await expect.poll(() => h.transfers.length).toBe(1);
  await page.reload();
  await expect(page.getByRole("button", { name: "Consultar estado", exact: true }).first()).toBeVisible();
  expect(h.submissions).toHaveLength(1);
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  for (const sensitive of ["123456789012", "901234567", "wallet-private-local-fixture"]) expect(storage).not.toContain(sensitive);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath("wallet-recovered.png"), fullPage: true });
});

test("an unknown transfer becomes usable again only after its status is verified", async ({ page }, info) => {
  const h = await fixture(page);
  await configure(page); await fillTransfer(page); h.unknownNextSend();
  await page.getByRole("button", { name: "Confirmar transferencia", exact: true }).click();
  await expect(page.getByRole("button", { name: "Revisar transferencia", exact: true })).toBeDisabled();
  await page.getByLabel("Ticket Kushki (opcional)", { exact: true }).fill("7788990011");
  await page.getByRole("button", { name: "Consultar estado", exact: true }).click();
  await expect(page.getByText("Aprobada", { exact: true }).first()).toBeVisible();
  expect(h.statusRequests).toEqual([{ ticketNumber: "7788990011" }]);
  await expect(page.getByRole("button", { name: "Revisar transferencia", exact: true })).toBeEnabled();
  expect(h.submissions).toHaveLength(1);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath("wallet-ticket-recovery.png"), fullPage: true });
});

test("a balance error never shows a zero balance or allows sending with missing information", async ({ page }) => {
  const h = await fixture(page); h.failBalance(true);
  await configure(page);
  await expect(page.getByRole("alert").filter({ hasText: /saldo/ }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Revisar transferencia", exact: true })).toBeDisabled();
  expect(h.submissions).toHaveLength(0);
  h.failBalance(false);
  await page.getByRole("button", { name: "Actualizar saldo", exact: true }).click();
  await expect(page.getByRole("button", { name: "Revisar transferencia", exact: true })).toBeEnabled();
});
