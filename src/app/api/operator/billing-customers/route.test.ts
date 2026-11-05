import { beforeEach, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
const m = vi.hoisted(() => ({ auth: vi.fn(), active: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), rate: vi.fn(), queryRaw: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.active }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: m.rate }));
vi.mock("@/lib/db", () => ({ db: { $queryRaw: m.queryRaw, billingCustomer: { findMany: m.findMany, create: m.create, update: m.update } } }));
import { GET, POST } from "./route";
import { PATCH } from "./[id]/route";
// Lo que manda el formulario hoy: sin dirección ni municipio.
const minimal = { customerName: "Cliente prueba", docType: "NIT", docNumber: "901944469-1", email: "cliente@example.test" };
// Un cliente viejo que todavía manda dirección y municipio.
const payload = { ...minimal, address: "Calle 10 # 20-30", municipalityCode: "05001" };
const req = (method = "POST", body: unknown = payload) => new Request("http://localhost/api/operator/billing-customers", { method, headers: { "content-type": "application/json" }, ...(method !== "GET" ? { body: JSON.stringify(body) } : {}) });
const params = { params: Promise.resolve({ id: "customer-1" }) };
beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "user-1", role: "operator" } });
  m.active.mockResolvedValue("restaurant-1");
  m.rate.mockResolvedValue(true);
  m.findMany.mockResolvedValue([]);
  // Agregado vacío: ningún cliente coincide (la consulta de la página no corre).
  m.queryRaw.mockResolvedValue([{ count: 0, creditCount: 0, debtorCount: 0, overdueCount: 0, debtCents: BigInt(0), overdueCents: BigInt(0), allCount: 0, usesCredit: false }]);
  m.create.mockResolvedValue({ id: "customer-1" });
  m.update.mockResolvedValue({ id: "customer-1" });
});
it("creates a contact with canonical identity and only the session tenant", async () => {
  const response = await POST(req("POST", { ...payload, restaurantId: "foreign", city: "Bogotá" }));
  expect(response.status).toBe(201);
  expect(m.create).toHaveBeenCalledWith({ data: expect.objectContaining({ restaurantId: "restaurant-1", docNumber: "901944469", verificationDigit: "1", city: "Medellín" }) });
});
it("creates a contact without address or municipality: the nominative invoice no longer asks for them", async () => {
  const response = await POST(req("POST", minimal));
  expect(response.status).toBe(201);
  expect(m.create).toHaveBeenCalledWith({ data: expect.objectContaining({ restaurantId: "restaurant-1", docNumber: "901944469", verificationDigit: "1", address: null, municipalityCode: null, city: null, department: null }) });
});
it("updates a contact without address or municipality", async () => {
  expect((await PATCH(req("PATCH", minimal), params)).status).toBe(200);
  expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ address: null, municipalityCode: null, city: null, department: null }) }));
});
type RawSql = { sql: string; values: unknown[] };
const rawCalls = () => m.queryRaw.mock.calls.map((c) => c[0] as RawSql);
it("bounds searches to the current tenant and normalizes formatted document queries", async () => {
  const response = await GET(new Request("http://localhost/api/operator/billing-customers?q=901.944.469-1"));
  expect(response.status).toBe(200);
  const [aggregate] = rawCalls();
  expect(aggregate.values).toContain("restaurant-1");
  expect(aggregate.values).toContain("%901944469%");
  expect(aggregate.values).toContain("%901.944.469-1%");
  expect(aggregate.sql).toContain(`bc."restaurantId" = ?`);
  expect(await response.json()).toEqual({ customers: [], total: 0, page: 1, pageCount: 1, pageSize: 50, hasMore: false });
});
it("pages past the old 50-row cap and tells the picker there is more", async () => {
  m.queryRaw
    .mockResolvedValueOnce([{ count: 130, creditCount: 0, debtorCount: 0, overdueCount: 0, debtCents: BigInt(0), overdueCents: BigInt(0), allCount: 130, usesCredit: false }])
    .mockResolvedValueOnce([{ id: "customer-21", debtCents: BigInt(0), overdueCents: BigInt(0) }]);
  m.findMany.mockResolvedValue([{ id: "customer-21", restaurantId: "restaurant-1", customerName: "Cliente 21", docType: "CC", docNumber: "1020304050", verificationDigit: null, email: "c21@example.test", phone: null, address: null, municipalityCode: null, city: null, department: null, country: "CO", creditEnabled: true, creditLimitCents: null, creditTermsDays: 30, discountEnabled: false, discountBps: 0, createdAt: new Date("2026-11-01T00:00:00Z") }]);
  const response = await GET(new Request("http://localhost/api/operator/billing-customers?q=cliente&credit=1&page=2&pageSize=20&sort=relevance"));
  const body = await response.json();
  expect(body).toMatchObject({ total: 130, page: 2, pageCount: 7, pageSize: 20, hasMore: true });
  expect(body.customers).toEqual([expect.objectContaining({ id: "customer-21", debtCents: 0, overdueCents: 0 })]);
  const [, page] = rawCalls();
  // Página 2 de 20: LIMIT 20 OFFSET 20, sólo con crédito, documento exacto primero.
  expect(page.values.slice(-2)).toEqual([20, 20]);
  expect(page.sql).toContain(`"creditEnabled"`);
  expect(page.sql).toContain(`(upper("docNumber") = ?`);
  expect(m.findMany).toHaveBeenCalledWith({ where: { restaurantId: "restaurant-1", id: { in: ["customer-21"] } } });
});
it("caps the page size the API accepts", async () => {
  expect(await (await GET(new Request("http://localhost/api/operator/billing-customers?pageSize=5000"))).json()).toMatchObject({ pageSize: 50 });
});
it("allows the waiter picker but denies waiter creation and updates", async () => {
  m.auth.mockResolvedValue({ user: { id: "waiter", role: "mesero" } });
  expect((await GET(req("GET"))).status).toBe(200);
  expect((await POST(req())).status).toBe(401);
  expect((await PATCH(req("PATCH"), params)).status).toBe(401);
  expect(m.create).not.toHaveBeenCalled();
  expect(m.update).not.toHaveBeenCalled();
});
it.each([null, { user: { id: "guest", role: "customer" } }, { user: { id: "kitchen", role: "kitchen" } }])("denies unauthorized roles %j", async (session) => {
  m.auth.mockResolvedValue(session);
  expect((await GET(req("GET"))).status).toBe(401);
  expect((await POST(req())).status).toBe(401);
  expect(m.findMany).not.toHaveBeenCalled();
});
it("rejects missing active restaurant", async () => {
  m.active.mockResolvedValue(null);
  expect((await POST(req())).status).toBe(401);
});
it("validates documents before any write", async () => {
  const response = await POST(req("POST", { ...payload, docNumber: "901944469-9" }));
  expect(response.status).toBe(400);
  // El formulario ya no tiene campo de DV: el error se marca sobre el número.
  expect(await response.json()).toMatchObject({ error: "invalid", fieldErrors: { docNumber: ["invalid_verification_digit"] } });
  expect(m.create).not.toHaveBeenCalled();
});
it("returns a duplicate code for the database uniqueness guarantee", async () => {
  m.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "6" }));
  const response = await POST(req());
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "duplicate_document" });
});
it("updates using both customer id and restaurant scope", async () => {
  expect((await PATCH(req("PATCH"), params)).status).toBe(200);
  expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "customer-1", restaurantId: "restaurant-1" } }));
});
it("does not reveal another restaurant's customer", async () => {
  m.update.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("missing", { code: "P2025", clientVersion: "6" }));
  const response = await PATCH(req("PATCH"), params);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "not_found" });
});
it("rate limits reading contacts", async () => {
  m.rate.mockResolvedValue(false);
  expect((await GET(req("GET"))).status).toBe(429);
  expect(m.findMany).not.toHaveBeenCalled();
});
