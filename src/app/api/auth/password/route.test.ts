// POST /api/auth/password — "Cambiar mi contraseña" del personal con sesión.
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdateMany: vi.fn(),
  tokenUpdateMany: vi.fn(),
  rateLimit: vi.fn(),
  recordAuditEvent: vi.fn(),
  sendPasswordChangedEmail: vi.fn(),
  afterTasks: [] as Array<() => unknown>,
}));

vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/auth", () => ({ auth: m.auth, signIn: m.signIn }));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: m.rateLimit }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.recordAuditEvent }));
vi.mock("@/lib/mailer", () => ({
  sendPasswordChangedEmail: m.sendPasswordChangedEmail,
}));
vi.mock("next-intl/server", () => ({ getLocale: async () => "es" }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => {
    m.afterTasks.push(task);
  },
}));
vi.mock("@/lib/db", () => ({
  db: {
    user: { findUnique: m.userFindUnique },
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        user: { updateMany: m.userUpdateMany },
        passwordResetToken: { updateMany: m.tokenUpdateMany },
      }),
  },
}));

import { POST } from "./route";

const CURRENT = "Actual-2026!";
const NEW = "Nueva-Clave-2026";
let currentHash = "";
const adminRow = () => ({
  id: "admin-1",
  email: "admin@mesapay.co",
  name: "Admin",
  role: "platform_admin",
  restaurantId: null,
  passwordHash: currentHash,
  disabledAt: null as Date | null,
});

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  ) as Promise<Response>;

beforeEach(async () => {
  vi.resetAllMocks();
  m.afterTasks.length = 0;
  currentHash ||= await bcrypt.hash(CURRENT, 4);
  m.auth.mockResolvedValue({
    user: { id: "admin-1", email: "admin@mesapay.co", role: "platform_admin" },
  });
  m.rateLimit.mockResolvedValue(true);
  m.userFindUnique.mockResolvedValue(adminRow());
  m.userUpdateMany.mockResolvedValue({ count: 1 });
  m.tokenUpdateMany.mockResolvedValue({ count: 0 });
  m.signIn.mockResolvedValue("http://localhost/admin/cuenta");
  m.sendPasswordChangedEmail.mockResolvedValue(true);
});

