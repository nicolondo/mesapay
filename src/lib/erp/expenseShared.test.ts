// Del formulario a lo que se guarda: el servidor pone tarifa, nombre y
// cuenta de cada retención (del concepto del comercio), recalcula los
// totales y valida. Y la copia de una plantilla recurrente recalcula las
// retenciones con la UVT del año de la copia.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ concepts: vi.fn(), index: new Map<string, { id: string; postable: boolean; active: boolean }>() }));
vi.mock("@/lib/db", () => ({ db: { retentionConcept: { findMany: m.concepts } } }));
vi.mock("./ledger", () => ({ loadAccountIndex: async () => m.index }));

import { resolveExpenseTaxes, taxPayloadFromBody, templateCopyTaxes, expenseBodySchema } from "./expenseShared";
import { UVT_DEFAULT_CENTS } from "./retencionesCore";

const HONORARIOS = {
  id: "hon",
  restaurantId: "r1",
  kind: "retefuente",
  name: "Honorarios (11%)",
  rateBps: 1100,
  base: "subtotal",
  thresholdUvt: 0,
  accountCode: "236515",
  active: true,
};
const RETEICA = { ...HONORARIOS, id: "rica", kind: "reteica", name: "ReteICA (7×1.000)", rateBps: 70, accountCode: "236899" };

beforeEach(() => {
  vi.clearAllMocks();
  m.index = new Map(["236505", "236515", "236705", "236805"].map((c) => [c, { id: c, postable: true, active: true }]));
  m.concepts.mockImplementation(async (args: { where: { restaurantId: string; id: { in: string[] } } }) =>
    [HONORARIOS, RETEICA].filter((c) => c.restaurantId === args.where.restaurantId && args.where.id.in.includes(c.id)),
  );
});

const payload = (over: Partial<Parameters<typeof resolveExpenseTaxes>[0]["payload"]> = {}) => ({
  subtotalCents: 1_000_000,
  discountCents: 0,
  ivaPct: 19,
  ivaCents: null,
  incCents: 0,
  retentions: [],
  ...over,
});

