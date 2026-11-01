import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  findRestaurant: vi.fn(),
  preview: vi.fn(),
  decline: vi.fn(),
  cancelLinks: vi.fn(),
  cancelSubscription: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/db", () => ({ db: { restaurant: { findUnique: mocks.findRestaurant } } }));
vi.mock("@/lib/restaurantDeletion", () => ({ getDeletionPreview: mocks.preview }));
vi.mock("@/lib/restaurantDeletion/resolve", () => ({
  declinePendingPaymentRequests: mocks.decline,
  cancelOpenPaymentLinks: mocks.cancelLinks,
  cancelSubscriptionDebit: mocks.cancelSubscription,
}));

import { POST } from "./route";

const params = { params: Promise.resolve({ id: "r1" }) };
const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/admin/restaurants/r1/delete/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params,
  );
const admin = { user: { id: "admin-1", email: "admin@mesapay.co", role: "platform_admin" } };
const actor = { id: "admin-1", email: "admin@mesapay.co", role: "platform_admin" };
const freshPreview = { restaurant: { id: "r1", slug: "dani" }, counts: {}, blockers: [], warnings: [] };
const anyAction = () => [mocks.decline, mocks.cancelLinks, mocks.cancelSubscription].some((m) => m.mock.calls.length > 0);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue(admin);
  mocks.findRestaurant.mockResolvedValue({ id: "r1" });
  mocks.preview.mockResolvedValue(freshPreview);
  mocks.decline.mockResolvedValue({ declined: 1 });
  mocks.cancelLinks.mockResolvedValue({ cancelled: 2 });
  mocks.cancelSubscription.mockResolvedValue({ ok: true, alreadyCanceled: false, providerUnknown: false });
});

describe("permisos: sólo platform_admin", () => {
  it("sin sesión → 401 y no corre ninguna acción", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await post({ action: "decline_pending_payments" })).status).toBe(401);
    expect(anyAction()).toBe(false);
  });

  it.each(["operator", "group_admin", "mesero", "kitchen", "bar", "terminal", "comercial", "gerente_comercial", "customer"])(
    "%s → 403 en todas las acciones, aunque esté dentro del comercio",
    async (role) => {
      mocks.auth.mockResolvedValue({ user: { id: "u", email: "u@x.co", role, restaurantId: "r1" } });
      for (const action of ["decline_pending_payments", "cancel_payment_links", "cancel_subscription"]) {
        const res = await post({ action });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: "forbidden" });
      }
      expect(anyAction()).toBe(false);
      expect(mocks.preview).not.toHaveBeenCalled();
    },
  );
});

describe("acciones", () => {
  it("acción desconocida o sin body → 400", async () => {
    expect((await post({ action: "delete_everything" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post(null)).status).toBe(400);
    expect(anyAction()).toBe(false);
  });

  it("comercio que no existe → 404 sin correr nada", async () => {
    mocks.findRestaurant.mockResolvedValue(null);
    expect((await post({ action: "cancel_subscription" })).status).toBe(404);
    expect(anyAction()).toBe(false);
  });

  it("anular cobros pendientes: pasa el comercio y el admin, y devuelve el resumen recalculado", async () => {
    const res = await post({ action: "decline_pending_payments" });
    expect(res.status).toBe(200);
    expect(mocks.decline).toHaveBeenCalledWith("r1", actor);
    expect(await res.json()).toEqual({
      ok: true,
      action: "decline_pending_payments",
      result: { declined: 1 },
      preview: freshPreview,
    });
    // El resumen se pide DESPUÉS de la acción.
    expect(mocks.preview.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.decline.mock.invocationCallOrder[0]);
  });

  it("anular links de pago", async () => {
    const res = await post({ action: "cancel_payment_links" });
    expect(res.status).toBe(200);
    expect(mocks.cancelLinks).toHaveBeenCalledWith("r1", actor);
    expect(await res.json()).toMatchObject({ ok: true, result: { cancelled: 2 }, preview: freshPreview });
  });

  it("cancelar el débito automático", async () => {
    const res = await post({ action: "cancel_subscription" });
    expect(res.status).toBe(200);
    expect(mocks.cancelSubscription).toHaveBeenCalledWith("r1", actor);
    expect(await res.json()).toMatchObject({ ok: true, result: { alreadyCanceled: false, providerUnknown: false } });
  });

  it("si Kushki no reconocía la suscripción (K012 / 404), `providerUnknown` llega al cliente con 200", async () => {
    mocks.cancelSubscription.mockResolvedValue({ ok: true, alreadyCanceled: false, providerUnknown: true });
    const res = await post({ action: "cancel_subscription" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      action: "cancel_subscription",
      result: { alreadyCanceled: false, providerUnknown: true },
      preview: freshPreview,
    });
  });

  it("si Kushki no cancela el débito → 502 con el motivo, el detalle y el resumen (el bloqueo sigue)", async () => {
    const stillBlocked = { ...freshPreview, blockers: [{ code: "subscription_active", count: 1, detail: ["active"] }] };
    mocks.preview.mockResolvedValue(stillBlocked);
    mocks.cancelSubscription.mockResolvedValue({ ok: false, error: "provider_rejected", detail: "HTTP 400 · K004" });
    const res = await post({ action: "cancel_subscription" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      ok: false,
      action: "cancel_subscription",
      error: "subscription_cancel_failed",
      reason: "provider_rejected",
      detail: "HTTP 400 · K004",
      preview: stillBlocked,
    });
  });
});
