import { describe, expect, it } from "vitest";
import { computeNitDv } from "@/lib/erp/exogena";
import {
  applySupplierReportView,
  buildSupplierReport,
  creditDays,
  expenseSupplierDoc,
  formatSupplierDocument,
  MAX_RANGE_MONTHS,
  nextSort,
  paginateSupplierRows,
  parseSupplierReportQuery,
  purchaseOrderSupplierDoc,
  resolveSupplierReportPeriod,
  supplierDocument,
  supplierReportSearchParams,
  supplierReportTotals,
  type SupplierPurchaseDoc,
  type SupplierPurchaseOrderInput,
  type SupplierReportRow,
  type SupplierReportSupplier,
} from "./supplierReport";

const TODAY = "2026-11-13";

describe("período: meses calendario completos", () => {
  it("por defecto son los 12 meses completos anteriores al mes en curso", () => {
    expect(resolveSupplierReportPeriod({}, TODAY)).toEqual({
      preset: "12m",
      fromMonth: "2025-11",
      toMonth: "2026-10",
      months: 12,
      desde: "2025-11-01",
      hasta: "2026-10-31",
      includesCurrentMonth: false,
    });
  });

  it("cruza el año: en enero los 12 meses son el año anterior completo", () => {
    const p = resolveSupplierReportPeriod({}, "2026-01-05");
    expect([p.fromMonth, p.toMonth, p.months, p.hasta]).toEqual(["2025-01", "2025-12", 12, "2025-12-31"]);
  });

  it("6 meses y año en curso (enero → último mes completo)", () => {
    const six = resolveSupplierReportPeriod({ periodo: "6m" }, TODAY);
    expect([six.fromMonth, six.toMonth, six.months]).toEqual(["2026-05", "2026-10", 6]);
    const ytd = resolveSupplierReportPeriod({ periodo: "ytd" }, TODAY);
    expect([ytd.fromMonth, ytd.toMonth, ytd.months, ytd.includesCurrentMonth]).toEqual(["2026-01", "2026-10", 10, false]);
  });

  it("año en curso en enero: enero en curso, marcado como incompleto", () => {
    const ytd = resolveSupplierReportPeriod({ periodo: "ytd" }, "2026-01-20");
    expect([ytd.fromMonth, ytd.toMonth, ytd.months, ytd.includesCurrentMonth]).toEqual(["2026-01", "2026-01", 1, true]);
  });

  it("rango: ordena, no pasa del mes en curso, respeta febrero bisiesto y se recorta al tope", () => {
    const swapped = resolveSupplierReportPeriod({ periodo: "rango", desde: "2026-03", hasta: "2026-01" }, TODAY);
    expect([swapped.fromMonth, swapped.toMonth, swapped.months]).toEqual(["2026-01", "2026-03", 3]);

    const future = resolveSupplierReportPeriod({ periodo: "rango", desde: "2026-09", hasta: "2027-04" }, TODAY);
    expect([future.toMonth, future.months, future.includesCurrentMonth]).toEqual(["2026-11", 3, true]);

    const leap = resolveSupplierReportPeriod({ periodo: "rango", desde: "2024-02", hasta: "2024-02" }, TODAY);
    expect([leap.desde, leap.hasta, leap.months]).toEqual(["2024-02-01", "2024-02-29", 1]);

    const long = resolveSupplierReportPeriod({ periodo: "rango", desde: "2010-01", hasta: "2026-10" }, TODAY);
    expect(long.months).toBe(MAX_RANGE_MONTHS);
    expect(long.toMonth).toBe("2026-10");
  });

  it("un rango inválido o un preset desconocido caen al default", () => {
    expect(resolveSupplierReportPeriod({ periodo: "rango", desde: "2026-13", hasta: "2026-01" }, TODAY).preset).toBe("12m");
    expect(resolveSupplierReportPeriod({ periodo: "rango" }, TODAY).preset).toBe("12m");
    expect(resolveSupplierReportPeriod({ periodo: "24m" }, TODAY).preset).toBe("12m");
  });
});

