import { beforeEach, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
const m = vi.hoisted(() => ({ auth: vi.fn(), active: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), rate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.active }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: m.rate }));
vi.mock("@/lib/db", () => ({ db: { billingCustomer: { findMany: m.findMany, create: m.create, update: m.update } } }));
import { GET, POST } from "./route";
import { PATCH } from "./[id]/route";
const payload = { customerName: "Cliente prueba", docType: "NIT", docNumber: "901944469-1", email: "cliente@example.test", address: "Calle 10 # 20-30", municipalityCode: "05001" };
const req = (method = "POST", body: unknown = payload) => new Request("http://localhost/api/operator/billing-customers", { method, headers: { "content-type": "application/json" }, ...(method !== "GET" ? { body: JSON.stringify(body) } : {}) });
const params = { params: Promise.resolve({ id: "customer-1" }) };
beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "user-1", role: "operator" } });
  m.active.mockResolvedValue("restaurant-1");
  m.rate.mockResolvedValue(true);
  m.findMany.mockResolvedValue([]);
  m.create.mockResolvedValue({ id: "customer-1" });
  m.update.mockResolvedValue({ id: "customer-1" });
});
it("creates a contact with canonical identity and only the session tenant", async () => {
  const response = await POST(req("POST", { ...payload, restaurantId: "foreign", city: "Bogotá" }));
  expect(response.status).toBe(201);
  expect(m.create).toHaveBeenCalledWith({ data: expect.objectContaining({ restaurantId: "restaurant-1", docNumber: "901944469", verificationDigit: "1", city: "Medellín" }) });
});
it("bounds searches to the current tenant and normalizes formatted document queries", async () => {
  const response = await GET(new Request("http://localhost/api/operator/billing-customers?q=901.944.469-1"));
  expect(response.status).toBe(200);
  expect(m.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50, where: expect.objectContaining({ restaurantId: "restaurant-1", OR: expect.arrayContaining([{ docNumber: { contains: "901944469", mode: "insensitive" } }]) }) }));
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
  expect(await response.json()).toMatchObject({ error: "invalid", fieldErrors: { verificationDigit: expect.any(Array) } });
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
