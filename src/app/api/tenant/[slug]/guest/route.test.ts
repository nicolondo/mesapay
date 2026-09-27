import { beforeEach, expect, it, vi } from "vitest";

/**
 * Primer escaneo del QR: en producción `req.url` llega con el host interno
 * de `next start` y la redirección salía como
 * `location: https://localhost:3301/t/sonymelona/menu?table=...`.
 */
const m = vi.hoisted(() => ({ findFirst: vi.fn(), grant: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/db", () => ({ db: { table: { findFirst: m.findFirst } } }));
vi.mock("@/lib/guestAccess", () => ({ grantGuestAccess: m.grant }));
import { GET } from "./route";

const params = { params: Promise.resolve({ slug: "sonymelona" }) };
// Así llega detrás de nginx: req.url interno, host público en los headers.
const req = (query: string) =>
  new Request(`https://localhost:3301/api/tenant/sonymelona/guest?${query}`, {
    headers: { host: "mesapay.co", "x-forwarded-proto": "https" },
  });

beforeEach(() => {
  vi.resetAllMocks();
  m.findFirst.mockResolvedValue({ id: "table-1", restaurantId: "rest-1" });
  m.grant.mockResolvedValue(undefined);
});

it("pone la cookie y vuelve al menú con Location relativo, sin localhost", async () => {
  const res = await GET(req("table=tok123"), params);
  expect(res.status).toBe(307);
  const location = res.headers.get("location") ?? "";
  expect(location).not.toContain("localhost");
  expect(location).toBe("/t/sonymelona/menu?table=tok123");
  expect(m.grant).toHaveBeenCalledWith({ restaurantId: "rest-1", tableId: "table-1" });
  // El navegador lo resuelve contra la URL pública del QR.
  expect(new URL(location, "https://mesapay.co/api/tenant/sonymelona/guest").href).toBe("https://mesapay.co/t/sonymelona/menu?table=tok123");
});

it("conserva order y op, y descarta el resto de la query", async () => {
  const res = await GET(req("table=tok123&order=ord-9&op=1&x=evil"), params);
  const location = new URL(res.headers.get("location") ?? "", "https://mesapay.co");
  expect(location.pathname).toBe("/t/sonymelona/menu");
  expect(Object.fromEntries(location.searchParams)).toEqual({ table: "tok123", order: "ord-9", op: "1" });
  expect(res.headers.get("location")).not.toContain("localhost");
});

it("sin token o con mesa inexistente no redirige ni da acceso", async () => {
  expect((await GET(req(""), params)).status).toBe(400);
  m.findFirst.mockResolvedValue(null);
  expect((await GET(req("table=nope"), params)).status).toBe(404);
  expect(m.grant).not.toHaveBeenCalled();
});
