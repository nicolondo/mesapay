import { describe, expect, it } from "vitest";
import { buildReportCsv } from "./csv";
import {
  addDays,
  agingBucket,
  buildPartnerSummary,
  buildStatement,
  carteraCsvRows,
  daysBetween,
  worstBucket,
  type CarteraDoc,
  type CarteraPayment,
} from "./cartera";

const HOY = "2026-09-21";

function doc(over: Partial<CarteraDoc> & { id: string }): CarteraDoc {
  return {
    source: "purchase_order",
    partnerId: "prov-a",
    partnerName: "Proveedor A",
    partnerTaxId: "900111222",
    number: "0001",
    date: "2026-09-01",
    dueDate: "2026-09-01",
    totalCents: 100_000,
    outstandingCents: 100_000,
    ...over,
  };
}

describe("daysBetween / addDays", () => {
  it("días calendario enteros, negativos hacia el futuro", () => {
    expect(daysBetween("2026-09-21", HOY)).toBe(0);
    expect(daysBetween("2026-09-20", HOY)).toBe(1);
    expect(daysBetween("2026-09-22", HOY)).toBe(-1);
    expect(daysBetween("2026-08-22", HOY)).toBe(30);
  });
  it("addDays cruza meses y años", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 30)).toBe("2027-01-30");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("agingBucket (límites de zenith)", () => {
  it.each([
    [0, "corriente"],
    [1, "1-30"],
    [30, "1-30"],
    [31, "31-60"],
    [60, "31-60"],
    [61, "60+"],
    [400, "60+"],
  ] as const)("vencido hace %i días → %s", (days, expected) => {
    expect(agingBucket(addDays(HOY, -days), HOY)).toBe(expected);
  });
  it("un vencimiento futuro es corriente", () => {
    expect(agingBucket(addDays(HOY, 15), HOY)).toBe("corriente");
  });
});

describe("worstBucket", () => {
  it("elige el tramo más viejo; vacío → corriente", () => {
    expect(worstBucket([])).toBe("corriente");
    expect(worstBucket(["corriente", "1-30"])).toBe("1-30");
    expect(worstBucket(["31-60", "1-30", "corriente"])).toBe("31-60");
    expect(worstBucket(["1-30", "60+", "31-60"])).toBe("60+");
  });
});

describe("buildPartnerSummary", () => {
  const docs: CarteraDoc[] = [
    doc({ id: "a1", dueDate: "2026-09-10", outstandingCents: 30_000 }),
    doc({ id: "a2", dueDate: "2026-07-01", outstandingCents: 20_000 }),
    doc({ id: "a3", dueDate: "2026-06-01", outstandingCents: 0 }), // saldado: no cuenta
    doc({
      id: "b1",
      partnerId: "prov-b",
      partnerName: "Proveedor B",
      partnerTaxId: null,
      source: "expense",
      dueDate: "2026-10-05",
      outstandingCents: 80_000,
    }),
    doc({
      id: "c1",
      partnerId: "prov-c",
      partnerName: "Proveedor C",
      dueDate: "2026-09-21",
      outstandingCents: 80_000,
    }),
  ];
  const side = buildPartnerSummary(docs, HOY);

  it("una fila por tercero, orden por saldo desc y nombre", () => {
    expect(side.partners.map((p) => p.partnerId)).toEqual(["prov-b", "prov-c", "prov-a"]);
  });
  it("cuenta documentos con saldo, vence más antiguo y peor tramo", () => {
    const a = side.partners.find((p) => p.partnerId === "prov-a")!;
    expect(a.docs).toBe(2);
    expect(a.oldestDue).toBe("2026-07-01");
    expect(a.worstBucket).toBe("60+");
    expect(a.outstandingCents).toBe(50_000);
    const b = side.partners.find((p) => p.partnerId === "prov-b")!;
    expect(b.worstBucket).toBe("corriente");
    expect(b.partnerTaxId).toBeNull();
    const c = side.partners.find((p) => p.partnerId === "prov-c")!;
    expect(c.worstBucket).toBe("corriente");
  });
  it("totales: saldo, terceros y documentos con saldo", () => {
    expect(side.totals).toEqual({ outstandingCents: 210_000, partners: 3, docs: 4 });
  });
  it("sin documentos → vacío", () => {
    expect(buildPartnerSummary([], HOY)).toEqual({
      partners: [],
      totals: { outstandingCents: 0, partners: 0, docs: 0 },
    });
  });
});

describe("carteraCsvRows", () => {
  it("Tercero, NIT, Documentos, Vence más antiguo, Antigüedad, Saldo en el dialecto de csv.ts", () => {
    const side = buildPartnerSummary(
      [
        doc({ id: "a1", dueDate: "2026-08-01", outstandingCents: 123_456 }),
        doc({ id: "z1", partnerId: "sin-proveedor", partnerName: "", partnerTaxId: null, dueDate: "2026-09-30", outstandingCents: 500 }),
      ],
      HOY,
    );
    const rows = carteraCsvRows(side.partners, {
      partnerLabel: (p) => (p.partnerId === "sin-proveedor" ? "Sin proveedor" : p.partnerName),
      bucketLabel: (b) => `[${b}]`,
    });
    expect(rows).toEqual([
      ["Proveedor A", "900111222", "1", "2026-08-01", "[31-60]", 123_456],
      ["Sin proveedor", "", "1", "2026-09-30", "[corriente]", 500],
    ]);
    const csv = buildReportCsv({ headers: ["Tercero", "NIT", "Documentos", "Vence", "Antigüedad", "Saldo"], rows });
    expect(csv.split("\r\n")[1]).toBe("Proveedor A;900111222;1;2026-08-01;[31-60];1234,56");
  });
});

describe("buildStatement", () => {
  const docs: CarteraDoc[] = [
    // Documento viejo (100 días), vencido, con dos abonos.
    doc({ id: "d1", number: "0001", date: addDays(HOY, -100), dueDate: addDays(HOY, -70), totalCents: 100_000, outstandingCents: 40_000 }),
    // Mismo día que el abono de d1: el cargo debe ir ANTES del abono.
    doc({ id: "d2", number: "0002", date: addDays(HOY, -50), dueDate: addDays(HOY, -20), totalCents: 50_000, outstandingCents: 50_000 }),
    // Reciente, aún no vence.
    doc({ id: "d3", number: "0010", date: addDays(HOY, -5), dueDate: addDays(HOY, 25), totalCents: 30_000, outstandingCents: 30_000 }),
    // Saldado del todo: aparece en la historia, no en las edades.
    doc({ id: "d4", number: "0003", date: addDays(HOY, -65), dueDate: addDays(HOY, -35), totalCents: 10_000, outstandingCents: 0 }),
  ];
  const payments: CarteraPayment[] = [
    { id: "p1", docId: "d1", date: addDays(HOY, -80), amountCents: 30_000, note: "transferencia" },
    { id: "p2", docId: "d1", date: addDays(HOY, -50), amountCents: 30_000, note: null },
    { id: "p3", docId: "d4", date: addDays(HOY, -60), amountCents: 10_000, note: null },
    { id: "huérfano", docId: "no-existe", date: addDays(HOY, -1), amountCents: 999, note: null },
  ];
  const st = buildStatement(docs, payments, HOY);

  it("orden cronológico: cargo antes que abono el mismo día; abonos huérfanos fuera", () => {
    expect(st.entries.map((e) => e.key)).toEqual([
      "doc:d1",
      "pay:p1",
      "doc:d4",
      "pay:p3",
      "doc:d2",
      "pay:p2",
      "doc:d3",
    ]);
  });
  it("saldo corrido y totales", () => {
    expect(st.entries.map((e) => e.balanceCents)).toEqual([
      100_000, 70_000, 80_000, 70_000, 120_000, 90_000, 120_000,
    ]);
    expect(st.totals).toEqual({ cargosCents: 190_000, abonosCents: 70_000, balanceCents: 120_000 });
    const abono = st.entries.find((e) => e.key === "pay:p1")!;
    expect(abono).toMatchObject({ kind: "abono", docId: "d1", number: "0001", note: "transferencia", cargoCents: 0, abonoCents: 30_000, dueDate: null });
  });
  it("edades por ANTIGÜEDAD del documento; vencido por vencimiento real", () => {
    expect(st.aging).toEqual({
      d0a30Cents: 30_000, // d3 (5 días)
      d31a60Cents: 50_000, // d2 (50 días)
      d61a90Cents: 0,
      mas90Cents: 40_000, // d1 (100 días)
      pendingCents: 120_000,
      overdueCents: 90_000, // d1 + d2 vencidos; d3 vence en 25 días
    });
  });
  it("límites de los tramos de antigüedad (30 / 60 / 90 días)", () => {
    const edge = (days: number) => buildStatement([doc({ id: "x", date: addDays(HOY, -days), dueDate: HOY, outstandingCents: 1 })], [], HOY).aging;
    expect(edge(30)).toMatchObject({ d0a30Cents: 1, d31a60Cents: 0 });
    expect(edge(31)).toMatchObject({ d0a30Cents: 0, d31a60Cents: 1 });
    expect(edge(60)).toMatchObject({ d31a60Cents: 1, d61a90Cents: 0 });
    expect(edge(61)).toMatchObject({ d31a60Cents: 0, d61a90Cents: 1 });
    expect(edge(90)).toMatchObject({ d61a90Cents: 1, mas90Cents: 0 });
    expect(edge(91)).toMatchObject({ d61a90Cents: 0, mas90Cents: 1 });
    // Vence HOY: todavía no está vencido.
    expect(edge(10).overdueCents).toBe(0);
  });
  it("sin movimientos → todo en cero", () => {
    expect(buildStatement([], [], HOY)).toEqual({
      entries: [],
      aging: { d0a30Cents: 0, d31a60Cents: 0, d61a90Cents: 0, mas90Cents: 0, pendingCents: 0, overdueCents: 0 },
      totals: { cargosCents: 0, abonosCents: 0, balanceCents: 0 },
    });
  });
});
