// «Reenviar a la DIAN» / «Consultar en la DIAN»: sólo staff con acceso al
// ERP (el guard real, `getErpContext`), del comercio activo, con el módulo
// de facturación electrónica, y con tope por minuto.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  activeRestaurant: vi.fn(),
  restaurant: vi.fn(),
  rateLimit: vi.fn(),
  recover: vi.fn(),
}));

vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.activeRestaurant }));
vi.mock("@/lib/db", () => ({ db: { restaurant: { findUnique: m.restaurant } } }));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: m.rateLimit }));
vi.mock("@/lib/dian/invoiceRecovery", () => ({ recoverDianInvoice: m.recover }));

import { POST } from "./route";

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/operator/dian/documents/doc-1/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "doc-1" }) },
  );
const as = (role: string) => m.auth.mockResolvedValue({ user: { id: "u1", email: "x@example.test", role } });

beforeEach(() => {
  vi.resetAllMocks();
  as("operator");
  m.activeRestaurant.mockResolvedValue("rest-1");
  m.restaurant.mockResolvedValue({ enabledModules: ["einvoicing"], country: "CO" });
  m.rateLimit.mockResolvedValue(true);
  m.recover.mockResolvedValue({ documentId: "doc-1", number: "FESM1", action: "resend", outcome: "accepted" });
});

describe("POST /api/operator/dian/documents/[id]/recover", () => {
  it("el operador reenvía: la acción va con el comercio ACTIVO (nunca uno del body)", async () => {
    const res = await post({ action: "resend", restaurantId: "otro" });
    expect(res.status).toBe(200);
    expect(m.recover).toHaveBeenCalledWith({ documentId: "doc-1", restaurantId: "rest-1", action: "resend", source: "operator" });
  });

  it.each(["mesero", "kitchen", "bar", "terminal", "customer"])("%s no puede (401)", async (role) => {
    as(role);
    expect((await post({ action: "resend" })).status).toBe(401);
    expect(m.recover).not.toHaveBeenCalled();
  });

  it("sin sesión ⇒ 401; sin el módulo de facturación electrónica ⇒ 403", async () => {
    m.auth.mockResolvedValue(null);
    expect((await post({ action: "check_status" })).status).toBe(401);
    as("operator");
    m.restaurant.mockResolvedValue({ enabledModules: [], country: "CO" });
    expect((await post({ action: "check_status" })).status).toBe(403);
    expect(m.recover).not.toHaveBeenCalled();
  });

  it("acción desconocida ⇒ 400; tope por minuto ⇒ 429", async () => {
    expect((await post({ action: "delete" })).status).toBe(400);
    m.rateLimit.mockResolvedValue(false);
    expect((await post({ action: "resend" })).status).toBe(429);
    expect(m.recover).not.toHaveBeenCalled();
  });

  it("acción que no corresponde ⇒ 409; de otro comercio ⇒ 404", async () => {
    m.recover.mockResolvedValueOnce({ outcome: "not_applicable" });
    expect((await post({ action: "resend" })).status).toBe(409);
    m.recover.mockResolvedValueOnce({ outcome: "not_found" });
    expect((await post({ action: "resend" })).status).toBe(404);
  });
});
