// POST /api/admin/users/[id]/password — el admin fija la contraseña de OTRO
// usuario. La propia ya no: se cambia en /admin/cuenta pidiendo la actual.
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  recordAuditEvent: vi.fn(),
}));

vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.recordAuditEvent }));
vi.mock("@/lib/db", () => ({
  db: { user: { findUnique: m.userFindUnique, update: m.userUpdate } },
}));

import { POST } from "./route";

const post = (id: string, password = "Fijada-por-admin") =>
  POST(
    new Request(`http://localhost/api/admin/users/${id}/password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }),
    { params: Promise.resolve({ id }) },
  ) as Promise<Response>;

const users: Record<string, { id: string; email: string; role: string }> = {
  "admin-1": { id: "admin-1", email: "admin@mesapay.co", role: "platform_admin" },
  "admin-2": { id: "admin-2", email: "otro@mesapay.co", role: "platform_admin" },
  "op-1": { id: "op-1", email: "op@sonymelona.co", role: "operator" },
};

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "admin-1", role: "platform_admin" } });
  m.userFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => users[where.id] ?? null);
  m.userUpdate.mockResolvedValue({});
});

describe("POST /api/admin/users/[id]/password", () => {
  it("el admin ya no puede cambiarse la PROPIA sin la actual → 403 use_self_service", async () => {
    const res = await post("admin-1");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("use_self_service");
    expect(m.userUpdate).not.toHaveBeenCalled();
    expect(m.recordAuditEvent).not.toHaveBeenCalled();
  });

  it("sigue sin poder tocar a otro platform_admin", async () => {
    const res = await post("admin-2");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("forbidden");
    expect(m.userUpdate).not.toHaveBeenCalled();
  });

  it("sigue fijando la de un usuario de comercio, cerrando sus sesiones", async () => {
    const res = await post("op-1");
    expect(res.status).toBe(200);
    const { where, data } = m.userUpdate.mock.calls[0][0];
    expect(where).toEqual({ id: "op-1" });
    expect(data.sessionVersion).toEqual({ increment: 1 });
    expect(await bcrypt.compare("Fijada-por-admin", data.passwordHash)).toBe(true);
    expect(JSON.stringify(m.recordAuditEvent.mock.calls)).not.toContain("Fijada-por-admin");
  });

  it("no admin → 403; usuario inexistente → 404; contraseña corta → 400", async () => {
    m.auth.mockResolvedValueOnce({ user: { id: "op-1", role: "operator" } });
    expect((await post("op-1")).status).toBe(403);
    expect((await post("nadie")).status).toBe(404);
    expect((await post("op-1", "corta")).status).toBe(400);
    expect(m.userUpdate).not.toHaveBeenCalled();
  });
});
