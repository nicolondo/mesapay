import { beforeEach, expect, it, vi } from "vitest";

/**
 * Mismo problema que el QR: `new URL("/operator", req.url)` llevaba el host
 * interno de `next start` (localhost) detrás de nginx.
 */
const m = vi.hoisted(() => ({ auth: vi.fn(), set: vi.fn(), del: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: m.set, delete: m.del }) }));
import { GET } from "./route";

const req = (query = "") =>
  new Request(`https://localhost:3301/api/operator/shell-flag${query}`, {
    headers: { host: "mesapay.co", "x-forwarded-proto": "https" },
  });

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "u1", role: "operator" } });
});

it("sin sesión staff manda a /signin con Location relativo", async () => {
  m.auth.mockResolvedValue(null);
  const res = await GET(req("?to=classic"));
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe("/signin");
  expect(m.set).not.toHaveBeenCalled();
});

it("a un mesero también lo manda a /signin", async () => {
  m.auth.mockResolvedValue({ user: { id: "u2", role: "mesero" } });
  expect((await GET(req())).headers.get("location")).toBe("/signin");
});

it("?to=classic pone la cookie y vuelve a /operator sin localhost", async () => {
  const res = await GET(req("?to=classic"));
  expect(res.status).toBe(307);
  const location = res.headers.get("location") ?? "";
  expect(location).toBe("/operator");
  expect(location).not.toContain("localhost");
  expect(m.set).toHaveBeenCalledWith("mp_shell", "classic", expect.objectContaining({ httpOnly: true, path: "/" }));
});

it("?to=cockpit borra la cookie y vuelve a /operator", async () => {
  const res = await GET(req("?to=cockpit"));
  expect(res.headers.get("location")).toBe("/operator");
  expect(m.del).toHaveBeenCalledWith("mp_shell");
});
