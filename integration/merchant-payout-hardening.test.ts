import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { encrypt, decrypt } from "../src/lib/crypto";
import { POST as submit, GET as recover } from "../src/app/api/operator/wallet/disperse/route";
import { POST as webhook } from "../src/app/api/webhooks/kushki-payout/route";
import { ownDestinationFingerprint } from "../src/lib/merchantWallet/ownDestination";

const session = vi.hoisted(() => {
  process.env.MESAPAY_SECRET_KEY = "ab".repeat(32); process.env.APP_PUBLIC_BASE_URL = "http://localhost:3411";
  return { restaurantId: "", role: "operator", id: "merchant-payout-review-admin" };
});
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { id: session.id, email: "merchant-payout-review@example.test", role: session.role } }) }));
vi.mock("../src/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => session.restaurantId,
  getActiveContext: async () => ({ restaurantId: session.restaurantId, session: { user: { role: session.role } } }) }));
vi.mock("../src/lib/rateLimit", () => ({ rateLimit: async () => true }));
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) throw new Error("Isolated local test database required");
const destination = { bankId: "1007", bankName: "Bancolombia", accountType: "ahorros", accountNumber: "123456789012", docType: "NIT", docNumber: "901234567", holderName: "Beneficiario sintético" };
const fetchMock = vi.fn<typeof fetch>();
let restaurantId = "";
let otherId = "";
let behavior: "ok" | "timeout" | "reject" = "ok";
let onInit: ((body: Record<string, unknown>) => Promise<void>) | null = null;
let onQuery: (() => Promise<void>) | null = null;
let onToken: (() => Promise<void>) | null = null;
let remote: Record<string, unknown> = {};
let sequence = 0;
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => new Request(`http://localhost${path}`, { method: body === undefined ? "GET" : "POST", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const input = () => ({ restaurantId, idempotencyKey: randomUUID(), amountCents: 123456, destination });
const send = (body: ReturnType<typeof input>) => submit(request("/api/operator/wallet/disperse", body));
const get = (key: string) => recover(request(`/api/operator/wallet/disperse?restaurantId=${restaurantId}&idempotencyKey=${key}`));
const calls = (path: string) => fetchMock.mock.calls.filter(([url]) => String(url).includes(path));
const verified = (row: { ticketNumber: string | null; providerRef: string | null; amountCents: number; reference: string | null; currency: string }, state = "APPROVED") => ({ ticketNumber: row.ticketNumber, transactionReference: row.providerRef, totalAmount: row.amountCents / 100, currency: row.currency, bankId: "1007", transactionType: "PAYOUT", transactionStatus: state, metadata: { reference: row.reference } });
beforeAll(async () => {
  const tenant = await db.restaurant.create({ data: { name: "merchant_payout_review", slug: `merchant-payout-review-${randomUUID()}`, country: "CO", kushkiMerchantId: "synthetic-merchant", kushkiMode: "sandbox", kushkiPublicKey: "synthetic-collection-public", kushkiPrivateKeyEnc: encrypt("synthetic-collection-private"), kushkiPayoutPublicKey: "synthetic-payout-public", kushkiPayoutPrivateKeyEnc: encrypt("synthetic-payout-private"), bankInfo: { bankName: destination.bankName, accountType: destination.accountType, accountNumber: destination.accountNumber, holderName: destination.holderName, holderDocType: destination.docType, holderDocNumber: destination.docNumber } } });
  restaurantId = tenant.id; session.restaurantId = restaurantId;
  otherId = (await db.restaurant.create({ data: { name: "merchant_payout_review_other", slug: `merchant-payout-review-other-${randomUUID()}` } })).id;
  vi.stubGlobal("fetch", fetchMock);
});
beforeEach(async () => {
  session.restaurantId = restaurantId; session.role = "operator"; behavior = "ok"; onInit = null; onQuery = null; onToken = null; remote = {};
  await db.auditEvent.deleteMany({ where: { restaurantId: { in: [restaurantId, otherId] } } });
  await db.payout.deleteMany({ where: { restaurantId: { in: [restaurantId, otherId] } } });
  await db.restaurant.update({ where: { id: restaurantId }, data: { kushkiPayoutPrivateKeyEnc: encrypt("synthetic-payout-private"), country: "CO" } });
  fetchMock.mockReset().mockImplementation(async (url, init) => {
    if (!String(url).startsWith("https://api-uat.kushkipagos.com/")) throw new Error("External request blocked");
    if (String(url).endsWith("/bankList")) return reply([{ code: "1007", name: "Bancolombia" }]);
    if (String(url).endsWith("/tokens")) { if (onToken) await onToken(); return reply({ token: `synthetic-token-${randomUUID()}` }); }
    if (String(url).endsWith("/init")) {
      if (onInit) await onInit(JSON.parse(String(init?.body)));
      if (behavior === "timeout") throw new DOMException("Synthetic timeout with sensitive provider text", "TimeoutError");
      if (behavior === "reject") return reply({ code: "TEST_REJECTION", message: "private provider text" }, 400);
      return reply({ ticketNumber: `ticket-${++sequence}`, transactionReference: `ref-${sequence}` });
    }
    if (String(url).includes("/transaction/")) { if (onQuery) await onQuery(); return reply(remote); }
    throw new Error("Unexpected provider path blocked");
  });
});
afterAll(async () => {
  await db.auditEvent.deleteMany({ where: { restaurantId: { in: [restaurantId, otherId] } } });
  await db.restaurant.deleteMany({ where: { id: { in: [restaurantId, otherId] } } });
  vi.unstubAllGlobals(); await db.$disconnect();
});
describe("merchant payout hardening with real PostgreSQL and mocked transport", () => {
  it("keeps operator role restrictions and cross-origin mutation protection", async () => {
    session.role = "mesero"; expect((await send(input())).status).toBe(401);
    session.role = "operator"; expect((await submit(request("/api/operator/wallet/disperse", input(), { origin: "https://other.invalid" }))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled(); expect(await db.payout.count({ where: { restaurantId } })).toBe(0);
  });
  it("records before init, encrypts callback secret and masks destination PII", async () => {
    const body = input(); onInit = async () => { expect(await db.payout.count({ where: { idempotencyKey: body.idempotencyKey, status: "submitting", initStartedAt: { not: null } } })).toBe(1); };
    const res = await send(body); expect(res.status).toBe(200);
    const dto = await res.json(); const row = await db.payout.findUniqueOrThrow({ where: { id: dto.payoutId } });
    expect(row.status).toBe("initialized"); expect(row.providerVerifiedAt).toBeNull(); expect(row.walletAccountFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain(destination.accountNumber); expect(JSON.stringify(row)).not.toContain(destination.docNumber);
    const sentBody = JSON.parse(String(calls("/init")[0][1]?.body)); expect(sentBody.webhooks[0].headers[0].value).toBe(`Bearer ${decrypt(row.webhookSecretEnc!)}`);
    expect(JSON.stringify(dto)).not.toContain("synthetic-payout-private"); expect(JSON.stringify(dto)).not.toContain(row.webhookSecretEnc!);
  });
  it("serializes concurrent duplicate submissions and blocks a different uncertain attempt", async () => {
    let entered!: () => void; const ready = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    onInit = async () => { entered(); await gate; };
    const body = input(); const first = send(body); await ready;
    const second = await send(body); expect((await second.json()).status).toBe("submitting");
    expect((await send(input())).status).toBe(409); release(); expect((await first).status).toBe(200);
    expect(calls("/init")).toHaveLength(1); expect(await db.payout.count({ where: { restaurantId } })).toBe(1);
  });
  it("persists ambiguous init without resending after retry or recovery", async () => {
    behavior = "timeout"; const body = input(); const first = await (await send(body)).json(); expect(first.status).toBe("unknown");
    expect((await (await send(body)).json()).payoutId).toBe(first.payoutId);
    const recovered = await (await get(body.idempotencyKey)).json(); expect(recovered.payout.status).toBe("unknown"); expect(recovered.refreshError).toBe("payout_status_unavailable");
    expect(calls("/init")).toHaveLength(1); expect(JSON.stringify(await db.payout.findUnique({ where: { id: first.payoutId } }))).not.toContain("sensitive provider text");
  });
  it("binds early authenticated callback via server reference without regressing approved", async () => {
    onInit = async (body) => {
      const hooks = body.webhooks as Array<{ urls: string[]; headers: Array<{ value: string }> }>;
      const row = await db.payout.findFirstOrThrow({ where: { restaurantId, reference: (body.metadata as { reference: string }).reference } });
      remote = verified({ ...row, ticketNumber: `ticket-${sequence + 1}`, providerRef: `ref-${sequence + 1}` });
      const response = await webhook(new Request(hooks[0].urls[0], { method: "POST", headers: { authorization: hooks[0].headers[0].value }, body: JSON.stringify({ ticketNumber: remote.ticketNumber, status: "DECLINED" }) }));
      expect(response.status).toBe(200);
    };
    const dto = await (await send(input())).json(); expect(dto.status).toBe("approved");
    const row = await db.payout.findUniqueOrThrow({ where: { id: dto.payoutId } }); expect(row.providerVerifiedAt).toBeInstanceOf(Date);
    expect(await db.auditEvent.count({ where: { restaurantId, targetId: row.id, kind: "wallet.payout.status" } })).toBe(1);
  });
  it("ignores forged approval, mismatched amount and legacy unsigned callbacks", async () => {
    const body = input(); const dto = await (await send(body)).json(); const row = await db.payout.findUniqueOrThrow({ where: { id: dto.payoutId } });
    expect((await webhook(request(`/api/webhooks/kushki-payout?payoutId=${row.id}`, { status: "APPROVED", ticketNumber: row.ticketNumber }, { authorization: "Bearer forged" }))).status).toBe(401);
    expect(calls("/transaction/")).toHaveLength(0);
    remote = { ...verified(row), totalAmount: row.amountCents / 100 + 1 }; expect((await (await get(body.idempotencyKey)).json()).refreshError).toBe("payout_status_mismatch");
    expect((await webhook(request("/api/webhooks/kushki-payout", { status: "APPROVED", ticketNumber: row.ticketNumber }))).status).toBe(401);
    expect((await db.payout.findUniqueOrThrow({ where: { id: row.id } })).providerVerifiedAt).toBeNull();
  });
  it("uses GET identity and isolates recovery, stale tenant and changed credentials", async () => {
    const body = input(); const dto = await (await send(body)).json(); const row = await db.payout.findUniqueOrThrow({ where: { id: dto.payoutId } }); remote = verified(row);
    session.restaurantId = otherId; expect((await send(body)).status).toBe(409);
    expect(await (await recover(request(`/api/operator/wallet/disperse?restaurantId=${otherId}&idempotencyKey=${body.idempotencyKey}`))).json()).toEqual({ payout: null });
    session.restaurantId = restaurantId;
    onQuery = async () => { await db.restaurant.update({ where: { id: restaurantId }, data: { kushkiPayoutPrivateKeyEnc: encrypt("rotated-synthetic") } }); };
    expect((await (await get(body.idempotencyKey)).json()).refreshError).toBe("account_changed"); expect((await db.payout.findUniqueOrThrow({ where: { id: dto.payoutId } })).status).toBe("initialized");
  });
  it("preserves MXN token behavior and verifies terminal status in the persisted currency", async () => {
    await db.restaurant.update({ where: { id: restaurantId }, data: { country: "MX" } });
    const body = input(); const dto = await (await send(body)).json(); const row = await db.payout.findUniqueOrThrow({ where: { id: dto.payoutId } });
    expect(row.currency).toBe("MXN"); expect(JSON.parse(String(calls("/tokens")[0][1]?.body)).currency).toBe("MXN");
    remote = verified(row, "DECLINED"); expect((await (await get(body.idempotencyKey)).json()).payout.status).toBe("declined");
  });
  it("only marks explicit init rejection failed and sanitizes persisted details", async () => {
    behavior = "reject"; const dto = await (await send(input())).json(); expect(dto.status).toBe("failed"); expect(dto.responseText).toBe("payout_rejected");
    expect(JSON.stringify(await db.payout.findUniqueOrThrow({ where: { id: dto.payoutId } }))).not.toContain("private provider text");
  });
  it("does not replace the own destination when bank details change after review", async () => {
    const tenant = await db.restaurant.findUniqueOrThrow({ where: { id: restaurantId } });
    const before = tenant.bankInfo as Prisma.InputJsonObject;
    const body = { restaurantId, idempotencyKey: randomUUID(), amountCents: 100000, ownDestinationFingerprint: ownDestinationFingerprint(before) };
    try {
      await db.restaurant.update({ where: { id: restaurantId }, data: { bankInfo: { ...before, accountNumber: "987654321012" } } });
      const rejected = await submit(request("/api/operator/wallet/disperse", body)); expect(rejected.status).toBe(409); expect(await rejected.json()).toEqual({ error: "own_destination_changed" });
      expect(await db.payout.count({ where: { restaurantId } })).toBe(0); expect(calls("/init")).toHaveLength(0);
      await db.restaurant.update({ where: { id: restaurantId }, data: { bankInfo: before } });
      onToken = async () => { await db.restaurant.update({ where: { id: restaurantId }, data: { bankInfo: { ...before, accountNumber: "987654321012" } } }); };
      const during = await (await submit(request("/api/operator/wallet/disperse", body))).json(); expect(during.status).toBe("failed"); expect(during.responseText).toBe("own_destination_changed"); expect(calls("/init")).toHaveLength(0);
    } finally { await db.restaurant.update({ where: { id: restaurantId }, data: { bankInfo: before } }); }
  });
});
