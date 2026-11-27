import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Configuración de un datáfono: nombre, activo y serial. Ya no hay "mesero
 * asignado" (el datáfono es del comercio): un `assignedUserId` en el body se
 * ignora y la columna no se escribe ni se devuelve.
 */

const m = vi.hoisted(() => ({ update: vi.fn(), audit: vi.fn() }));

vi.mock("@/lib/secureApi", () => ({ secureApi: (fn: unknown) => fn }));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "admin-1", role: "operator" } }) }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => "rest-1" }));
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: (run: (tx: object) => unknown) => run({
      $queryRaw: async () => [{ kushkiDeviceId: "device-A", serialNumber: "test-serial-A" }],
      terminalDevice: { update: m.update },
      auditEvent: { create: m.audit },
    }),
  },
}));

import { PATCH } from "./route";

const patch = async (body: Record<string, unknown>) =>
  PATCH(new Request("http://localhost/api/operator/terminal-devices/dev-1", { method: "PATCH", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: "dev-1" }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  m.update.mockResolvedValue({ id: "dev-1", label: "Caja", active: true, serialNumber: "test-serial-A" });
});

describe("PATCH /api/operator/terminal-devices/[id]", () => {
  it("ignora assignedUserId: ni lo escribe ni lo lee", async () => {
    const res = await patch({ serialNumber: "test-serial-A", assignedUserId: "mesero-1" });
    expect(res.status).toBe(200);
    const args = m.update.mock.calls[0][0] as { data: Record<string, unknown>; select: Record<string, unknown> };
    expect(args.data).toEqual({ serialNumber: "test-serial-A" });
    expect(args.select).not.toHaveProperty("assignedUserId");
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("sigue guardando nombre, activo y serial", async () => {
    await patch({ label: "Terraza", active: false, serialNumber: "" });
    expect(m.audit).toHaveBeenCalledWith({ data: expect.objectContaining({
      restaurantId: "rest-1", targetId: "device-A", diff: { previousSerial: "test-serial-A", serialNumber: null },
    }) });
    expect(m.update.mock.calls[0][0]).toMatchObject({ data: { label: "Terraza", active: false, serialNumber: null } });
  });
});
