// Revocación de sesiones de Auth.js por `sessionVersion`: el mecanismo del que
// dependen "cambiar mi contraseña" y el canje de un enlace de restablecimiento.
// Se prueba el callback `jwt` y el `authorize` reales de src/auth.ts.
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

type JwtArgs = { token: Record<string, unknown>; user?: Record<string, unknown> };
type Config = {
  callbacks: { jwt: (a: JwtArgs) => Promise<Record<string, unknown> | null> };
  providers: Array<{
    authorize: (raw: unknown, req: Request) => Promise<Record<string, unknown> | null>;
  }>;
};

const m = vi.hoisted(() => ({
  config: null as unknown,
  userFindUnique: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("next-auth", () => ({
  default: (config: unknown) => {
    m.config = config;
    return { handlers: {}, signIn: vi.fn(), signOut: vi.fn(), auth: vi.fn() };
  },
}));
vi.mock("next-auth/providers/credentials", () => ({
  default: (options: Record<string, unknown>) => ({ id: "credentials", type: "credentials", ...options }),
}));
vi.mock("@/lib/db", () => ({ db: { user: { findUnique: m.userFindUnique } } }));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: m.rateLimit }));

await import("./auth");
const config = () => m.config as Config;

let dbVersion = 3;
let dbHash = "";
const row = () => ({
  id: "admin-1",
  email: "admin@mesapay.co",
  name: "Admin",
  passwordHash: dbHash,
  role: "platform_admin",
  restaurantId: null,
  groupId: null,
  disabledAt: null,
  sessionVersion: dbVersion,
});

beforeEach(async () => {
  vi.clearAllMocks();
  dbVersion = 3;
  dbHash = await bcrypt.hash("Vieja-2026!", 4);
  m.rateLimit.mockResolvedValue(true);
  m.userFindUnique.mockImplementation(async () => row());
});

describe("sesiones del personal y sessionVersion", () => {
  it("un JWT emitido antes del cambio muere; el re-emitido con la clave nueva vive", async () => {
    const { jwt } = config().callbacks;
    const before = { userId: "admin-1", sessionVersion: 3, role: "platform_admin" };
    expect(await jwt({ token: { ...before } })).not.toBeNull();

    // Cambio de contraseña: el trigger revoke_sessions (y la ruta) suben la versión.
    dbVersion = 4;
    dbHash = await bcrypt.hash("Nueva-2026!", 4);
    // Cualquier otra sesión abierta (otro navegador, otro dispositivo) queda fuera.
    expect(await jwt({ token: { ...before } })).toBeNull();

    // La ruta vuelve a iniciar sesión con la clave nueva → token con versión 4.
    const req = new Request("http://localhost/api/auth/callback/credentials", {
      headers: { "x-real-ip": "203.0.113.7" },
    });
    const authorize = config().providers[0].authorize;
    expect(await authorize({ email: "admin@mesapay.co", password: "Vieja-2026!" }, req)).toBeNull();
    const user = await authorize({ email: "admin@mesapay.co", password: "Nueva-2026!" }, req);
    expect(user).toMatchObject({ id: "admin-1", sessionVersion: 4 });
    const fresh = await jwt({ token: {}, user: user! });
    expect(fresh).toMatchObject({ userId: "admin-1", sessionVersion: 4 });
    expect(await jwt({ token: fresh! })).not.toBeNull();
  });
});
