// Recuperación DIAN en lote: sólo platform-admin, el listado no toca nada,
// el lote tiene tope y freno por minuto, y el CUFE del portal sólo sirve
// para CONSULTAR (nunca para reenviar).
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  restaurant: vi.fn(),
  rateLimit: vi.fn(),
  list: vi.fn(),
  recoverOne: vi.fn(),
  recoverAll: vi.fn(),
}));

vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ db: { restaurant: { findUnique: m.restaurant } } }));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: m.rateLimit }));
vi.mock("@/lib/dian/invoiceRecovery", () => ({
  MAX_BATCH: 25,
  listRecoverableInvoices: m.list,
  recoverDianInvoice: m.recoverOne,
  recoverRestaurantInvoices: m.recoverAll,
}));

import { GET, POST } from "./route";

const params = { params: Promise.resolve({ id: "rest-1" }) };
const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/admin/restaurants/rest-1/dian-recovery", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params,
  );
const get = () => GET(new Request("http://localhost/api/admin/restaurants/rest-1/dian-recovery"), params);
const as = (role: string) => m.auth.mockResolvedValue({ user: { id: "a1", email: "admin@example.test", role } });

beforeEach(() => {
  vi.resetAllMocks();
  as("platform_admin");
  m.restaurant.mockResolvedValue({ id: "rest-1" });
  m.rateLimit.mockResolvedValue(true);
  m.list.mockResolvedValue({ items: [{ documentId: "d1" }], counts: { zero_value_line: 1 } });
  m.recoverAll.mockResolvedValue({ results: [], remaining: 0, truncated: false });
  m.recoverOne.mockResolvedValue({ documentId: "d1", outcome: "accepted" });
});

describe("/api/admin/restaurants/[id]/dian-recovery", () => {
  it.each(["operator", "group_admin", "mesero"])("%s no entra (401)", async (role) => {
    as(role);
    expect((await get()).status).toBe(401);
    expect((await post({ dryRun: false })).status).toBe(401);
    expect(m.list).not.toHaveBeenCalled();
    expect(m.recoverAll).not.toHaveBeenCalled();
  });

  it("GET y POST por defecto son el listado (dry-run): no procesan nada", async () => {
    expect(await (await get()).json()).toEqual({ dryRun: true, items: [{ documentId: "d1" }], counts: { zero_value_line: 1 } });
    expect((await (await post({})).json()).dryRun).toBe(true);
    expect(m.recoverAll).not.toHaveBeenCalled();
    expect(m.recoverOne).not.toHaveBeenCalled();
  });

  it("dryRun:false procesa con el tope pedido; más de 25 o un doble clic se frenan", async () => {
    expect((await post({ dryRun: false, limit: 10 })).status).toBe(200);
    expect(m.recoverAll).toHaveBeenCalledWith({ restaurantId: "rest-1", limit: 10 });
    expect((await post({ dryRun: false, limit: 500 })).status).toBe(400);
    m.rateLimit.mockResolvedValue(false);
    expect((await post({ dryRun: false })).status).toBe(429);
  });

  it("el CUFE del portal sólo se usa para CONSULTAR esa factura", async () => {
    const cufe = "A".repeat(96);
    await post({ documentId: "d1", cufe });
    expect(m.recoverOne).toHaveBeenCalledWith({
      documentId: "d1",
      restaurantId: "rest-1",
      action: "check_status",
      extraCufe: cufe,
      source: "admin_single",
    });
    expect((await post({ documentId: "d1", cufe: "no-es-un-cufe" })).status).toBe(400);
  });

  it("comercio inexistente ⇒ 404", async () => {
    m.restaurant.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
  });
});
