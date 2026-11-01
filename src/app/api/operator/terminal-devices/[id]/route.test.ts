import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Configuración de un datáfono: nombre, activo y serial. Ya no hay "mesero
 * asignado" (el datáfono es del comercio): un `assignedUserId` en el body se
 * ignora y la columna no se escribe ni se devuelve.
 */

const m = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock("@/lib/secureApi", () => ({ secureApi: (fn: unknown) => fn }));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "admin-1", role: "operator" } }) }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => "rest-1" }));
vi.mock("@/lib/db", () => ({
  db: {
    terminalDevice: {
      findUnique: vi.fn(async () => ({ id: "dev-1", restaurantId: "rest-1" })),
      update: m.update,
    },
    user: { findUnique: vi.fn() },
  },
}));

import { PATCH } from "./route";

const patch = async (body: Record<string, unknown>) =>
  PATCH(new Request("http://localhost/api/operator/terminal-devices/dev-1", { method: "PATCH", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: "dev-1" }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  m.update.mockResolvedValue({ id: "dev-1", label: "Caja", active: true, serialNumber: "P3F6P624J0139" });
});

describe("PATCH /api/operator/terminal-devices/[id]", () => {
  it("ignora assignedUserId: ni lo escribe ni lo lee", async () => {
    const res = await patch({ serialNumber: "P3F6P624J0139", assignedUserId: "mesero-1" });
    expect(res.status).toBe(200);
    const args = m.update.mock.calls[0][0] as { data: Record<string, unknown>; select: Record<string, unknown> };
    expect(args.data).toEqual({ serialNumber: "P3F6P624J0139" });
    expect(args.select).not.toHaveProperty("assignedUserId");
  });

  it("sigue guardando nombre, activo y serial", async () => {
    await patch({ label: "Terraza", active: false, serialNumber: "" });
    expect(m.update.mock.calls[0][0]).toMatchObject({ data: { label: "Terraza", active: false, serialNumber: null } });
  });
});