describe("POST /api/auth/password", () => {
  it("sin sesión → 401 y no toca la base", async () => {
    m.auth.mockResolvedValue(null);
    const res = await post({ currentPassword: CURRENT, newPassword: NEW });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
    expect(m.userFindUnique).not.toHaveBeenCalled();
    expect(m.userUpdateMany).not.toHaveBeenCalled();
  });

  it("con la actual correcta: guarda el hash nuevo, cierra las sesiones y conserva la actual", async () => {
    const res = await post({ currentPassword: CURRENT, newPassword: NEW });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessionKept: true });

    expect(m.userUpdateMany).toHaveBeenCalledOnce();
    const { where, data } = m.userUpdateMany.mock.calls[0][0];
    // Sólo si nadie la cambió en el medio.
    expect(where).toEqual({ id: "admin-1", passwordHash: currentHash });
    // sessionVersion sube → el callback jwt rechaza TODOS los JWT anteriores.
    expect(data.sessionVersion).toEqual({ increment: 1 });
    expect(await bcrypt.compare(NEW, data.passwordHash)).toBe(true);
    expect(data.passwordHash).not.toContain(NEW);
    // Los enlaces de restablecimiento pendientes dejan de servir.
    expect(m.tokenUpdateMany).toHaveBeenCalledWith({
      where: { userId: "admin-1", usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    // La sesión de este navegador se re-emite con la contraseña nueva.
    expect(m.signIn).toHaveBeenCalledWith("credentials", {
      email: "admin@mesapay.co",
      password: NEW,
      redirect: false,
    });
  });

  it("deja auditoría con el actor y SIN la contraseña", async () => {
    await post({ currentPassword: CURRENT, newPassword: NEW });
    expect(m.recordAuditEvent).toHaveBeenCalledOnce();
    const event = m.recordAuditEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      kind: "user.password_change",
      target: { type: "user", id: "admin-1" },
      actor: { userId: "admin-1", email: "admin@mesapay.co", role: "platform_admin" },
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(NEW);
    expect(serialized).not.toContain(CURRENT);
    expect(serialized).not.toContain(currentHash);
  });

  it("manda el aviso por correo después de responder", async () => {
    await post({ currentPassword: CURRENT, newPassword: NEW });
    expect(m.sendPasswordChangedEmail).not.toHaveBeenCalled();
    await Promise.all(m.afterTasks.map((task) => task()));
    expect(m.sendPasswordChangedEmail).toHaveBeenCalledWith(
      { email: "admin@mesapay.co", name: "Admin" },
      "es",
    );
  });

  it("con la actual incorrecta → 400 wrong_current_password, sin cambios", async () => {
    const res = await post({ currentPassword: "otra-cosa-123", newPassword: NEW });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("wrong_current_password");
    expect(m.userUpdateMany).not.toHaveBeenCalled();
    expect(m.signIn).not.toHaveBeenCalled();
    expect(m.recordAuditEvent).not.toHaveBeenCalled();
  });

  it("nueva igual a la actual → 400 same_password", async () => {
    const res = await post({ currentPassword: CURRENT, newPassword: CURRENT });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("same_password");
    expect(m.userUpdateMany).not.toHaveBeenCalled();
  });

  it("nueva demasiado corta → 400 sin gastar intentos ni mirar la base", async () => {
    const res = await post({ currentPassword: CURRENT, newPassword: "1234567" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("new_password_too_short");
    expect(m.rateLimit).not.toHaveBeenCalled();
    expect(m.userFindUnique).not.toHaveBeenCalled();
  });

  it("nueva de más de 100 caracteres → 400 new_password_too_long", async () => {
    const res = await post({ currentPassword: CURRENT, newPassword: "x".repeat(101) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("new_password_too_long");
  });

  it("cuerpo mal formado → 400 invalid", async () => {
    expect((await post({ newPassword: NEW })).status).toBe(400);
    expect((await post(null)).status).toBe(400);
    expect(m.userUpdateMany).not.toHaveBeenCalled();
  });

  it("rate limit por usuario → 429 antes de comparar la actual", async () => {
    m.rateLimit.mockResolvedValue(false);
    const res = await post({ currentPassword: CURRENT, newPassword: NEW });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("rate_limited");
    expect(m.rateLimit).toHaveBeenCalledWith("password-change:admin-1", 5, 900);
    expect(m.userFindUnique).not.toHaveBeenCalled();
  });

  it("si otro cambio ganó la carrera → 409 y no re-emite la sesión", async () => {
    m.userUpdateMany.mockResolvedValue({ count: 0 });
    const res = await post({ currentPassword: CURRENT, newPassword: NEW });
    expect(res.status).toBe(409);
    expect(m.tokenUpdateMany).not.toHaveBeenCalled();
    expect(m.signIn).not.toHaveBeenCalled();
  });

  it("si el re-login falla, igual cambia la contraseña y avisa sessionKept:false", async () => {
    m.signIn.mockRejectedValue(new Error("CredentialsSignin"));
    const res = await post({ currentPassword: CURRENT, newPassword: NEW });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessionKept: false });
    expect(m.userUpdateMany).toHaveBeenCalledOnce();
  });

  it("usuario desactivado → 401", async () => {
    m.userFindUnique.mockResolvedValue({ ...adminRow(), disabledAt: new Date() });
    const res = await post({ currentPassword: CURRENT, newPassword: NEW });
    expect(res.status).toBe(401);
    expect(m.userUpdateMany).not.toHaveBeenCalled();
  });
});
