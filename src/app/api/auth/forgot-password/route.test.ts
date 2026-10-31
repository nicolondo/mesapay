// POST /api/auth/forgot-password — "olvidé mi contraseña" público del personal.
// Usa el emisor real (lib/passwordResetIssue) con la base y el mailer simulados.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PENDING_PASSWORD_HASH } from "@/lib/passwordReset";

const m = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  queryRaw: vi.fn(),
  tokenUpdateMany: vi.fn(),
  tokenCreate: vi.fn(),
  order: [] as string[],
  rateLimit: vi.fn(),
  recordAuditEvent: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  sendRestaurantWelcomeEmail: vi.fn(),
  afterTasks: [] as Array<() => unknown>,
}));

vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: m.rateLimit }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.recordAuditEvent }));
vi.mock("@/lib/mailer", () => ({
  sendPasswordResetEmail: m.sendPasswordResetEmail,
  sendRestaurantWelcomeEmail: m.sendRestaurantWelcomeEmail,
}));
vi.mock("next-intl/server", () => ({ getLocale: async () => "pt" }));
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
        $queryRaw: m.queryRaw,
        passwordResetToken: { updateMany: m.tokenUpdateMany, create: m.tokenCreate },
      }),
  },
}));

import { POST } from "./route";

const post = (body: unknown, ip = "198.51.100.4") =>
  POST(
    new Request("http://localhost/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": ip },
      body: JSON.stringify(body),
    }),
  ) as Promise<Response>;

const runAfter = async () => {
  const tasks = m.afterTasks.splice(0);
  for (const task of tasks) await task();
};

const staff = (over: Record<string, unknown> = {}) => ({
  id: "admin-1",
  email: "admin@mesapay.co",
  name: "Admin",
  role: "platform_admin",
  passwordHash: "$2a$10$hash",
  disabledAt: null,
  restaurantId: null,
  restaurant: null,
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  m.afterTasks.length = 0;
  m.order.length = 0;
  m.rateLimit.mockResolvedValue(true);
  m.userFindUnique.mockResolvedValue(null);
  m.queryRaw.mockImplementation(async () => {
    m.order.push("lock");
    return [];
  });
  m.tokenUpdateMany.mockImplementation(async () => {
    m.order.push("invalidate");
    return { count: 1 };
  });
  m.tokenCreate.mockImplementation(async () => {
    m.order.push("create");
    return {};
  });
  m.sendPasswordResetEmail.mockResolvedValue(true);
  m.sendRestaurantWelcomeEmail.mockResolvedValue(true);
});

