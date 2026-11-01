import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Guardar el Business-Code del Cloud Terminal: rechaza el Merchant ID y la
 * llave pública de Kushki con un error claro, y nunca devuelve el código
 * entero (sólo enmascarado).
 */

const m = vi.hoisted(() => ({
  session: { user: { id: "admin-1", role: "operator" } } as null | { user: { id: string; role: string } },
  restaurant: {
    kushkiMerchantId: "6f1c0f7a2b9d4e3c8a5b1d2e3f4a5b6c",
    kushkiPublicKey: "pk_live_9a8b7c6d5e4f3a2b1c0d",
  },
  update: vi.fn(),
}));

vi.mock("@/lib/secureApi", () => ({ secureApi: (fn: unknown) => fn }));
vi.mock("@/auth", () => ({ auth: async () => m.session }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => "rest-1" }));
vi.mock("@/lib/db", () => ({
  db: { restaurant: { findUnique: vi.fn(async () => m.restaurant), update: m.update } },
}));

import { POST } from "./route";

const save = async (businessCode: unknown) => {
  const res = await POST(
    new Request("http://localhost/api/operator/terminal-business-code", {
      method: "POST",
      body: JSON.stringify({ businessCode }),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

beforeEach(() => {
  vi.clearAllMocks();
  m.session = { user: { id: "admin-1", role: "operator" } };
});

describe("POST /api/operator/terminal-business-code", () => {
  it("el Merchant ID de Kushki → 400 business_code_is_merchant_id y no se guarda", async () => {
    expect(await save(m.restaurant.kushkiMerchantId)).toEqual({ status: 400, json: { error: "business_code_is_merchant_id" } });
    expect(await save(` ${m.restaurant.kushkiMerchantId.toUpperCase()} `)).toMatchObject({ status: 400 });
    expect(m.update).not.toHaveBeenCalled();
  });

  it("la llave pública de Kushki → 400 business_code_is_public_key y no se guarda", async () => {
    expect(await save(m.restaurant.kushkiPublicKey)).toEqual({ status: 400, json: { error: "business_code_is_public_key" } });
    expect(m.update).not.toHaveBeenCalled();
  });

  it("un Business-Code válido se guarda y la respuesta lo trae sólo enmascarado", async () => {
    const { status, json } = await save("  BC-55555-XYZ1 ");
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, masked: "••••XYZ1" });
    expect(m.update).toHaveBeenCalledWith({ where: { id: "rest-1" }, data: { cloudTerminalBusinessCode: "BC-55555-XYZ1" } });
  });

  it("vacío lo borra", async () => {
    expect(await save("")).toEqual({ status: 200, json: { ok: true, masked: null } });
    expect(m.update).toHaveBeenCalledWith({ where: { id: "rest-1" }, data: { cloudTerminalBusinessCode: null } });
  });

  it.each(["mesero", "kitchen", "terminal"])("el rol %s no puede", async (role) => {
    m.session = { user: { id: "u", role } };
    expect((await save("BC-1")).status).toBe(403);
    expect(m.update).not.toHaveBeenCalled();
  });
});
