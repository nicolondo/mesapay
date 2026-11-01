import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePaymentsDb } from "@/test/fakePaymentsDb";

/**
 * El barrido de 30 minutos (timer `mesapay-stock-consumption`, docs/cron/):
 * los cobros con proveedor que siguen pendientes pasan a conciliación, salvo
 * el datáfono Kushki que NUNCA se envió al equipo: esa es una solicitud (se
 * cancela o la reemplaza el cobro), no plata en vuelo.
 */

const h = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import("@/test/fakePaymentsDb").createFakePaymentsDb>,
}));

vi.mock("@/lib/db", () => ({
  db: {
    payment: {
      findMany: (a: never) => h.fake.tx.payment.findMany(a),
      count: (a: never) => h.fake.tx.payment.count(a),
    },
    financialOperation: {
      findMany: (a: never) => h.fake.tx.financialOperation.findMany(a),
    },
    rateLimitBucket: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    platformEvent: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: (cb: never) => h.fake.$transaction(cb),
  },
}));
vi.mock("@/lib/erp/consumption", () => ({ sweepUnconsumedOrders: async () => ({ consumed: 0 }) }));
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveContext: async () => null }));

import { POST } from "./route";

const NOW = Date.now();
const OLD = new Date(NOW - 45 * 60_000);
const RECENT = new Date(NOW - 5 * 60_000);

async function sweep() {
  const res = await POST(
    new Request("http://localhost/api/cron/stock-consumption", {
      method: "POST",
      headers: { host: "localhost", "x-cron-secret": "s3cret" },
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "s3cret");
  h.fake = createFakePaymentsDb({
    order: { id: "order-1", subtotalCents: 1_000_000 },
    payments: [
      { id: "smart-unsent", method: "kushki_card_terminal", status: "pending", amountCents: 100, createdAt: OLD },
      { id: "smart-sent", method: "kushki_card_terminal", status: "pending", amountCents: 100, createdAt: OLD },
      { id: "smart-ref", method: "kushki_card_terminal", status: "pending", amountCents: 100, providerRef: "mock-1", createdAt: OLD },
      { id: "pse-old", method: "kushki_pse", status: "pending", amountCents: 100, createdAt: OLD },
      { id: "card-old", method: "kushki_card", status: "pending", amountCents: 100, createdAt: OLD },
      { id: "pse-new", method: "kushki_pse", status: "pending", amountCents: 100, createdAt: RECENT },
      { id: "cash-old", method: "cash", status: "pending", amountCents: 100, createdAt: OLD },
      { id: "ext-old", method: "external_terminal", status: "pending", amountCents: 100, createdAt: OLD },
    ],
    financialOperations: [{ key: "terminal:smart-sent", paymentId: "smart-sent", status: "completed", createdAt: OLD }],
  });
});

describe("cron stock-consumption: pendientes viejos con proveedor a conciliación", () => {
  it("marca lo que puede tener plata en vuelo y deja las solicitudes en paz", async () => {
    const { status } = await sweep();
    expect(status).toBe(200);
    const flagged = h.fake.state.payments.filter((p) => p.reconciliationRequired).map((p) => p.id).sort();
    expect(flagged).toEqual(["card-old", "pse-old", "smart-ref", "smart-sent"]);
  });

  it("un datáfono Kushki que nunca se envió no aparece como «Requiere revisión»", async () => {
    await sweep();
    expect(h.fake.payment("smart-unsent")).toMatchObject({ status: "pending", reconciliationRequired: false });
  });

  it("sin el secreto, no hace nada", async () => {
    const res = await POST(new Request("http://localhost/api/cron/stock-consumption", { method: "POST", headers: { host: "localhost" } }));
    expect(res.status).toBe(401);
    expect(h.fake.state.payments.some((p) => p.reconciliationRequired)).toBe(false);
  });
});
