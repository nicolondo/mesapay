import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { decrypt } from "../src/lib/crypto";
import { GET as getConfig, PUT as setConfig } from "../src/app/api/admin/wallet/config/route";
import { GET as getBalance } from "../src/app/api/admin/wallet/balance/route";
import { GET as getBanks } from "../src/app/api/admin/wallet/banks/route";
import { GET as listPayouts, POST as sendPayout } from "../src/app/api/admin/wallet/payouts/route";
import { POST as refreshPayout } from "../src/app/api/admin/wallet/payouts/[id]/refresh/route";
import { POST as receiveWebhook } from "../src/app/api/webhooks/kushki-platform-payout/[id]/route";

const session = vi.hoisted(() => {
  process.env.MESAPAY_SECRET_KEY = "ab".repeat(32);
  process.env.APP_PUBLIC_BASE_URL = "http://localhost:3410";
  return { role: "platform_admin" as string | null, userId: "wallet-integration-admin", email: "wallet-admin@example.test" };
});
vi.mock("../src/auth", () => ({ auth: async () => session.role ? { user: { id: session.userId, email: session.email, role: session.role } } : null }));
vi.mock("../src/lib/rateLimit", () => ({ rateLimit: async () => true }));
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) throw new Error("Isolated local test database required");

const json = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST", headers: Record<string, string> = {}) => new Request(`http://localhost${path}`, {
  method, headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json", ...headers },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const configInput = { label: "MESAPAY integración", mode: "sandbox", publicKey: "platform-wallet-public-test", privateKey: "platform-wallet-private-test" };
const destination = { bankId: "1007", accountType: "ahorros", accountNumber: "123456789012", docType: "NIT", docNumber: "901234567", holderName: "Beneficiario sintético" };
const fetchMock = vi.fn<typeof fetch>();
let accountId = "";
let priorConfig: Awaited<ReturnType<typeof db.platformConfig.findUnique>>;
let nextTicket = 0;
let initBehavior: "ok" | "timeout" | "reject" = "ok";
let onInit: ((body: Record<string, unknown>) => Promise<void>) | null = null;
let statusBody: Record<string, unknown> = {};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function payoutInput(overrides: Record<string, unknown> = {}) {
  return { accountId, idempotencyKey: randomUUID(), amountCents: 2_500_000_000, destination, description: "Pago de prueba", confirmed: true, ...overrides };
}
async function send(body: ReturnType<typeof payoutInput>) { return sendPayout(json("/api/admin/wallet/payouts", body)); }
async function configure(overrides: Record<string, unknown> = {}) {
  const res = await setConfig(json("/api/admin/wallet/config", { ...configInput, ...overrides }, "PUT"));
  expect(res.status).toBe(200);
  const body = await res.json();
  accountId = body.account.id;
  return body;
}
function providerCalls(path: string) { return fetchMock.mock.calls.filter(([input]) => String(input).includes(path)); }
function statusFor(payout: { ticketNumber: string; providerRef: string; reference: string; amountCents: number }, status = "APPROVAL") {
  return { ticketNumber: payout.ticketNumber, transactionReference: payout.providerRef, transactionStatus: status, totalAmount: payout.amountCents / 100, currency: "COP", bankId: "1007", transactionType: "PAYOUT", metadata: { reference: payout.reference } };
}

