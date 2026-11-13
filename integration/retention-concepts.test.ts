import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { POST as createConcept } from "../src/app/api/operator/accounting/retenciones/conceptos/route";
import { DELETE as deleteConcept, PATCH as patchConcept } from "../src/app/api/operator/accounting/retenciones/conceptos/[id]/route";
import { GET as configGet } from "../src/app/api/operator/accounting/retenciones/route";
import { GET as purchaseTaxContext } from "../src/app/api/operator/purchase-orders/tax-context/route";
import { GET as expenseTaxContext } from "../src/app/api/operator/expenses/tax-context/route";
import { POST as createExpense } from "../src/app/api/operator/expenses/route";

/**
 * Conceptos de retención creados por el comercio contra PostgreSQL real
 * (migración 20261113160000_retention_concepts_custom): la retención del
 * 1 % personalizada y una reteICA de 4,14 ‰ se guardan con la tarifa
 * exacta, aparecen en compras y gastos, un gasto la usa con su foto
 * exacta, y entonces ya no se puede borrar. La siembra (con candado) no se
 * repite al borrar todo.
 */
const scope = vi.hoisted(() => ({ restaurantId: "" }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { id: null, email: "dueno@example.test", role: "operator" } }) }));
vi.mock("../src/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: scope.restaurantId, country: "CO", userId: null }),
  isDenied: () => false,
}));
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}

type Handler = (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>;
const json = (body: unknown, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const create = async (body: unknown) => {
  const res = await createConcept(new Request("http://localhost/api/operator/accounting/retenciones/conceptos", json(body)));
  return { status: res.status, body: (await res.json()) as { concept?: { id: string; rateBps: number }; error?: string } };
};
const params = (id: string) => ({ params: Promise.resolve({ id }) });

let restaurantId = "";

beforeAll(async () => {
  const tenant = await db.restaurant.create({
    data: { name: "Retenciones propias", slug: `ret-propias-${randomUUID()}`, enabledModules: ["accounting", "purchasing"], purchaseIvaDeductible: true },
  });
  restaurantId = scope.restaurantId = tenant.id;
});

afterAll(async () => {
  if (restaurantId) {
    await db.auditEvent.deleteMany({ where: { restaurantId } });
    await db.restaurant.deleteMany({ where: { id: restaurantId } });
  }
  await db.$disconnect();
});

describe("conceptos de retención propios (PostgreSQL)", () => {
  it("crea la del 1 % y una reteICA de 4,14 ‰, aparecen en compras y gastos, y una usada no se borra", async () => {
    // La pantalla siembra el set estándar (una vez) y lista las cuentas por tipo.
    const config = (await (await configGet(new Request("http://localhost"))).json()) as {
      concepts: { name: string; thresholdUvt: number }[];
      accounts: { code: string; kind: string }[];
    };
    expect(config.concepts.find((c) => c.name === "Compras (2,5%)")?.thresholdUvt).toBe(10);
    expect(config.accounts).toEqual(expect.arrayContaining([expect.objectContaining({ code: "236505", kind: "retefuente" })]));

    const uno = await create({ kind: "retefuente", name: "Retención 1 %", ratePpm: 10_000, thresholdUvt: 2, accountCode: "236505", catalogKey: null });
    expect(uno.status).toBe(201);
    const ica = await create({ kind: "reteica", name: "ReteICA Bogotá", ratePpm: 4_140, thresholdUvt: 0, accountCode: "236805", catalogKey: "reteica_municipio" });
    expect(ica.status).toBe(201);
    expect(ica.body.concept!.rateBps).toBeCloseTo(41.4);
    expect(await db.retentionConcept.findUniqueOrThrow({ where: { id: ica.body.concept!.id } })).toMatchObject({
      rateBps: 41, ratePpm: 4_140, catalogKey: "reteica_municipio", isCustom: false, active: true,
    });
    expect((await create({ kind: "retefuente", name: "RETENCION 1 %", ratePpm: 10_000, thresholdUvt: 0, accountCode: "236505" })).status).toBe(409);
    expect(await db.auditEvent.count({ where: { restaurantId, kind: "retention_concept.create" } })).toBe(2);

    const purchase = (await (await purchaseTaxContext(new Request("http://localhost"))).json()) as { concepts: { id: string }[] };
    expect(purchase.concepts.map((c) => c.id).sort()).toEqual([uno.body.concept!.id, ica.body.concept!.id].sort());
    const expense = (await (await expenseTaxContext(new Request("http://localhost"))).json()) as { concepts: { id: string }[] };
    expect(expense.concepts.map((c) => c.id)).toEqual(expect.arrayContaining([uno.body.concept!.id, ica.body.concept!.id]));

    // Un gasto la usa: la foto guarda la tarifa exacta.
    const supplier = await db.supplier.create({ data: { restaurantId, name: "Transportes de prueba" } });
    const res = await createExpense(new Request("http://localhost/api/operator/expenses", json({
      category: "Fletes", date: "2026-11-10T17:00:00.000Z", supplierId: supplier.id, subtotalCents: 50_000_000,
      retentions: [{ conceptId: uno.body.concept!.id, amountCents: 500_000 }, { conceptId: ica.body.concept!.id, amountCents: 207_000 }],
    })));
    expect(res.status).toBe(201);
    const rows = await db.expenseRetention.findMany({ where: { conceptId: { in: [uno.body.concept!.id, ica.body.concept!.id] } }, orderBy: { kind: "asc" } });
    expect(rows.map((r) => [r.kind, r.rateBps, r.ratePpm, r.amountCents])).toEqual([
      ["retefuente", 100, 10_000, 500_000],
      ["reteica", 41, 4_140, 207_000],
    ]);

    const del = await (deleteConcept as unknown as Handler)(new Request("http://localhost", { method: "DELETE" }), params(uno.body.concept!.id));
    expect(del.status).toBe(409);
    expect(await del.json()).toEqual({ error: "concept_in_use" });
    const off = await (patchConcept as unknown as Handler)(new Request("http://localhost", json({ active: false }, "PATCH")), params(uno.body.concept!.id));
    expect(off.status).toBe(200);
    const listed = (await (await configGet(new Request("http://localhost"))).json()) as { concepts: { id: string; usedCount: number; active: boolean }[] };
    expect(listed.concepts.find((c) => c.id === uno.body.concept!.id)).toMatchObject({ usedCount: 1, active: false });
  });

  it("borrar todos los conceptos sin uso no los vuelve a sembrar", async () => {
    const unused = await db.retentionConcept.findMany({ where: { restaurantId, expenseRetentions: { none: {} } } });
    for (const c of unused) {
      const res = await (deleteConcept as unknown as Handler)(new Request("http://localhost", { method: "DELETE" }), params(c.id));
      expect(res.status).toBe(200);
    }
    const after = (await (await configGet(new Request("http://localhost"))).json()) as { concepts: { name: string }[] };
    expect(after.concepts.map((c) => c.name).sort()).toEqual(["ReteICA Bogotá", "Retención 1 %"]);
  });
});