describe("resolveExpenseTaxes", () => {
  it("conserva una retención elegida manualmente aunque el concepto no esté activo para sugerencias", async () => {
    const inactive = { ...HONORARIOS, active: false };
    m.concepts.mockResolvedValueOnce([inactive]);
    const result = await resolveExpenseTaxes({
      restaurantId: "r1",
      payload: payload({ retentions: [{ conceptId: inactive.id, amountCents: 110_000 }] }),
      ivaDeductible: true,
      hasSupplier: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.retentions).toEqual([
      expect.objectContaining({ conceptId: inactive.id, rateBps: 1100, amountCents: 110_000, accountCode: "236515" }),
    ]);
    expect(result.fields).toMatchObject({ retefuenteCents: 110_000, payableCents: 1_080_000 });
    expect(inactive.active).toBe(false);
    expect(m.concepts).toHaveBeenCalledWith({ where: { restaurantId: "r1", id: { in: [inactive.id] } } });
  });

  it("toma del concepto la tarifa, el nombre y la cuenta; del cliente sólo el monto", async () => {
    const r = await resolveExpenseTaxes({
      restaurantId: "r1",
      payload: payload({ retentions: [{ conceptId: "hon", amountCents: 110_000 }] }),
      ivaDeductible: true,
      hasSupplier: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.retentions).toEqual([
      { conceptId: "hon", kind: "retefuente", name: "Honorarios (11%)", rateBps: 1100, ratePpm: 110_000, base: "subtotal", accountCode: "236515", baseCents: 1_000_000, amountCents: 110_000 },
    ]);
    expect(r.fields).toEqual({
      amountCents: 1_000_000,
      baseCents: 1_000_000,
      discountCents: 0,
      ivaPct: 19,
      ivaCents: 190_000,
      ivaDeductible: true,
      incCents: 0,
      retefuenteCents: 110_000,
      reteIvaCents: 0,
      reteIcaCents: 0,
      payableCents: 1_080_000,
    });
  });

  it("una cuenta de concepto que el plan no tiene cae en la del motor (2368) y no tumba el asiento", async () => {
    const r = await resolveExpenseTaxes({
      restaurantId: "r1",
      payload: payload({ retentions: [{ conceptId: "rica", amountCents: 7_000 }] }),
      ivaDeductible: true,
      hasSupplier: true,
    });
    expect(r.ok && r.retentions[0]!.accountCode).toBe("236805");
  });

  it("un concepto de otro comercio no existe; una retención de concepto borrado conserva su foto", async () => {
    expect(
      await resolveExpenseTaxes({
        restaurantId: "r2",
        payload: payload({ retentions: [{ conceptId: "hon", amountCents: 1 }] }),
        ivaDeductible: true,
        hasSupplier: true,
      }),
    ).toEqual({ ok: false, error: "retention_not_found" });
    const r = await resolveExpenseTaxes({
      restaurantId: "r1",
      payload: payload({ retentions: [{ sourceId: "old", amountCents: 40_000 }] }),
      ivaDeductible: true,
      hasSupplier: true,
      existing: [
        { id: "old", conceptId: null, kind: "retefuente", name: "Servicios (4%)", rateBps: 400, base: "subtotal", accountCode: "236505", baseCents: 1, amountCents: 1 },
      ],
    });
    expect(r.ok && r.retentions[0]).toMatchObject({ conceptId: null, name: "Servicios (4%)", baseCents: 1_000_000, amountCents: 40_000 });
  });

  it("aplica las reglas: proveedor obligatorio con IVA, retención ≤ base", async () => {
    expect(
      await resolveExpenseTaxes({ restaurantId: "r1", payload: payload(), ivaDeductible: true, hasSupplier: false }),
    ).toEqual({ ok: false, error: "supplier_required" });
    expect(
      await resolveExpenseTaxes({
        restaurantId: "r1",
        payload: payload({ subtotalCents: 100_000, retentions: [{ conceptId: "hon", amountCents: 100_001 }] }),
        ivaDeductible: true,
        hasSupplier: true,
      }),
    ).toEqual({ ok: false, error: "retention_exceeds_base" });
  });
});

describe("taxPayloadFromBody", () => {
  it("el formulario viejo (sólo monto) es un gasto sin impuestos", () => {
    expect(taxPayloadFromBody({ amountCents: 50_000 })).toEqual({
      subtotalCents: 50_000,
      discountCents: 0,
      ivaPct: 0,
      ivaCents: null,
      incCents: 0,
      retentions: [],
    });
    expect(taxPayloadFromBody({})).toBeNull();
  });
  it("una retención trae concepto O gasto de origen, nunca los dos ni ninguno", () => {
    const base = { category: "x", date: "2026-10-01T17:00:00.000Z", subtotalCents: 1 };
    expect(expenseBodySchema.safeParse({ ...base, retentions: [{ conceptId: "a", amountCents: 1 }] }).success).toBe(true);
    expect(expenseBodySchema.safeParse({ ...base, retentions: [{ amountCents: 1 }] }).success).toBe(false);
    expect(expenseBodySchema.safeParse({ ...base, retentions: [{ conceptId: "a", sourceId: "b", amountCents: 1 }] }).success).toBe(false);
    // El soporte sólo puede ser un archivo de la ruta de soportes.
    expect(expenseBodySchema.safeParse({ ...base, attachmentUrl: "/uploads/gasto-0123456789abcdef.pdf" }).success).toBe(true);
    expect(expenseBodySchema.safeParse({ ...base, attachmentUrl: "https://evil.example/x.pdf" }).success).toBe(false);
    expect(expenseBodySchema.safeParse({ ...base, attachmentUrl: "/uploads/../../etc/passwd" }).success).toBe(false);
  });
});

describe("templateCopyTaxes (copias de recurrentes)", () => {
  const template = (over: Record<string, unknown> = {}) => ({
    amountCents: 300_000_000, // arriendo de $3.000.000
    baseCents: 300_000_000,
    discountCents: 0,
    ivaPct: 19,
    ivaCents: 57_000_000,
    ivaDeductible: true,
    incCents: 0,
    payableCents: 346_500_000,
    retentions: [
      {
        id: "l1",
        conceptId: "arr",
        kind: "retefuente",
        name: "Arrendamientos (3,5%)",
        rateBps: 350,
        base: "subtotal",
        accountCode: "236505",
        baseCents: 300_000_000,
        amountCents: 10_500_000,
        concept: { id: "arr", kind: "retefuente", name: "Arrendamientos (3,5%)", rateBps: 350, base: "subtotal", thresholdUvt: 27, accountCode: "236505", active: true },
      },
    ],
    ...over,
  });

  it("repite base e IVA y recalcula la retención con la tarifa vigente del concepto", () => {
    const t = template();
    t.retentions[0]!.concept!.rateBps = 400; // el contador la subió
    const c = templateCopyTaxes(t, UVT_DEFAULT_CENTS);
    expect(c.retentions).toEqual([expect.objectContaining({ conceptId: "arr", rateBps: 400, amountCents: 12_000_000 })]);
    expect(c.fields).toMatchObject({ amountCents: 300_000_000, ivaCents: 57_000_000, payableCents: 300_000_000 + 57_000_000 - 12_000_000 });
  });

  it("con la UVT del año de la copia: si la base ya no alcanza el umbral, la copia no la lleva", () => {
    // 27 UVT con una UVT de $120.000 = $3.240.000 > base de $3.000.000.
    const c = templateCopyTaxes(template(), 12_000_000);
    expect(c.retentions).toEqual([]);
    expect(c.fields.payableCents).toBe(357_000_000);
  });

  it("un concepto desactivado no se practica en la copia; uno borrado conserva su tarifa", () => {
    const off = template();
    off.retentions[0]!.concept!.active = false;
    expect(templateCopyTaxes(off, UVT_DEFAULT_CENTS).retentions).toEqual([]);
    const gone = template();
    (gone.retentions[0] as { concept: unknown }).concept = null;
    expect(templateCopyTaxes(gone, UVT_DEFAULT_CENTS).retentions).toEqual([
      expect.objectContaining({ conceptId: null, rateBps: 350, amountCents: 10_500_000 }),
    ]);
  });

  it("una plantilla anterior a los impuestos se copia como siempre (valor plano)", () => {
    const c = templateCopyTaxes({ ...template(), baseCents: 0, ivaCents: 0, payableCents: 0, retentions: [] }, UVT_DEFAULT_CENTS);
    expect(c.fields).toMatchObject({ amountCents: 300_000_000, baseCents: 300_000_000, payableCents: 300_000_000, ivaCents: 0 });
  });
});
