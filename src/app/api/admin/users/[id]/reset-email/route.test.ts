// POST /api/admin/users/[id]/reset-email — tras extraer la emisión a
// lib/passwordResetIssue debe comportarse igual que antes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  userFindUnique: vi.fn(),
  issue: vi.fn(),
  recordAuditEvent: vi.fn(),
}));

vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.recordAuditEvent }));
vi.mock("@/lib/passwordResetIssue", () => ({ issuePasswordResetLink: m.issue }));
vi.mock("@/lib/db", () => ({ db: { user: { findUnique: m.userFindUnique } } }));

import { POST } from "./route";

const post = (id: string) =>
  POST(new Request(`http://localhost/api/admin/users/${id}/reset-email`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  }) as Promise<Response>;

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "admin-1", role: "platform_admin" } });
  m.issue.mockResolvedValue({ sent: true, welcome: false });
});

describe("POST /api/admin/users/[id]/reset-email", () => {
  it("emite el enlace con el helper compartido y devuelve si salió", async () => {
    const user = { id: "op-1", email: "op@x.co", name: null, role: "operator", passwordHash: "h", restaurant: { name: "R" } };
    m.userFindUnique.mockResolvedValue(user);
    const res = await post("op-1");
    expect(await res.json()).toEqual({ ok: true, sent: true });
    expect(m.issue).toHaveBeenCalledWith(user);
    expect(m.recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "user.reset_email" }));
  });

  it("no deja mandarle a otro platform_admin", async () => {
    m.userFindUnique.mockResolvedValue({ id: "admin-2", role: "platform_admin" });
    expect((await post("admin-2")).status).toBe(403);
    expect(m.issue).not.toHaveBeenCalled();
  });
});
