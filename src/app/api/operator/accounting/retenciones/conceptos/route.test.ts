// Crear, editar y borrar conceptos de retención (Contabilidad › Impuestos),
// de punta a punta contra una BD en memoria: desde el catálogo y
// personalizado (la retención del 1 %), las validaciones (tarifa, nombre
// repetido, cuenta), que uno usado no se borra, la auditoría, y que el
// concepto nuevo aparece de inmediato en el contexto de impuestos de
// compras y de gastos.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

const m = vi.hoisted(() => ({
  concepts: [] as Row[],
  expenseRetentions: [] as { conceptId: string | null }[],
  config: null as null | Record<string, unknown>,
  accounts: [] as { code: string; name: string; postable: boolean; active: boolean }[],
  audit: vi.fn(),
  seq: 0,
}));

vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: "r1", country: "CO" }),
  isDenied: (ctx: object) => "error" in ctx,
}));
vi.mock("@/lib/erp/ledger", () => ({ ensureChartOfAccounts: async () => {} }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.audit }));
vi.mock("@/lib/db", () => {
  const matches = (r: Row, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const o = v as { not?: unknown; in?: unknown[] };
        if ("not" in o) return r[k] !== o.not;
        if ("in" in o) return o.in!.includes(r[k]);
      }
      return r[k] === v;
    });
  const sorted = (rows: Row[]) =>
    [...rows].sort((a, b) =>
      String(a.kind).localeCompare(String(b.kind)) || String(a.name).localeCompare(String(b.name)),
    );
  const db = {
    accountingConfig: {
      findUnique: async () => m.config,
      upsert: async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        m.config = m.config ? { ...m.config, ...update } : { uvtCents: 5_237_400, closedThrough: null, nextVoucherNumber: 1, ...create };
        return m.config;
      },
    },
    retentionConcept: {
      count: async ({ where }: { where: Record<string, unknown> }) => m.concepts.filter((r) => matches(r, where)).length,
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        for (const d of data) m.concepts.push({ id: `seed${++m.seq}`, active: false, isCustom: false, catalogKey: null, ratePpm: null, ...d });
        return { count: data.length };
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => sorted(m.concepts.filter((r) => matches(r, where))),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => m.concepts.find((r) => matches(r, where)) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `c${++m.seq}`, createdAt: new Date(), ...data } as Row;
        m.concepts.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const i = m.concepts.findIndex((r) => r.id === where.id);
        m.concepts[i] = { ...m.concepts[i]!, ...data };
        return m.concepts[i];
      },
      delete: async ({ where }: { where: { id: string } }) => {
        m.concepts = m.concepts.filter((r) => r.id !== where.id);
      },
    },
    expenseRetention: {
      count: async ({ where }: { where: { conceptId: string } }) =>
        m.expenseRetentions.filter((r) => r.conceptId === where.conceptId).length,
      groupBy: async () => {
        const counts = new Map<string, number>();
        for (const r of m.expenseRetentions) if (r.conceptId) counts.set(r.conceptId, (counts.get(r.conceptId) ?? 0) + 1);
        return [...counts].map(([conceptId, n]) => ({ conceptId, _count: { _all: n } }));
      },
    },
    ledgerAccount: {
      findMany: async ({ where }: { where: { OR: { code: { startsWith: string } }[] } }) =>
        m.accounts
          .filter((a) => a.postable && a.active && where.OR.some((o) => a.code.startsWith(o.code.startsWith)))
          .map((a) => ({ code: a.code, name: a.name })),
    },
    restaurant: { findUnique: async () => ({ purchaseIvaDeductible: false }) },
    $executeRaw: async () => 0,
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { db };
});

import { POST } from "./route";
import { PATCH, DELETE } from "./[id]/route";
import { GET as GET_CONFIG, PATCH as PATCH_CONFIG } from "../route";
import { GET as GET_PURCHASE_CTX } from "../../../purchase-orders/tax-context/route";
import { GET as GET_EXPENSE_CTX } from "../../../expenses/tax-context/route";

const post = (body: unknown) =>
  POST(new Request("http://x/api/operator/accounting/retenciones/conceptos", { method: "POST", body: JSON.stringify(body) }));
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (id: string, body: unknown) =>
  PATCH(new Request(`http://x/c/${id}`, { method: "PATCH", body: JSON.stringify(body) }), params(id));
const del = (id: string) => DELETE(new Request(`http://x/c/${id}`, { method: "DELETE" }), params(id));

const UNO = {
  kind: "retefuente",
  name: "Retención 1 %",
  ratePpm: 10_000,
  thresholdUvt: 2,
  accountCode: "236505",
  catalogKey: null,
};