beforeAll(async () => {
  priorConfig = await db.platformConfig.findUnique({ where: { id: "singleton" } });
  await db.platformConfig.upsert({ where: { id: "singleton" }, create: { id: "singleton", kushkiMode: "mock" }, update: { platformWalletAccountId: null } });
  vi.stubGlobal("fetch", fetchMock);
});
beforeEach(async () => {
  session.role = "platform_admin"; initBehavior = "ok"; onInit = null; statusBody = {};
  await db.platformConfig.update({ where: { id: "singleton" }, data: { platformWalletAccountId: null } });
  await db.auditEvent.deleteMany({ where: { targetType: { in: ["platform_payout", "platform_wallet_account"] } } });
  await db.platformPayout.deleteMany({});
  await db.platformWalletAccount.deleteMany({});
  fetchMock.mockReset().mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.startsWith("https://api-uat.kushkipagos.com/") && !url.startsWith("https://api.kushkipagos.com/")) throw new Error("Unexpected external request blocked");
    if (url.endsWith("/merchant/balance")) return reply({ currentBalance: 500_000_000, currency: "COP", balanceDate: 1793952000000 });
    if (url.endsWith("/bankList")) return reply([{ code: "1007", name: "Bancolombia" }]);
    if (url.endsWith("/tokens")) return reply({ token: `token-${randomUUID()}` }, 201);
    if (url.endsWith("/init")) {
      const body = JSON.parse(String(init?.body));
      if (onInit) await onInit(body);
      if (initBehavior === "timeout") throw new DOMException("Simulated timeout", "TimeoutError");
      if (initBehavior === "reject") return reply({ code: "TEST_DECLINED", message: "secret-provider-detail" }, 400);
      return reply({ status: "INITIALIZED", ticketNumber: String(++nextTicket), transactionReference: randomUUID() }, 201);
    }
    if (url.includes("/transaction/")) return reply(statusBody);
    throw new Error(`Unexpected provider path ${new URL(url).pathname}`);
  });
});
afterAll(async () => {
  await db.platformConfig.update({ where: { id: "singleton" }, data: { platformWalletAccountId: null } });
  await db.auditEvent.deleteMany({ where: { targetType: { in: ["platform_payout", "platform_wallet_account"] } } });
  await db.platformPayout.deleteMany({});
  await db.platformWalletAccount.deleteMany({});
  await db.auditEvent.deleteMany({ where: { actorUserId: session.userId } });
  if (priorConfig) await db.platformConfig.update({ where: { id: "singleton" }, data: priorConfig });
  else await db.platformConfig.delete({ where: { id: "singleton" } });
  vi.unstubAllGlobals();
  await db.$disconnect();
});

