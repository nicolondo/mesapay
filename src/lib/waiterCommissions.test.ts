import { describe, expect, it } from "vitest";
import { buildReportCsv } from "@/lib/erp/reports/csv";
import {
  bpsToPct,
  bpsToPctText,
  buildCommissionReport,
  commissionCsvDetail,
  commissionCsvSummary,
  isValidCommissionBps,
  pctToBps,
  sealCommission,
  type CommissionRow,
} from "./waiterCommissions";

function row(over: Partial<CommissionRow> & { orderId: string }): CommissionRow {
  return {
    shortCode: over.orderId.toUpperCase(),
    paidAt: "2026-09-10T18:00:00.000Z",
    orderType: "dineIn",
    tableNumber: 5,
    tableLabel: null,
    waiterId: "w-ana",
    waiterName: "Ana",
    bps: 250,
    baseCents: 100_000,
    commissionCents: 2_500,
    ...over,
  };
}

describe("sealCommission — lo que queda sellado en la cuenta", () => {
  it("redondea la comisión al centavo (mitad hacia arriba)", () => {
    // 12345 × 250 / 10000 = 308,625 → 309
    expect(sealCommission({ waiterBps: 250, subtotalCents: 12_345 })).toEqual({
      bps: 250,
      baseCents: 12_345,
      commissionCents: 309,
    });
    // 1234567 × 250 / 10000 = 30864,175 → 30864
    expect(sealCommission({ waiterBps: 250, subtotalCents: 1_234_567 })?.commissionCents).toBe(
      30_864,
    );
  });

  it("la base es el subtotal neto del descuento del comensal, nunca negativa", () => {
    expect(
      sealCommission({ waiterBps: 1_000, subtotalCents: 10_000, discountCents: 1_500 }),
    ).toEqual({ bps: 1_000, baseCents: 8_500, commissionCents: 850 });
    expect(
      sealCommission({ waiterBps: 1_000, subtotalCents: 1_000, discountCents: 5_000 }),
    ).toEqual({ bps: 1_000, baseCents: 0, commissionCents: 0 });
  });

  it("sin % (null) o con una tasa inválida no sella nada", () => {
    expect(sealCommission({ waiterBps: null, subtotalCents: 10_000 })).toBeNull();
    expect(sealCommission({ waiterBps: undefined, subtotalCents: 10_000 })).toBeNull();
    expect(sealCommission({ waiterBps: -1, subtotalCents: 10_000 })).toBeNull();
    expect(sealCommission({ waiterBps: 10_001, subtotalCents: 10_000 })).toBeNull();
    expect(sealCommission({ waiterBps: 2.5, subtotalCents: 10_000 })).toBeNull();
  });

  it("0 % es una tasa válida (sella 0, no null): el histórico dice «comisionó al 0 %»", () => {
    expect(sealCommission({ waiterBps: 0, subtotalCents: 10_000 })).toEqual({
      bps: 0,
      baseCents: 10_000,
      commissionCents: 0,
    });
  });
});

describe("conversión % ↔ bps", () => {
  it("2,5 % son 250 bps y vuelve", () => {
    expect(pctToBps(2.5)).toBe(250);
    expect(pctToBps(0.333)).toBe(33);
    expect(pctToBps(100)).toBe(10_000);
    expect(bpsToPct(250)).toBe(2.5);
    expect(bpsToPctText(250)).toBe("2,50");
    expect(bpsToPctText(1_000)).toBe("10,00");
  });

  it("valida enteros entre 0 y 10 000", () => {
    expect(isValidCommissionBps(0)).toBe(true);
    expect(isValidCommissionBps(10_000)).toBe(true);
    expect(isValidCommissionBps(10_001)).toBe(false);
    expect(isValidCommissionBps(-1)).toBe(false);
    expect(isValidCommissionBps(1.5)).toBe(false);
    expect(isValidCommissionBps("250")).toBe(false);
    expect(isValidCommissionBps(null)).toBe(false);
  });
});