beforeEach(() => {
  m.concepts = [];
  m.expenseRetentions = [];
  m.config = null;
  m.seq = 0;
  m.audit.mockReset();
  m.accounts = [
    { code: "2365", name: "Retención en la fuente", postable: false, active: true },
    { code: "236505", name: "Retención en la fuente por pagar", postable: true, active: true },
    { code: "236525", name: "Retención por servicios", postable: true, active: true },
    { code: "236705", name: "ReteIVA por pagar", postable: true, active: true },
    { code: "236805", name: "ReteICA por pagar", postable: true, active: true },
    { code: "110505", name: "Caja general", postable: true, active: true },
  ];
});

describe("POST /retenciones/conceptos — crear", () => {
  it("personalizado: la retención del 1 % queda activa, con la tarifa exacta, marcada como personalizada y auditada", async () => {
    const res = await post(UNO);
    expect(res.status).toBe(201);
    const { concept } = await res.json();
    expect(concept).toMatchObject({
      kind: "retefuente",
      name: "Retención 1 %",
      ratePpm: 10_000,
      rateBps: 100,
      base: "subtotal",
      thresholdUvt: 2,
      accountCode: "236505",
      active: true,
      isCustom: true,
      catalogKey: null,
      usedCount: 0,
    });
    // La versión anterior del código lee rateBps: va redondeado.
    expect(m.concepts.find((c) => c.id === concept.id)).toMatchObject({ rateBps: 100, ratePpm: 10_000 });
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "retention_concept.create",
        restaurantId: "r1",
        target: { type: "retention_concept", id: concept.id },
        summary: expect.stringContaining("«Retención 1 %» (1 %)"),
      }),
    );
  });

  it("del catálogo: guarda su clave; la base la fija el tipo (reteIVA sobre el IVA)", async () => {
    const res = await post({
      kind: "reteiva",
      name: "ReteIVA — servicios",
      ratePpm: 150_000,
      thresholdUvt: 2,
      accountCode: "236705",
      catalogKey: "reteiva_servicios",
    });
    expect(res.status).toBe(201);
    const { concept } = await res.json();
    expect(concept).toMatchObject({ catalogKey: "reteiva_servicios", isCustom: false, base: "tax", ratePpm: 150_000 });
  });

  it("reteICA por mil: 4,14 ‰ se guarda exacta (4.140 ppm) y sale con 41,4 bps", async () => {
    const res = await post({ ...UNO, kind: "reteica", name: "ReteICA Bogotá comercio", ratePpm: 4_140, thresholdUvt: 0, accountCode: "236805" });
    expect(res.status).toBe(201);
    const { concept } = await res.json();
    expect(concept.rateBps).toBeCloseTo(41.4);
    expect(m.concepts.find((c) => c.id === concept.id)).toMatchObject({ rateBps: 41, ratePpm: 4_140 });
  });

  it("valida la tarifa (0 o más de 100 %)", async () => {
    for (const ratePpm of [0, 1_000_001, 1.5]) {
      const res = await post({ ...UNO, ratePpm });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "rate_invalid" });
    }
    expect(m.concepts.filter((c) => c.isCustom)).toEqual([]);
  });

  it("nombre repetido en el mismo tipo (sin importar mayúsculas ni tildes) → 409", async () => {
    expect((await post(UNO)).status).toBe(201);
    const res = await post({ ...UNO, name: "  RETENCIÓN 1 % " });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "name_taken" });
    // Contra un sembrado también.
    const seeded = await post({ ...UNO, name: "compras (2,5%)" });
    expect(seeded.status).toBe(409);
  });

  it("cuenta: debe ser imputable, del plan y del tipo", async () => {
    for (const accountCode of ["110505", "236705", "2365", "236599"]) {
      const res = await post({ ...UNO, accountCode });
      expect(res.status, accountCode).toBe(400);
      expect(await res.json()).toEqual({ error: "account_invalid" });
    }
  });

  it("una clave del catálogo de otro tipo no se acepta", async () => {
    const res = await post({ ...UNO, catalogKey: "reteiva_compras" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "catalog_invalid" });
  });
});