/* ───────────────────────────── Documentos de compra ───────────────────────────── */

function po(over: Partial<SupplierPurchaseOrderInput> = {}): SupplierPurchaseOrderInput {
  return {
    supplierId: "s1",
    status: "received",
    receivedAt: new Date("2026-03-10T15:00:00Z"),
    createdAt: new Date("2026-03-01T15:00:00Z"),
    incCents: 0,
    retefuenteCents: 0,
    reteIvaCents: 0,
    reteIcaCents: 0,
    items: [
      {
        ingredientId: "i1",
        expectedCostCents: 100_000,
        expectedTaxCents: null,
        expectedIncCents: 0,
        qtyOrderedBase: 10,
        taxPct: 19,
        receivedCostCents: 100_000,
        receivedQtyBase: 10,
      },
    ],
    // IVA NO descontable: el kardex entró al bruto (neto + IVA).
    movements: [{ ingredientId: "i1", valueCents: 119_000, createdAt: new Date("2026-03-10T15:00:00Z") }],
    ...over,
  };
}

describe("compras que cuentan", () => {
  it("anuladas, borradores y enviadas sin recibir no son compras", () => {
    for (const status of ["canceled", "draft", "sent"]) {
      expect(purchaseOrderSupplierDoc(po({ status })), status).toBeNull();
    }
    expect(purchaseOrderSupplierDoc(po())).not.toBeNull();
    expect(purchaseOrderSupplierDoc(po({ status: "partially_received" }))).not.toBeNull();
  });

  it("costo = neto + IVA que quedó en el costo; total facturado = neto + IVA, sin restar retenciones", () => {
    const nonDeductible = purchaseOrderSupplierDoc(po({ retefuenteCents: 2_500 }))!;
    expect(nonDeductible).toMatchObject({ date: "2026-03-10", costCents: 119_000, invoicedCents: 119_000 });

    // IVA descontable: el kardex entró al neto y el IVA no es costo.
    const deductible = purchaseOrderSupplierDoc(
      po({ movements: [{ ingredientId: "i1", valueCents: 100_000, createdAt: new Date("2026-03-10T15:00:00Z") }] }),
    )!;
    expect(deductible).toMatchObject({ costCents: 100_000, invoicedCents: 119_000 });
  });

  it("el impuesto al consumo siempre es costo", () => {
    const d = purchaseOrderSupplierDoc(
      po({
        incCents: 8_000,
        items: [
          {
            ingredientId: "i1",
            expectedCostCents: 100_000,
            expectedTaxCents: 0,
            expectedIncCents: 8_000,
            qtyOrderedBase: 10,
            taxPct: 0,
            receivedCostCents: 100_000,
            receivedQtyBase: 10,
          },
        ],
        movements: [{ ingredientId: "i1", valueCents: 108_000, createdAt: new Date("2026-03-10T15:00:00Z") }],
      }),
    )!;
    expect(d).toMatchObject({ costCents: 108_000, invoicedCents: 108_000 });
  });

  it("recepción parcial: cuenta lo recibido, fechado en la primera recepción", () => {
    const d = purchaseOrderSupplierDoc(
      po({
        status: "partially_received",
        receivedAt: null,
        items: [
          {
            ingredientId: "i1",
            expectedCostCents: 100_000,
            expectedTaxCents: null,
            expectedIncCents: 0,
            qtyOrderedBase: 10,
            taxPct: 19,
            receivedCostCents: 40_000,
            receivedQtyBase: 4,
          },
        ],
        movements: [
          { ingredientId: "i1", valueCents: 23_800, createdAt: new Date("2026-04-02T15:00:00Z") },
          { ingredientId: "i1", valueCents: 23_800, createdAt: new Date("2026-03-28T15:00:00Z") },
        ],
      }),
    )!;
    expect(d).toMatchObject({ date: "2026-03-28", costCents: 47_600, invoicedCents: 47_600 });
  });

  it("gastos: con proveedor y no recurrentes; costo = su valor, total = base + IVA + consumo", () => {
    const base = { supplierId: "s1", date: new Date("2026-05-15T17:00:00Z"), amountCents: 50_000 };
    expect(expenseSupplierDoc({ ...base, supplierId: null })).toBeNull();
    expect(expenseSupplierDoc({ ...base, recurring: true })).toBeNull();
    // Gasto viejo sin impuestos: base 0 = su valor.
    expect(expenseSupplierDoc(base)).toMatchObject({ date: "2026-05-15", costCents: 50_000, invoicedCents: 50_000 });
    // IVA descontable: el costo no lo lleva, el total facturado sí.
    expect(
      expenseSupplierDoc({ ...base, amountCents: 100_000, baseCents: 100_000, ivaCents: 19_000, incCents: 0 }),
    ).toMatchObject({ costCents: 100_000, invoicedCents: 119_000 });
  });
});

