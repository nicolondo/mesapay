// Avisos de Kushki para Bre-B: otro comercio, otra firma. Se verifica con la
// firma del comercio Bre-B del restaurante (nunca con la de tarjeta) y un
// aviso que no pasa la firma no se aplica: dispara una consulta de estado.
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { NODE_ENV: "test", KUSHKI_WEBHOOK_SECRET: undefined } }));
vi.mock("@/lib/platformConfig", () => ({ getKushkiModeSync: () => "production" }));
vi.mock("@/lib/crypto", () => ({ decrypt: (v: string) => v.replace(/^enc:/, "") }));

const h = vi.hoisted(() => ({
  charge: null as null | Record<string, unknown>,
  tenants: [] as Array<{ id: string }>,
  restaurantSecret: "enc:breb-secret-fake" as string | null,
}));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: {
      findUnique: vi.fn(async () => ({ kushkiBreBWebhookSecretEnc: h.restaurantSecret })),
      findMany: vi.fn(async () => h.tenants),
    },
    breBCharge: { findUnique: vi.fn(async () => h.charge) },
  },
}));
const service = vi.hoisted(() => ({
  findBreBChargeForWebhook: vi.fn(async () => h.charge),
  handleBreBWebhookEvent: vi.fn(async () => "approved"),
  checkBreBCharge: vi.fn(async () => null),
  recordUnmatchedBreBEvent: vi.fn(async () => true),
}));
vi.mock("./service", () => service);

import { tryHandleBreBWebhook, tryHandleNormalizedBreB } from "./webhook";

const CHARGE = { id: "charge-1", restaurantId: "rest-1", paymentId: "pay-1", token: "tok-1", status: "active" };
const body = {
  token: "tok-1",
  status: "approvedTransaction",
  ticketNumber: "111",
  amount: { subtotalIva: 0, subtotalIva0: 45500, iva: 0 },
  metadata: { breBChargeId: "charge-1", paymentId: "pay-1" },
};
const sign = (raw: string, secret: string) => createHmac("sha256", secret).update(raw).digest("hex");
const headersFor = (raw: string, secret: string, extra: Record<string, string> = {}) =>
  new Headers({ "x-kushki-signature": sign(raw, secret), ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  h.charge = { ...CHARGE };
  h.tenants = [];
  h.restaurantSecret = "enc:breb-secret-fake";
});

describe("aviso real de Kushki para un cobro Bre-B", () => {
  it("firmado con la firma del comercio Bre-B: se aplica", async () => {
    const raw = JSON.stringify(body);
    const res = await tryHandleBreBWebhook(raw, body, headersFor(raw, "breb-secret-fake"));
    expect(res?.status).toBe(200);
    expect(service.handleBreBWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "charge-1" }),
      expect.objectContaining({ status: "approved", amountCents: 4_550_000 }),
      body,
    );
  });

  it("firmado con la firma de TARJETA (otro comercio): 401, no se aplica, se consulta el estado", async () => {
    const raw = JSON.stringify(body);
    const res = await tryHandleBreBWebhook(raw, body, headersFor(raw, "card-secret-fake"));
    expect(res?.status).toBe(401);
    expect(service.handleBreBWebhookEvent).not.toHaveBeenCalled();
    expect(service.checkBreBCharge).toHaveBeenCalledWith("charge-1");
  });

  it("en producción, sin firma del comercio Bre-B ni global: se rechaza", async () => {
    h.restaurantSecret = null;
    const raw = JSON.stringify(body);
    const res = await tryHandleBreBWebhook(raw, body, new Headers());
    expect(res?.status).toBe(401);
    expect(service.handleBreBWebhookEvent).not.toHaveBeenCalled();
  });

  it("auténtico pero con un estado que no está en el contrato: no se adivina, se consulta", async () => {
    const odd = { ...body, status: "APPROVAL" };
    const raw = JSON.stringify(odd);
    const res = await tryHandleBreBWebhook(raw, odd, headersFor(raw, "breb-secret-fake"));
    expect(res?.status).toBe(200);
    expect(service.handleBreBWebhookEvent).not.toHaveBeenCalled();
    expect(service.checkBreBCharge).toHaveBeenCalledWith("charge-1", { force: true });
  });
});

describe("aviso sin cobro que casar", () => {
  it("de un comercio Bre-B nuestro y aprobado: queda registrado para conciliar (no se pierde)", async () => {
    h.charge = null;
    h.tenants = [{ id: "rest-1" }];
    const raw = JSON.stringify(body);
    const res = await tryHandleBreBWebhook(raw, body, headersFor(raw, "breb-secret-fake", { "x-kushki-key": "pub-breb" }));
    expect(res?.status).toBe(200);
    expect(service.recordUnmatchedBreBEvent).toHaveBeenCalledWith(
      expect.objectContaining({ restaurantId: "rest-1", status: "approved", amountCents: 4_550_000 }),
    );
  });

  it("que no es de ningún comercio Bre-B: sigue el camino de tarjeta/PSE de siempre", async () => {
    h.charge = null;
    const raw = JSON.stringify(body);
    expect(await tryHandleBreBWebhook(raw, body, new Headers())).toBeNull();
    expect(service.recordUnmatchedBreBEvent).not.toHaveBeenCalled();
  });
});

describe("formato interno normalizado", () => {
  it("un pago Bre-B nunca se salda por el camino genérico", async () => {
    const payload = { type: "charge.approved", paymentId: "pay-1", amountCents: 4_550_000 };
    const raw = JSON.stringify(payload);
    const res = await tryHandleNormalizedBreB(raw, payload, headersFor(raw, "breb-secret-fake"));
    expect(res?.status).toBe(200);
    expect(service.handleBreBWebhookEvent).toHaveBeenCalled();
  });

  it("un pago que no es Bre-B sigue igual que antes", async () => {
    h.charge = null;
    const payload = { type: "charge.approved", paymentId: "pay-card" };
    expect(await tryHandleNormalizedBreB(JSON.stringify(payload), payload, new Headers())).toBeNull();
  });
});