describe("PATCH / DELETE /retenciones/conceptos/[id]", () => {
  it("edita tarifa, umbral, nombre y cuenta; no deja repetir el nombre", async () => {
    const { concept } = await (await post(UNO)).json();
    const res = await patch(concept.id, { ratePpm: 15_000, thresholdUvt: 10, accountCode: "236525", name: "Retención 1,5 %" });
    expect(res.status).toBe(200);
    expect((await res.json()).concept).toMatchObject({ ratePpm: 15_000, rateBps: 150, thresholdUvt: 10, accountCode: "236525" });
    expect(m.audit).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "retention_concept.update" }));
    const dup = await patch(concept.id, { name: "Servicios (4%)" });
    expect(dup.status).toBe(409);
    expect((await patch(concept.id, { ratePpm: 0 })).status).toBe(400);
    expect((await patch("otro", { active: false })).status).toBe(404);
  });

  it("un concepto que ya usó un gasto no se borra: se desactiva", async () => {
    const { concept } = await (await post(UNO)).json();
    m.expenseRetentions.push({ conceptId: concept.id });
    const res = await del(concept.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "concept_in_use" });
    expect(m.concepts.some((c) => c.id === concept.id)).toBe(true);
    const off = await patch(concept.id, { active: false });
    expect(off.status).toBe(200);
    expect((await off.json()).concept.active).toBe(false);
    // El GET de la pantalla dice cuántos gastos lo usan.
    const list = await (await GET_CONFIG(new Request("http://x"))).json();
    expect(list.concepts.find((c: Row) => c.id === concept.id).usedCount).toBe(1);
  });

  it("uno sin uso se borra (y queda en la auditoría)", async () => {
    const { concept } = await (await post(UNO)).json();
    const res = await del(concept.id);
    expect(res.status).toBe(200);
    expect(m.concepts.some((c) => c.id === concept.id)).toBe(false);
    expect(m.audit).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "retention_concept.delete" }));
  });

  it("borrar todos no los vuelve a sembrar", async () => {
    const first = await (await GET_CONFIG(new Request("http://x"))).json();
    expect(first.concepts.length).toBe(5);
    for (const c of first.concepts) expect((await del(c.id)).status).toBe(200);
    const again = await (await GET_CONFIG(new Request("http://x"))).json();
    expect(again.concepts).toEqual([]);
  });

  it("el botón Activo/Inactivo y la UVT siguen por el PATCH de la tarjeta", async () => {
    const { concept } = await (await post(UNO)).json();
    const res = await PATCH_CONFIG(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ conceptId: concept.id, active: false }) }),
    );
    expect(res.status).toBe(200);
    expect(m.concepts.find((c) => c.id === concept.id)!.active).toBe(false);
  });
});

describe("GET /retenciones — la pantalla", () => {
  it("siembra el set estándar con las bases de 2026 (compras 10 UVT, servicios 2 UVT), inactivo", async () => {
    const body = await (await GET_CONFIG(new Request("http://x"))).json();
    const byName = Object.fromEntries(body.concepts.map((c: Row) => [c.name, c]));
    expect(byName["Compras (2,5%)"]).toMatchObject({ thresholdUvt: 10, ratePpm: 25_000, active: false, catalogKey: "compras_declarante" });
    expect(byName["Servicios (4%)"]).toMatchObject({ thresholdUvt: 2, ratePpm: 40_000 });
    expect(byName["ReteIVA (15% del IVA)"]).toMatchObject({ thresholdUvt: 10, base: "tax" });
    // Las cuentas que puede llevar un concepto, por tipo (sin la de caja ni la agrupadora).
    expect(body.accounts.map((a: Row) => [a.code, a.kind])).toEqual([
      ["236505", "retefuente"],
      ["236525", "retefuente"],
      ["236705", "reteiva"],
      ["236805", "reteica"],
    ]);
  });
});

describe("el concepto nuevo aparece de inmediato en compras y gastos", () => {
  it("tax-context de compras (activos) y de gastos (todos), con la tarifa efectiva", async () => {
    const { concept } = await (await post(UNO)).json();
    const ica = await (await post({ ...UNO, kind: "reteica", name: "ReteICA 4,14", ratePpm: 4_140, thresholdUvt: 0, accountCode: "236805", active: false })).json();

    const purchase = await (await GET_PURCHASE_CTX(new Request("http://x"))).json();
    expect(purchase.concepts.map((c: Row) => c.id)).toEqual([concept.id]);
    expect(purchase.concepts[0]).toMatchObject({ rateBps: 100, thresholdUvt: 2, accountCode: "236505", catalogKey: null });

    const expense = await (await GET_EXPENSE_CTX(new Request("http://x"))).json();
    const ids = expense.concepts.map((c: Row) => c.id);
    expect(ids).toContain(concept.id);
    expect(ids).toContain(ica.concept.id);
    expect(expense.concepts.find((c: Row) => c.id === ica.concept.id).rateBps).toBeCloseTo(41.4);
  });
});
