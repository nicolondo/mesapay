// POST /api/client-log: los errores de impresión del navegador, con el user
// agent, en los logs del servidor. Sin datos personales.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ auth: vi.fn(), rateLimit: vi.fn() }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: m.rateLimit }));

import { POST } from "./route";

const UA = "Mozilla/5.0 (Android 11; Mobile; rv:107.0) Gecko/107.0 Firefox/107.0";
const post = (body: unknown) =>
  (POST as unknown as (req: Request) => Promise<Response>)(
    new Request("http://localhost/api/client-log", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "u-1", role: "terminal", restaurantId: "rest-1", email: "x@y.co" } });
  m.rateLimit.mockResolvedValue(true);
});

describe("POST /api/client-log", () => {
  it("registra evento, error, ruta sin consulta, user agent, rol y comercio — sin el correo", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ event: "device_print_failed", name: "NotAllowedError", message: "nope", path: "/factura/x?w=55" });
    expect(res.status).toBe(204);
    expect(log).toHaveBeenCalledWith("client_error", {
      event: "device_print_failed",
      name: "NotAllowedError",
      message: "nope",
      path: "/factura/x",
      userAgent: UA,
      role: "terminal",
      restaurantId: "rest-1",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("x@y.co");
    log.mockRestore();
  });

  it("sin sesión 401; con demasiados, 429; un evento desconocido, 400", async () => {
    m.auth.mockResolvedValue(null);
    expect((await post({ event: "device_print_failed" })).status).toBe(401);
    m.auth.mockResolvedValue({ user: { id: "u-1", role: "mesero" } });
    m.rateLimit.mockResolvedValue(false);
    expect((await post({ event: "device_print_failed" })).status).toBe(429);
    m.rateLimit.mockResolvedValue(true);
    expect((await post({ event: "otra_cosa" })).status).toBe(400);
  });
});
