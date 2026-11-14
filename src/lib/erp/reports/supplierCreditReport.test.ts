import { describe, expect, it } from "vitest";
import { agreementKey, buildSupplierCreditReport, supplierCreditTotalsBySupplier, type SupplierCreditReportRow } from "./supplierCreditReport";

const row = (over: Partial<SupplierCreditReportRow>): SupplierCreditReportRow => ({
  id: Math.random().toString(36).slice(2),
  number: "NC-1",
  date: "2026-10-05",
  kind: "agreement",
  agreement: null,
  supplierId: "s1",
  supplierName: "Cervecería",
  supplierTaxId: "900",
  totalCents: 100,
  baseCents: 100,
  ivaCents: 0,
  incCents: 0,
  ...over,
});

describe("reporte de notas crédito de proveedores", () => {
  const report = buildSupplierCreditReport([
    row({ number: "NC-1", agreement: "Bonificación trimestral cerveza", totalCents: 300_000, baseCents: 300_000 }),
    row({ number: "NC-2", date: "2026-11-02", agreement: "bonificación  TRIMESTRAL cerveza", totalCents: 200_000, baseCents: 200_000 }),
    row({ number: "NC-3", date: "2026-11-03", kind: "discount", totalCents: 119_000, baseCents: 100_000, ivaCents: 19_000 }),
    row({ number: "NC-9", date: "2026-11-04", kind: "return", supplierId: "s2", supplierName: "Lácteos", totalCents: 50_000, baseCents: 50_000 }),
    row({ number: "NC-4", date: "2026-11-09", kind: "conditional_discount", totalCents: 10_000, baseCents: 10_000 }),
  ]);

  it("totales por tipo", () => {
    expect(report.totals).toEqual({ count: 5, totalCents: 679_000, baseCents: 660_000, ivaCents: 19_000, incCents: 0 });
    expect(report.byKind.map((k) => [k.kind, k.count, k.totalCents])).toEqual([
      ["agreement", 2, 500_000],
      ["discount", 1, 119_000],
      ["conditional_discount", 1, 10_000],
      ["return", 1, 50_000],
    ]);
  });

  it("por mes y tipo", () => {
    expect(report.byMonth.map((m) => [m.month, m.totalCents, m.byKind.agreement])).toEqual([
      ["2026-10", 300_000, 300_000],
      ["2026-11", 379_000, 200_000],
    ]);
  });

  it("por proveedor y acuerdo (el concepto se agrupa sin mayúsculas, tildes ni espacios dobles)", () => {
    expect(report.bySupplier.map((s) => [s.name, s.totalCents, s.byKind.agreement])).toEqual([
      ["Cervecería", 629_000, 500_000],
      ["Lácteos", 50_000, 0],
    ]);
    expect(report.byAgreement).toHaveLength(1);
    expect(report.byAgreement[0]).toMatchObject({ agreement: "Bonificación trimestral cerveza", count: 2, totalCents: 500_000 });
    expect(agreementKey(" Bonificación  Trimestral ")).toBe("bonificacion trimestral");
  });

  it("gancho del informe de proveedores: recibido por acuerdos por proveedor", () => {
    const m = supplierCreditTotalsBySupplier(report);
    expect(m.get("s1")).toEqual({ agreementCents: 500_000, totalCents: 629_000 });
    expect(m.get("s2")).toEqual({ agreementCents: 0, totalCents: 50_000 });
  });

  it("sin notas: todo en cero", () => {
    const empty = buildSupplierCreditReport([]);
    expect(empty.totals.count).toBe(0);
    expect(empty.byKind).toEqual([]);
  });
});