/* ──────────────────────────────── Agregado ──────────────────────────────── */

const SUPPLIERS: SupplierReportSupplier[] = [
  { id: "s1", name: "Lácteos del Valle", taxId: "900123456-7", taxIdType: null, paymentTermsDays: 30, active: true },
  { id: "s2", name: "Carnes Andinas", taxId: "800197268", taxIdType: "NIT", paymentTermsDays: null, active: true },
  { id: "s3", name: "Verduras Sin Compras", taxId: null, taxIdType: null, paymentTermsDays: 0, active: true },
  { id: "s4", name: "Proveedor Inactivo", taxId: "1020304050", taxIdType: "CC", paymentTermsDays: 15, active: false },
  { id: "s5", name: "Inactivo con deuda", taxId: null, taxIdType: null, paymentTermsDays: null, active: false },
];

const doc = (supplierId: string, date: string, costCents: number, invoicedCents = costCents): SupplierPurchaseDoc => ({
  supplierId,
  source: "purchase_order",
  date,
  costCents,
  invoicedCents,
});

const PERIOD = resolveSupplierReportPeriod({}, TODAY); // nov 2025 – oct 2026

describe("promedio mensual", () => {
  const rows = buildSupplierReport({
    suppliers: SUPPLIERS,
    docs: [
      // Una sola compra en todo el período: promedia sobre 12 meses, no sobre 1.
      doc("s1", "2026-01-15", 1_200_000, 1_428_000),
      // Bordes: primer día y último día del período cuentan; el día antes y el mes en curso no.
      doc("s2", "2025-11-01", 300_000),
      doc("s2", "2026-10-31", 300_000),
      doc("s2", "2025-10-31", 999_999),
      doc("s2", "2026-11-02", 999_999),
      // De otro comercio (proveedor que no está en el listado): se ignora.
      doc("ajeno", "2026-02-01", 5_000_000),
    ],
    period: PERIOD,
    basis: "costo",
    lastPurchase: new Map([["s3", "2024-06-30"]]),
    payables: new Map([["s5", 70_000], ["s1", 200_000]]),
  });
  const byId = new Map(rows.map((r) => [r.supplierId, r]));

  it("divide por los meses del período aunque se haya comprado en uno solo", () => {
    expect(byId.get("s1")).toMatchObject({ totalCents: 1_200_000, averageCents: 100_000, invoices: 1, lastPurchase: "2026-01-15" });
  });

  it("solo cuentan los documentos dentro del período (bordes incluidos)", () => {
    expect(byId.get("s2")).toMatchObject({ totalCents: 600_000, averageCents: 50_000, invoices: 2 });
  });

  it("proveedor activo sin compras: sale en cero, con su última compra histórica", () => {
    expect(byId.get("s3")).toMatchObject({ totalCents: 0, averageCents: 0, invoices: 0, lastPurchase: "2024-06-30", creditDays: null });
  });

  it("inactivos: solo si compraron en el período o se les debe", () => {
    expect(byId.has("s4")).toBe(false);
    expect(byId.get("s5")).toMatchObject({ active: false, payableCents: 70_000, invoices: 0 });
  });

  it("los documentos de proveedores de otro comercio no entran a ninguna fila", () => {
    expect(rows.map((r) => r.supplierId).sort()).toEqual(["s1", "s2", "s3", "s5"]);
    expect(supplierReportTotals(rows, PERIOD.months)).toEqual({
      suppliers: 4,
      withPurchases: 2,
      totalCents: 1_800_000,
      averageCents: 150_000,
      invoices: 3,
      payableCents: 270_000,
    });
  });

  it("base «total facturado» usa el total con IVA", () => {
    const total = buildSupplierReport({
      suppliers: SUPPLIERS,
      docs: [doc("s1", "2026-01-15", 1_200_000, 1_428_000)],
      period: PERIOD,
      basis: "total",
    });
    expect(total.find((r) => r.supplierId === "s1")).toMatchObject({ totalCents: 1_428_000, averageCents: 119_000 });
  });

  it("redondea el promedio al centavo", () => {
    const r = buildSupplierReport({
      suppliers: SUPPLIERS.slice(0, 1),
      docs: [doc("s1", "2026-01-15", 1_000)],
      period: { desde: "2026-01-01", hasta: "2026-03-31", months: 3 },
      basis: "costo",
    });
    expect(r[0]!.averageCents).toBe(333);
  });
});

