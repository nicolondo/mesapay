// POST /api/auth/reset-password — canje del enlace de restablecimiento.
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  tokenFindUnique: vi.fn(),
  userUpdateMany: vi.fn(),
  tokenUpdateMany: vi.fn(),
  recordAuditEvent: vi.fn(),
}));

vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.recordAuditEvent }));
vi.mock("@/lib/db", () => ({
  db: {
    passwordResetToken: { findUnique: m.tokenFindUnique },
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        user: { updateMany: m.userUpdateMany },
        passwordResetToken: { updateMany: m.tokenUpdateMany },
      }),
  },
}));

import { POST } from "./route";

const TOKEN = "a".repeat(64);
const NEW = "Recuperada-2026";

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  ) as Promise<Response>;

beforeEach(() => {
  vi.resetAllMocks();
  m.tokenFindUnique.mockResolvedValue({
    id: "tok-1",
    userId: "admin-1",
    usedAt: null,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    user: {
      passwordHash: "$2a$10$vieja",
      email: "admin@mesapay.co",
      role: "platform_admin",
      restaurantId: null,
    },
  });
  m.userUpdateMany.mockResolvedValue({ count: 1 });
  m.tokenUpdateMany.mockResolvedValue({ count: 1 });
});

describe("POST /api/auth/reset-password", () => {
  it("al canjear el enlace cierra todas las sesiones del usuario y quema los enlaces", async () => {
    const res = await post({ token: TOKEN, password: NEW });
    expect(res.status).toBe(200);

    expect(m.tokenFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tokenHash: createHash("sha256").update(TOKEN).digest("hex") },
      }),
    );
    const { where, data } = m.userUpdateMany.mock.calls[0][0];
    expect(where).toEqual({ id: "admin-1", passwordHash: "$2a$10$vieja" });
    expect(data.sessionVersion).toEqual({ increment: 1 });
    expect(await bcrypt.compare(NEW, data.passwordHash)).toBe(true);
    expect(m.tokenUpdateMany).toHaveBeenCalledWith({
      where: { userId: "admin-1", usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
  });

  it("audita el canje sin la contraseña ni el token", async () => {
    await post({ token: TOKEN, password: NEW });
    expect(m.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "user.password_reset",
        actor: { userId: "admin-1", email: "admin@mesapay.co", role: "platform_admin" },
      }),
    );
    const serialized = JSON.stringify(m.recordAuditEvent.mock.calls);
    expect(serialized).not.toContain(NEW);
    expect(serialized).not.toContain(TOKEN);
  });

  it("enlace usado o vencido → 400 genérico, sin tocar la contraseña", async () => {
    m.tokenFindUnique.mockResolvedValueOnce(null);
    expect((await post({ token: TOKEN, password: NEW })).status).toBe(400);
    m.tokenFindUnique.mockResolvedValueOnce({
      id: "tok-1",
      userId: "admin-1",
      usedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      user: { passwordHash: "x", email: "a@b.co", role: "operator", restaurantId: "r1" },
    });
    expect((await post({ token: TOKEN, password: NEW })).status).toBe(400);
    m.tokenFindUnique.mockResolvedValueOnce({
      id: "tok-2",
      userId: "admin-1",
      usedAt: null,
      expiresAt: new Date(Date.now() - 1000),
      user: { passwordHash: "x", email: "a@b.co", role: "operator", restaurantId: "r1" },
    });
    expect((await post({ token: TOKEN, password: NEW })).status).toBe(400);
    expect(m.userUpdateMany).not.toHaveBeenCalled();
    expect(m.recordAuditEvent).not.toHaveBeenCalled();
  });
});