describe("POST /api/auth/forgot-password", () => {
  it("correo existente y no existente reciben exactamente la misma respuesta", async () => {
    m.userFindUnique.mockResolvedValueOnce(staff());
    const existing = await post({ email: "Admin@MesaPay.co " });
    const existingBody = await existing.text();
    // La respuesta sale antes de mirar la base: el tiempo no depende del correo.
    expect(m.userFindUnique).not.toHaveBeenCalled();
    await runAfter();

    const missing = await post({ email: "nadie@ejemplo.com" });
    const missingBody = await missing.text();
    await runAfter();

    expect(existing.status).toBe(200);
    expect(missing.status).toBe(existing.status);
    expect(missingBody).toBe(existingBody);
    expect(JSON.parse(existingBody)).toEqual({ ok: true });
    expect(m.sendPasswordResetEmail).toHaveBeenCalledOnce();
  });

  it("correo del personal (platform_admin): emite un token de 1 h, guarda sólo el hash y manda el enlace", async () => {
    m.userFindUnique.mockResolvedValue(staff());
    const before = Date.now();
    await post({ email: "admin@mesapay.co" });
    await runAfter();

    expect(m.userFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "admin@mesapay.co" } }),
    );
    expect(m.tokenCreate).toHaveBeenCalledOnce();
    const { data } = m.tokenCreate.mock.calls[0][0];
    expect(data.userId).toBe("admin-1");
    const ttl = data.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThan(59 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(60 * 60 * 1000 + 1000);

    const [to, url, locale] = m.sendPasswordResetEmail.mock.calls[0];
    expect(to).toEqual({ email: "admin@mesapay.co", name: "Admin" });
    expect(locale).toBe("pt");
    const token = String(url).split("/restablecer/")[1];
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    // En la base queda el SHA-256, nunca el token.
    expect(data.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(m.tokenCreate.mock.calls)).not.toContain(token);
    // Y la auditoría tampoco lleva el token.
    expect(m.recordAuditEvent).toHaveBeenCalledOnce();
    expect(JSON.stringify(m.recordAuditEvent.mock.calls)).not.toContain(token);
  });

  it("un token nuevo invalida los pendientes anteriores del usuario (con la fila bloqueada)", async () => {
    m.userFindUnique.mockResolvedValue(staff({ id: "op-9", role: "operator", restaurantId: "r1", restaurant: { name: "Son y Melona" } }));
    await post({ email: "admin@mesapay.co" });
    await runAfter();
    expect(m.tokenUpdateMany).toHaveBeenCalledWith({
      where: { userId: "op-9", usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    expect(m.order).toEqual(["lock", "invalidate", "create"]);
  });

  it("correo inexistente: no emite token ni manda nada", async () => {
    await post({ email: "nadie@ejemplo.com" });
    await runAfter();
    expect(m.tokenCreate).not.toHaveBeenCalled();
    expect(m.sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(m.recordAuditEvent).not.toHaveBeenCalled();
  });

  it("comensal (fila legado role=customer) y usuario desactivado quedan fuera", async () => {
    m.userFindUnique.mockResolvedValueOnce(staff({ role: "customer" }));
    const diner = await post({ email: "comensal@ejemplo.com" });
    await runAfter();
    m.userFindUnique.mockResolvedValueOnce(staff({ role: "comercial", disabledAt: new Date() }));
    const disabled = await post({ email: "baja@ejemplo.com" });
    await runAfter();

    expect(diner.status).toBe(200);
    expect(disabled.status).toBe(200);
    expect(m.tokenCreate).not.toHaveBeenCalled();
    expect(m.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("dueño invitado que aún no creó su clave recibe la bienvenida (24 h), no un reset", async () => {
    m.userFindUnique.mockResolvedValue(
      staff({ role: "operator", passwordHash: PENDING_PASSWORD_HASH, restaurantId: "r1", restaurant: { name: "Son y Melona" } }),
    );
    const before = Date.now();
    await post({ email: "dueno@ejemplo.com" });
    await runAfter();
    expect(m.sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(m.sendRestaurantWelcomeEmail).toHaveBeenCalledOnce();
    const ttl = m.tokenCreate.mock.calls[0][0].data.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThan(23 * 60 * 60 * 1000);
  });

  it("rate limit por IP → 429 sin encolar trabajo", async () => {
    m.rateLimit.mockImplementation(async (key: string) => !key.startsWith("forgot-password-ip:"));
    const res = await post({ email: "admin@mesapay.co" });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("rate_limited");
    expect(m.rateLimit).toHaveBeenCalledWith("forgot-password-ip:198.51.100.4", 10, 3600);
    expect(m.afterTasks).toHaveLength(0);
  });

  it("rate limit por correo → 429 igual exista o no la cuenta", async () => {
    m.rateLimit.mockImplementation(async (key: string) => !key.startsWith("forgot-password-email:"));
    m.userFindUnique.mockResolvedValue(staff());
    const res = await post({ email: "ADMIN@mesapay.co" });
    expect(res.status).toBe(429);
    expect(m.rateLimit).toHaveBeenCalledWith("forgot-password-email:admin@mesapay.co", 3, 3600);
    expect(m.afterTasks).toHaveLength(0);
    expect(m.userFindUnique).not.toHaveBeenCalled();
  });

  it("correo inválido → 400", async () => {
    expect((await post({ email: "no-es-correo" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(m.rateLimit).not.toHaveBeenCalled();
  });

  it("si falla la base en segundo plano, no revienta ni filtra el correo en el log", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    m.userFindUnique.mockRejectedValue(new Error("db down for admin@mesapay.co"));
    const res = await post({ email: "admin@mesapay.co" });
    expect(res.status).toBe(200);
    await expect(runAfter()).resolves.toBeUndefined();
    expect(JSON.stringify(spy.mock.calls)).not.toContain("admin@mesapay.co");
    spy.mockRestore();
  });
});