describe("buildCommissionReport", () => {
  const rows: CommissionRow[] = [
    row({ orderId: "a2", paidAt: "2026-09-12T20:00:00.000Z", baseCents: 40_000, commissionCents: 1_000 }),
    row({ orderId: "a1", paidAt: "2026-09-10T18:00:00.000Z", baseCents: 100_000, commissionCents: 2_500 }),
    // Luis cambió de 3 % a 5 % a mitad de mes: su fila resumen dice «varios».
    row({
      orderId: "l1",
      paidAt: "2026-09-05T12:00:00.000Z",
      waiterId: "w-luis",
      waiterName: "Luis",
      bps: 300,
      baseCents: 200_000,
      commissionCents: 6_000,
    }),
    row({
      orderId: "l2",
      paidAt: "2026-09-20T12:00:00.000Z",
      waiterId: "w-luis",
      waiterName: "Luis",
      bps: 500,
      baseCents: 100_000,
      commissionCents: 5_000,
    }),
  ];

  it("agrupa por persona, de mayor a menor comisión, con % único o «varios»", () => {
    const { summary } = buildCommissionReport(rows);
    expect(summary).toEqual([
      {
        waiterId: "w-luis",
        waiterName: "Luis",
        orders: 2,
        baseCents: 300_000,
        bps: null,
        commissionCents: 11_000,
      },
      {
        waiterId: "w-ana",
        waiterName: "Ana",
        orders: 2,
        baseCents: 140_000,
        bps: 250,
        commissionCents: 3_500,
      },
    ]);
  });

  it("el detalle va por fecha de pago ascendente y los totales cuadran con el resumen", () => {
    const { detail, totals } = buildCommissionReport(rows);
    expect(detail.map((r) => r.orderId)).toEqual(["l1", "a1", "a2", "l2"]);
    expect(totals).toEqual({ orders: 4, baseCents: 440_000, commissionCents: 14_500, people: 2 });
  });

  it("sin cuentas: todo en cero y sin personas", () => {
    expect(buildCommissionReport([])).toEqual({
      summary: [],
      detail: [],
      totals: { orders: 0, baseCents: 0, commissionCents: 0, people: 0 },
    });
  });

  it("no muta el arreglo de entrada", () => {
    const copy = [...rows];
    buildCommissionReport(rows);
    expect(rows).toEqual(copy);
  });
});

describe("CSV", () => {
  const report = buildCommissionReport([
    row({ orderId: "a1", baseCents: 123_456, commissionCents: 3_086 }),
    row({
      orderId: "l1",
      paidAt: "2026-09-05T12:00:00.000Z",
      waiterId: "w-luis",
      waiterName: "Luis",
      bps: 300,
      baseCents: 200_000,
      commissionCents: 6_000,
      tableNumber: -1,
      orderType: "pickup",
    }),
  ]);
  const labels = { total: "TOTAL", various: "varios" };

  it("resumen: una fila por persona, % con coma y fila TOTAL al final", () => {
    const csv = buildReportCsv({
      headers: ["Persona", "Cuentas", "Cobrado", "%", "Comisión"],
      rows: commissionCsvSummary(report, labels),
    });
    const lines = csv.slice(1).split("\r\n");
    expect(lines).toEqual([
      "Persona;Cuentas;Cobrado;%;Comisión",
      "Luis;1;2000,00;3,00;60,00",
      "Ana;1;1234,56;2,50;30,86",
      "TOTAL;2;3234,56;;90,86",
    ]);
  });

  it("resumen: «varios» cuando el % no fue uniforme", () => {
    const mixed = buildCommissionReport([
      row({ orderId: "l1", waiterId: "w-luis", waiterName: "Luis", bps: 300 }),
      row({ orderId: "l2", waiterId: "w-luis", waiterName: "Luis", bps: 500 }),
    ]);
    expect(commissionCsvSummary(mixed, labels)[0]?.[3]).toBe("varios");
  });

  it("detalle: fecha, cuenta, mesa, persona, cobrado, % y comisión", () => {
    const rows = commissionCsvDetail(report.detail, {
      date: (iso) => iso.slice(0, 10),
      account: (r) => (r.orderType === "pickup" ? "Recogida" : `Mesa ${r.tableNumber}`),
    });
    expect(rows).toEqual([
      ["2026-09-05", "L1", "Recogida", "Luis", 200_000, "3,00", 6_000],
      ["2026-09-10", "A1", "Mesa 5", "Ana", 123_456, "2,50", 3_086],
    ]);
  });
});
