// PUT /settings/staff-policies: validación de `compAllowedRoles` (quién
// puede no cobrar). Sólo roles que operan mesas; se deduplica al guardar.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  activeRestaurantId: vi.fn(),
  restaurantFindUnique: vi.fn(),
  restaurantUpdate: vi.fn(),
  shiftCount: vi.fn(),
  recordAuditEvent: vi.fn(),
}));

vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveRestaurantId: m.activeRestaurantId,
}));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.recordAuditEvent }));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: {
      findUnique: m.restaurantFindUnique,
      update: m.restaurantUpdate,
    },
    shift: { count: m.shiftCount },
  },
}));

import { PUT } from "./route";

const put = (body: unknown) =>
  PUT(
    new Request("http://localhost/api/operator/settings/staff-policies", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  ) as Promise<Response>;

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "u-1", role: "operator" } });
  m.activeRestaurantId.mockResolvedValue("r1");
  m.restaurantFindUnique.mockResolvedValue({
    tipPolicy: "shared",
    shiftPolicy: "global",
    walkoutDangerMinutes: 20,
    businessDayCutoffHour: 5,
    meseroShiftWithoutLocal: "block",
    compEnabled: true,
    compLabel: null,
    adminOnlyCharge: false,
    compAllowedRoles: ["operator"],
  });
  m.restaurantUpdate.mockResolvedValue({});
  m.shiftCount.mockResolvedValue(0);
});

describe("PUT /settings/staff-policies — compAllowedRoles", () => {
  it("rechaza roles que no operan mesas (cocina)", async () => {
    const res = await put({ compAllowedRoles: ["operator", "kitchen"] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid");
    expect(m.restaurantUpdate).not.toHaveBeenCalled();
  });

  it("rechaza un rol inventado y un valor que no es lista", async () => {
    expect((await put({ compAllowedRoles: ["dueño"] })).status).toBe(400);
    expect((await put({ compAllowedRoles: "operator" })).status).toBe(400);
    expect(m.restaurantUpdate).not.toHaveBeenCalled();
  });

  it("guarda la lista deduplicada y en orden canónico", async () => {
    const res = await put({
      compAllowedRoles: ["mesero", "operator", "mesero", "terminal"],
    });
    expect(res.status).toBe(200);
    expect(m.restaurantUpdate).toHaveBeenCalledOnce();
    expect(m.restaurantUpdate.mock.calls[0][0].data.compAllowedRoles).toEqual([
      "operator",
      "mesero",
      "terminal",
    ]);
    // Queda en el audit log con el antes y el después.
    expect(m.recordAuditEvent).toHaveBeenCalledOnce();
    expect(m.recordAuditEvent.mock.calls[0][0]).toMatchObject({
      kind: "restaurant.staff_policies.update",
      diff: {
        before: { compAllowedRoles: ["operator"] },
        after: { compAllowedRoles: ["mesero", "operator", "mesero", "terminal"] },
      },
    });
  });

  it("acepta la lista vacía (nadie del equipo puede no cobrar)", async () => {
    const res = await put({ compAllowedRoles: [] });
    expect(res.status).toBe(200);
    expect(m.restaurantUpdate.mock.calls[0][0].data.compAllowedRoles).toEqual([]);
  });

  it("si no viene en el body no toca la lista guardada", async () => {
    const res = await put({ tipPolicy: "by_waiter" });
    expect(res.status).toBe(200);
    expect(m.restaurantUpdate.mock.calls[0][0].data).not.toHaveProperty(
      "compAllowedRoles",
    );
  });

  it("el mesero no puede editar políticas", async () => {
    m.auth.mockResolvedValue({ user: { id: "u-2", role: "mesero" } });
    const res = await put({ compAllowedRoles: ["mesero"] });
    expect(res.status).toBe(403);
    expect(m.restaurantUpdate).not.toHaveBeenCalled();
  });
});