describe("documento y condición de pago", () => {
  it("tipo, número y DV (el guardado, o el calculado si es NIT)", () => {
    expect(supplierDocument("900123456-7", null)).toEqual({ type: "NIT", number: "900123456", dv: "7" });
    expect(supplierDocument("NIT 800.197.268", null)).toEqual({ type: "NIT", number: "800197268", dv: "4" });
    expect(supplierDocument("901555777", "nit")).toEqual({ type: "NIT", number: "901555777", dv: computeNitDv("901555777") });
    expect(supplierDocument("1020304050", "CC")).toEqual({ type: "CC", number: "1020304050", dv: null });
    // Sin tipo y sin cara de NIT: no se adivina el tipo.
    expect(supplierDocument("1020304050", null)).toEqual({ type: null, number: "1020304050", dv: null });
    expect(supplierDocument("  ", null)).toBeNull();
    expect(formatSupplierDocument(supplierDocument("900123456-7", null))).toBe("NIT 900123456-7");
    expect(formatSupplierDocument(supplierDocument("1020304050", null))).toBe("1020304050");
    expect(formatSupplierDocument(null)).toBe("");
  });

  it("sin plazo o plazo 0 es contado", () => {
    expect(creditDays(null)).toBeNull();
    expect(creditDays(0)).toBeNull();
    expect(creditDays(30)).toBe(30);
  });
});

/* ─────────────────────── Búsqueda, filtro, orden y página ─────────────────────── */

function row(over: Partial<SupplierReportRow> & { supplierId: string; name: string }): SupplierReportRow {
  return {
    active: true,
    document: null,
    creditDays: null,
    totalCents: 0,
    averageCents: 0,
    invoices: 0,
    lastPurchase: null,
    payableCents: 0,
    ...over,
  };
}

const VIEW_ROWS: SupplierReportRow[] = [
  row({ supplierId: "a", name: "Panadería Ñapa", averageCents: 500, creditDays: 30, lastPurchase: "2026-09-01", document: supplierDocument("900123456-7", null) }),
  row({ supplierId: "b", name: "Abarrotes Centro", averageCents: 900, lastPurchase: null, document: null }),
  row({ supplierId: "c", name: "Carnes Andinas", averageCents: 500, creditDays: 8, lastPurchase: "2026-10-01", document: supplierDocument("800197268", "NIT") }),
];