describe("platform wallet API with PostgreSQL and simulated Kushki transport", () => {
  it("requires platform administrator for every wallet endpoint and rejects cross-origin writes", async () => {
    for (const role of [null, "operator", "group_admin", "mesero", "chef"]) {
      session.role = role;
      const results = await Promise.all([
        getConfig(json("/api/admin/wallet/config")), setConfig(json("/api/admin/wallet/config", configInput, "PUT")),
        getBalance(json("/api/admin/wallet/balance")), getBanks(json("/api/admin/wallet/banks")),
        listPayouts(json("/api/admin/wallet/payouts")), send(payoutInput()),
        refreshPayout(json("/api/admin/wallet/payouts/no-access/refresh", {}), params("no-access")),
      ]);
      for (const result of results) expect([401, 403]).toContain(result.status);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    session.role = "platform_admin";
    const denied = await setConfig(json("/api/admin/wallet/config", configInput, "PUT", { origin: "https://other.invalid" }));
    expect(denied.status).toBe(403);
  });

  it("stores private credentials encrypted and preserves subscription billing configuration", async () => {
    const before = await db.platformConfig.findUniqueOrThrow({ where: { id: "singleton" } });
    const body = await configure();
    expect(JSON.stringify(body)).not.toContain(configInput.privateKey);
    const stored = await db.platformWalletAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(stored.privateKeyEnc).not.toBe(configInput.privateKey);
    expect(decrypt(stored.privateKeyEnc)).toBe(configInput.privateKey);
    const after = await db.platformConfig.findUniqueOrThrow({ where: { id: "singleton" } });
    expect(after.kushkiBillingPrivateKeyEnc).toBe(before.kushkiBillingPrivateKeyEnc);
    expect(after.kushkiBillingPublicKey).toBe(before.kushkiBillingPublicKey);
    expect(after.kushkiMode).toBe(before.kushkiMode);
    const fetched = await (await getConfig(json("/api/admin/wallet/config"))).json();
    expect(JSON.stringify(fetched)).not.toContain(stored.privateKeyEnc);
    expect(JSON.stringify(fetched)).not.toContain(stored.webhookSecretEnc);
  });

  it("queries the configured wallet and its environment without consulting merchant credentials", async () => {
    await configure({ mode: "production" });
    const balance = await (await getBalance(json("/api/admin/wallet/balance"))).json();
    expect(balance).toMatchObject({ accountId, availableCents: 50_000_000_000, currency: "COP" });
    const call = providerCalls("/merchant/balance")[0];
    expect(call[0]).toBe("https://api.kushkipagos.com/wallet/v1/merchant/balance");
    expect(new Headers(call[1]?.headers).get("Private-Merchant-Id")).toBe(configInput.privateKey);
    const banks = await (await getBanks(json("/api/admin/wallet/banks"))).json();
    expect(banks.banks).toEqual([{ id: "1007", name: "Bancolombia" }]);
  });

  it("persists before sending, supports larger than PostgreSQL Int amounts, masks PII and replays one operation", async () => {
    await configure();
    const body = payoutInput();
    onInit = async () => {
      expect(await db.platformPayout.count({ where: { idempotencyKey: body.idempotencyKey } })).toBe(1);
    };
    const sent = await send(body);
    expect(sent.ok).toBe(true);
    const first = (await sent.json()).payout;
    expect(first.status).toBe("initialized");
    expect(first.amountCents).toBe(2_500_000_000);
    expect(first.accountLast4).toBe("9012");
    const row = await db.platformPayout.findUniqueOrThrow({ where: { id: first.id } });
    const serialized = JSON.stringify(row, (_key, value) => typeof value === "bigint" ? String(value) : value);
    expect(serialized).not.toContain(destination.accountNumber);
    expect(serialized).not.toContain(destination.docNumber);
    const second = await send(body);
    expect((await second.json()).payout.id).toBe(first.id);
    expect(providerCalls("/init")).toHaveLength(1);
    const conflict = await send({ ...body, amountCents: body.amountCents + 100 });
    expect(conflict.status).toBe(409);
    const search = await (await listPayouts(json(`/api/admin/wallet/payouts?idempotencyKey=${body.idempotencyKey}`))).json();
    expect(search.payouts.map((p: { id: string }) => p.id)).toEqual([first.id]);
  });

  it("prevents concurrent duplicate provider sends with the same idempotency key", async () => {
    await configure();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    onInit = async () => { entered(); await gate; };
    const body = payoutInput();
    const first = send(body);
    await ready;
    const second = await send(body);
    release();
    const a = await (await first).json();
    const b = await second.json();
    expect(b.payout.id).toBe(a.payout.id);
    expect(providerCalls("/init")).toHaveLength(1);
  });

  it("keeps an ambiguous send unknown and rejects attempts to create a second transfer", async () => {
    await configure(); initBehavior = "timeout";
    const body = payoutInput();
    const payout = (await (await send(body)).json()).payout;
    expect(payout.status).toBe("unknown");
    await send(body);
    expect(providerCalls("/init")).toHaveLength(1);
    const another = await send(payoutInput());
    expect(another.status).toBe(409);
    expect(providerCalls("/init")).toHaveLength(1);
    const text = JSON.stringify(payout);
    expect(text).not.toContain(configInput.privateKey);
    expect(text).not.toContain("Simulated timeout");
  });

  it("checks confirmation, amount, bank and account version before submitting", async () => {
    await configure();
    for (const input of [payoutInput({ confirmed: false }), payoutInput({ amountCents: 99_999 }), payoutInput({ amountCents: 1.2 }), payoutInput({ amountCents: Number.MAX_SAFE_INTEGER })]) {
      expect((await send(input)).status).toBe(400);
    }
    expect((await send(payoutInput({ accountId: "old-account" }))).status).toBe(409);
    const invalidBank = await send(payoutInput({ destination: { ...destination, bankId: "not-a-bank" } }));
    expect(invalidBank.status).toBe(200);
    expect((await invalidBank.json()).payout).toMatchObject({ status: "failed", errorCode: "invalid_bank" });
    expect(providerCalls("/init")).toHaveLength(0);
  });

  it("rejects forged callbacks, verifies status with the stored account and never trusts webhook approval", async () => {
    await configure();
    const payout = (await (await send(payoutInput())).json()).payout;
    const path = `/api/webhooks/kushki-platform-payout/${payout.id}`;
    const forged = await receiveWebhook(json(path, { status: "APPROVAL", ticketNumber: payout.ticketNumber }), params(payout.id));
    expect([401, 403]).toContain(forged.status);
    expect(providerCalls("/transaction/")).toHaveLength(0);
    const account = await db.platformWalletAccount.findUniqueOrThrow({ where: { id: accountId } });
    statusBody = statusFor(payout, "DECLINED");
    const checked = await receiveWebhook(json(path, { status: "APPROVAL", ticketNumber: payout.ticketNumber }, "POST", { authorization: `Bearer ${decrypt(account.webhookSecretEnc)}` }), params(payout.id));
    expect(checked.ok).toBe(true);
    expect((await db.platformPayout.findUniqueOrThrow({ where: { id: payout.id } })).status).toBe("declined");
  });

  it("keeps historical payouts bound to their old account after configuration rotates", async () => {
    await configure();
    const payout = (await (await send(payoutInput())).json()).payout;
    const oldId = accountId;
    await configure({ publicKey: "new-public", privateKey: "new-private" });
    expect(accountId).not.toBe(oldId);
    statusBody = statusFor(payout);
    const checked = await refreshPayout(json(`/api/admin/wallet/payouts/${payout.id}/refresh`, {}), params(payout.id));
    expect(checked.ok).toBe(true);
    expect((await checked.json()).payout.status).toBe("approved");
    const call = providerCalls("/transaction/")[0];
    expect(new Headers(call[1]?.headers).get("Private-Merchant-Id")).toBe(configInput.privateKey);
  });

  it("recovers an unknown payment only with an official ticket correlated to the original reference", async () => {
    await configure(); initBehavior = "timeout";
    const payout = (await (await send(payoutInput())).json()).payout;
    const path = `/api/admin/wallet/payouts/${payout.id}/refresh`;
    statusBody = statusFor({ ...payout, ticketNumber: "official-778", providerRef: "provider-778" });
    statusBody.metadata = { reference: "unrelated-payment" };
    expect((await refreshPayout(json(path, { ticketNumber: "official-778" }), params(payout.id))).status).toBe(409);
    expect((await db.platformPayout.findUniqueOrThrow({ where: { id: payout.id } })).status).toBe("unknown");
    statusBody.metadata = { reference: payout.reference };
    const matched = await refreshPayout(json(path, { ticketNumber: "official-778" }), params(payout.id));
    expect(matched.status).toBe(200);
    expect((await matched.json()).payout).toMatchObject({ status: "approved", ticketNumber: "official-778" });
    expect(providerCalls("/init")).toHaveLength(1);
  });

  it("cannot bypass an unknown transfer by rotating the wallet configuration", async () => {
    await configure(); initBehavior = "timeout";
    const input = payoutInput();
    const original = (await (await send(input)).json()).payout;
    await configure({ publicKey: "rotation-public", privateKey: "rotation-private" });
    expect((await send(payoutInput())).status).toBe(409);
    const replay = await (await send(input)).json();
    expect(replay.payout.id).toBe(original.id);
    expect(providerCalls("/init")).toHaveLength(1);
  });

  it("fails closed on unreadable credentials without falling back to subscription credentials", async () => {
    await configure();
    await db.platformWalletAccount.update({ where: { id: accountId }, data: { privateKeyEnc: "invalid-envelope" } });
    const balance = await getBalance(json("/api/admin/wallet/balance"));
    expect(balance.status).toBe(503);
    expect(await balance.json()).toMatchObject({ error: "credentials_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not regress an approval delivered by a verified callback before init returns", async () => {
    await configure();
    const body = payoutInput();
    onInit = async (init) => {
      const row = await db.platformPayout.findUniqueOrThrow({ where: { idempotencyKey: body.idempotencyKey } });
      const account = await db.platformWalletAccount.findUniqueOrThrow({ where: { id: row.accountId } });
      statusBody = statusFor({ ticketNumber: "early-333", providerRef: "early-provider", reference: row.reference, amountCents: body.amountCents });
      expect(init.metadata).toEqual({ reference: row.reference });
      const received = await receiveWebhook(json(`/api/webhooks/kushki-platform-payout/${row.id}`, { ticketNumber: "early-333" }, "POST", { authorization: `Bearer ${decrypt(account.webhookSecretEnc)}` }), params(row.id));
      expect(received.status).toBe(200);
    };
    const payout = (await (await send(body)).json()).payout;
    expect(payout).toMatchObject({ status: "approved", ticketNumber: "early-333", providerRef: "early-provider" });
    expect(providerCalls("/init")).toHaveLength(1);
  });

  it("recovers an expired pre-init reservation but never releases a possibly sent payment", async () => {
    await configure();
    const input = payoutInput();
    initBehavior = "timeout";
    const sent = (await (await send(input)).json()).payout;
    await db.platformPayout.update({ where: { id: sent.id }, data: { status: "submitting", submissionLeaseUntil: new Date(0) } });
    const refresh = () => refreshPayout(json(`/api/admin/wallet/payouts/${sent.id}/refresh`, {}), params(sent.id));
    await refresh();
    expect((await db.platformPayout.findUniqueOrThrow({ where: { id: sent.id } })).status).not.toBe("failed");
    // Simulate a worker that crashed before atomically claiming init; no transfer was sent in this fixture state.
    await db.platformPayout.update({ where: { id: sent.id }, data: { initStartedAt: null } });
    const recovered = await refresh();
    expect(recovered.status).toBe(200);
    expect((await recovered.json()).payout).toMatchObject({ status: "failed", errorCode: "payout_not_sent" });
    expect(providerCalls("/init")).toHaveLength(1);
  });
});