describe("búsqueda, filtro y orden", () => {
  const view = (q: Partial<Parameters<typeof applySupplierReportView>[1]>) =>
    applySupplierReportView(VIEW_ROWS, { q: "", condition: "todas", sort: "promedio", dir: "desc", ...q }).map((r) => r.supplierId);

  it("busca por nombre sin tildes ni mayúsculas, y por NIT con o sin puntos", () => {
    expect(view({ q: "panaderia" })).toEqual(["a"]);
    expect(view({ q: "900.123" })).toEqual(["a"]);
    expect(view({ q: "800197268-4" })).toEqual(["c"]);
    expect(view({ q: "nada" })).toEqual([]);
  });

  it("filtra por condición de pago", () => {
    expect(view({ condition: "contado" })).toEqual(["b"]);
    expect(view({ condition: "credito" })).toEqual(["c", "a"]);
  });

  it("ordena por cualquier columna; empates por nombre; sin dato siempre al final", () => {
    expect(view({})).toEqual(["b", "c", "a"]);
    expect(view({ sort: "proveedor", dir: "asc" })).toEqual(["b", "c", "a"]);
    expect(view({ sort: "ultima", dir: "desc" })).toEqual(["c", "a", "b"]);
    expect(view({ sort: "ultima", dir: "asc" })).toEqual(["a", "c", "b"]);
    expect(view({ sort: "nit", dir: "asc" })).toEqual(["c", "a", "b"]);
    expect(view({ sort: "nit", dir: "desc" })).toEqual(["a", "c", "b"]);
    expect(view({ sort: "condicion", dir: "asc" })).toEqual(["b", "c", "a"]);
  });

  it("pagina en el servidor sin perder filas y acota la página pedida", () => {
    const many = Array.from({ length: 120 }, (_, i) => row({ supplierId: `s${i}`, name: `P${String(i).padStart(3, "0")}` }));
    const pages = [1, 2, 3].map((p) => paginateSupplierRows(many, p));
    expect(pages.map((p) => [p.from, p.to, p.pages, p.total])).toEqual([
      [1, 50, 3, 120],
      [51, 100, 3, 120],
      [101, 120, 3, 120],
    ]);
    expect(new Set(pages.flatMap((p) => p.rows.map((r) => r.supplierId))).size).toBe(120);
    expect(paginateSupplierRows(many, 9).page).toBe(3);
    expect(paginateSupplierRows([], 1)).toMatchObject({ page: 1, pages: 1, total: 0, from: 0, to: 0 });
  });
});

describe("query de la URL", () => {
  it("valores por defecto y saneo de lo inválido", () => {
    const q = parseSupplierReportQuery({ base: "x", condicion: "y", orden: "z", dir: "w", pagina: "-3" }, TODAY);
    expect(q).toMatchObject({ basis: "costo", includeExpenses: true, q: "", condition: "todas", sort: "promedio", dir: "desc", page: 1 });
    expect(supplierReportSearchParams(q)).toEqual({});
  });

  it("ida y vuelta: lo que no es default viaja en la URL", () => {
    const q = parseSupplierReportQuery(
      { periodo: "rango", desde: "2026-01", hasta: "2026-06", base: "total", gastos: "no", q: " lácteos ", condicion: "credito", orden: "proveedor", dir: "desc", pagina: "2" },
      TODAY,
    );
    const params = supplierReportSearchParams(q);
    expect(params).toEqual({
      periodo: "rango",
      desde: "2026-01",
      hasta: "2026-06",
      base: "total",
      gastos: "no",
      q: "lácteos",
      condicion: "credito",
      orden: "proveedor",
      dir: "desc",
      pagina: "2",
    });
    expect(parseSupplierReportQuery(params, TODAY)).toEqual(q);
  });

  it("el encabezado alterna la columna activa y arranca otra en su dirección natural", () => {
    expect(nextSort({ sort: "promedio", dir: "desc" }, "promedio")).toEqual({ sort: "promedio", dir: "asc" });
    expect(nextSort({ sort: "promedio", dir: "desc" }, "proveedor")).toEqual({ sort: "proveedor", dir: "asc" });
    expect(nextSort({ sort: "proveedor", dir: "asc" }, "saldo")).toEqual({ sort: "saldo", dir: "desc" });
  });
});
