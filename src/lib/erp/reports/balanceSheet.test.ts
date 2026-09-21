import { describe, expect, it } from "vitest";
import {
  balanceSheetCsvRows,
  buildBalanceSheet,
  openPeriodStart,
  statementKindOf,
  summarizeBalances,
  UTILIDAD_ROW_KEY,
  type BalanceAccountInput,
  type BalanceInput,
} from "./balanceSheet";
import { buildReportCsv, CSV_BOM } from "./csv";

/**
 * ── El libro de prueba ──────────────────────────────────────────────────
 * Para probar que el balance CUADRA A FECHAS PASADAS hace falta un libro
 * y la misma manera de acotarlo que usa `queries.loadBalancesThrough`:
 * Σ (débito − crédito) por cuenta con fecha ≤ corte, cierre INCLUIDO.
 * Comparar cadenas `yyyy-mm-dd` es exactamente lo que hace SQL con el
 * límite exclusivo del día siguiente.
 */
type Line = { code: string; debit?: number; credit?: number };
type Entry = { date: string; closing?: boolean; lines: Line[] };

const ACCOUNTS: BalanceAccountInput[] = [
  { code: "1", name: "Activo", type: "activo" },
  { code: "11", name: "Disponible", type: "activo" },
  { code: "1105", name: "Caja", type: "activo" },
  { code: "110505", name: "Caja general", type: "activo" },
  { code: "1110", name: "Bancos", type: "activo" },
  { code: "111005", name: "Moneda nacional", type: "activo" },
  { code: "13", name: "Deudores", type: "activo" },
  { code: "1305", name: "Clientes", type: "activo" },
  { code: "130505", name: "Clientes nacionales", type: "activo" },
  { code: "14", name: "Inventarios", type: "activo" },
  { code: "1435", name: "Mercancías", type: "activo" },
  { code: "143505", name: "Mercancías no fabricadas", type: "activo" },
  { code: "2", name: "Pasivo", type: "pasivo" },
  { code: "22", name: "Proveedores", type: "pasivo" },
  { code: "2205", name: "Proveedores nacionales", type: "pasivo" },
  { code: "220505", name: "Proveedores nacionales", type: "pasivo" },
  { code: "3", name: "Patrimonio", type: "patrimonio" },
  { code: "31", name: "Capital social", type: "patrimonio" },
  { code: "3105", name: "Capital suscrito y pagado", type: "patrimonio" },
  { code: "310505", name: "Capital autorizado", type: "patrimonio" },
  { code: "36", name: "Resultados del ejercicio", type: "patrimonio" },
  { code: "3605", name: "Utilidad del ejercicio", type: "patrimonio" },
  { code: "360505", name: "Utilidad del ejercicio", type: "patrimonio" },
  { code: "4", name: "Ingresos", type: "ingreso" },
  { code: "41", name: "Operacionales", type: "ingreso" },
  { code: "4135", name: "Comercio", type: "ingreso" },
  { code: "413505", name: "Venta de alimentos", type: "ingreso" },
  { code: "5", name: "Gastos", type: "gasto" },
  { code: "51", name: "Administración", type: "gasto" },
  { code: "5135", name: "Servicios", type: "gasto" },
  { code: "513505", name: "Aseo y vigilancia", type: "gasto" },
  { code: "6", name: "Costos", type: "costo" },
  { code: "61", name: "Costo de ventas", type: "costo" },
  { code: "6135", name: "Comercio", type: "costo" },
  { code: "613505", name: "Costo de alimentos", type: "costo" },
];

/**
 * Libro de dos ejercicios con cierre contabilizado el 31/12/2025: aporte,
 * venta a crédito, gasto, costo, compra el mismo día del corte de fin de
 * año, el cierre y movimiento de 2026. Cada asiento cuadra, que es la
 * condición que hace que el balance cuadre a CUALQUIER corte.
 */
const LIBRO: Entry[] = [
  { date: "2025-01-15", lines: [{ code: "110505", debit: 10_000_000 }, { code: "310505", credit: 10_000_000 }] },
  { date: "2025-06-30", lines: [{ code: "130505", debit: 5_000_000 }, { code: "413505", credit: 5_000_000 }] },
  { date: "2025-09-01", lines: [{ code: "513505", debit: 1_200_000 }, { code: "110505", credit: 1_200_000 }] },
  { date: "2025-10-01", lines: [{ code: "613505", debit: 800_000 }, { code: "111005", credit: 800_000 }] },
  { date: "2025-12-31", lines: [{ code: "143505", debit: 2_000_000 }, { code: "220505", credit: 2_000_000 }] },
  {
    // CIERRE 2025: salda 4/5/6 contra 3605 (utilidad 3.000.000)
    date: "2025-12-31",
    closing: true,
    lines: [
      { code: "413505", debit: 5_000_000 },
      { code: "513505", credit: 1_200_000 },
      { code: "613505", credit: 800_000 },
      { code: "360505", credit: 3_000_000 },
    ],
  },
  { date: "2026-03-10", lines: [{ code: "110505", debit: 900_000 }, { code: "413505", credit: 900_000 }] },
];

function balancesUpTo(ledger: Entry[], cutoff: string): BalanceInput[] {
  const acc = new Map<string, number>();
  for (const e of ledger) {
    if (e.date > cutoff) continue;
    for (const l of e.lines) {
      acc.set(l.code, (acc.get(l.code) ?? 0) + (l.debit ?? 0) - (l.credit ?? 0));
    }
  }
  return [...acc].map(([accountCode, balanceCents]) => ({ accountCode, balanceCents }));
}

const closings = LIBRO.filter((e) => e.closing).map((e) => e.date);

const balanceAl = (cutoff: string) => {
  const openYearStart = openPeriodStart(closings, cutoff);
  return buildBalanceSheet({
    balances: balancesUpTo(LIBRO, cutoff),
    accounts: ACCOUNTS,
    cutoff,
    openYearStart,
    utilidadLabel: `Utilidad (desde ${openYearStart})`,
  });
};

const rowOf = (rows: { code: string; valueCents: number }[], code: string) =>
  rows.find((r) => r.code === code)?.valueCents;

describe("openPeriodStart — el período abierto se acota AL CORTE", () => {
  it("sin cierres, 1 de enero del año del corte", () => {
    expect(openPeriodStart([], "2026-08-14")).toBe("2026-01-01");
    expect(openPeriodStart([], "2025-06-30")).toBe("2025-01-01");
  });

  it("con cierre ≤ corte, 1 de enero del año siguiente al cierre", () => {
    expect(openPeriodStart(["2025-12-31"], "2026-03-10")).toBe("2026-01-01");
    expect(openPeriodStart(["2024-12-31", "2025-12-31"], "2026-03-10")).toBe("2026-01-01");
    // El día del cierre el cierre ya cuenta.
    expect(openPeriodStart(["2025-12-31"], "2025-12-31")).toBe("2026-01-01");
  });

  it("un cierre POSTERIOR al corte no existía a esa fecha", () => {
    expect(openPeriodStart(["2025-12-31"], "2025-06-30")).toBe("2025-01-01");
    expect(openPeriodStart(["2024-12-31", "2025-12-31"], "2025-06-30")).toBe("2025-01-01");
  });
});

describe("signos por tipo (summarizeStatements)", () => {
  it("activo +Σ, pasivo −Σ, patrimonio −Σ, ingresos −Σ, gastos Σ, costos Σ", () => {
    const s = summarizeBalances(balancesUpTo(LIBRO, "2025-12-30"), ACCOUNTS);
    expect(s.activoCents).toBe(10_000_000 - 1_200_000 + 5_000_000 - 800_000);
    expect(s.pasivoCents).toBe(0);
    expect(s.patrimonioCents).toBe(10_000_000);
    expect(s.ingresosCents).toBe(5_000_000);
    expect(s.gastosCents).toBe(1_200_000);
    expect(s.costosCents).toBe(800_000);
    expect(s.utilidadCents).toBe(3_000_000);
  });

  it("una cuenta que no está en el plan se clasifica por la clase del PUC", () => {
    const types = new Map<string, string>();
    expect(statementKindOf("110505", types)).toBe("activo");
    expect(statementKindOf("2205", types)).toBe("pasivo");
    expect(statementKindOf("3605", types)).toBe("patrimonio");
    expect(statementKindOf("4135", types)).toBe("ingreso");
    expect(statementKindOf("5135", types)).toBe("gasto");
    expect(statementKindOf("7105", types)).toBe("costo");
    expect(statementKindOf("8105", types)).toBeNull();
    // El tipo del plan manda sobre la clase.
    expect(statementKindOf("4175", new Map([["4175", "ingreso"]]))).toBe("ingreso");
  });
});

describe("activo = pasivo + patrimonio a VARIAS fechas de corte", () => {
  for (const corte of [
    "2024-12-31",
    "2025-01-15",
    "2025-06-30",
    "2025-09-01",
    "2025-12-30",
    "2025-12-31",
    "2026-01-01",
    "2026-03-10",
    "2026-08-14",
  ]) {
    it(`cuadra al ${corte}`, () => {
      const b = balanceAl(corte);
      expect(b.totals.differenceCents).toBe(0);
      expect(b.balanced).toBe(true);
      expect(b.totals.activoCents).toBe(b.totals.pasivoCents + b.totals.totalPatrimonioCents);
    });
  }

  it("un corte anterior a todo el libro da un balance vacío y cuadrado", () => {
    const b = balanceAl("2024-12-31");
    expect(b.sections.activo.rows).toHaveLength(0);
    expect(b.sections.pasivo.rows).toHaveLength(0);
    // El patrimonio siempre lleva la línea de utilidad (en cero).
    expect(b.sections.patrimonio.rows.map((r) => r.key)).toEqual([UTILIDAD_ROW_KEY]);
    expect(b.balanced).toBe(true);
  });

  it("descuadra cuando el libro no cuadra, con la diferencia firmada", () => {
    const roto = buildBalanceSheet({
      balances: [
        { accountCode: "110505", balanceCents: 1_000 },
        { accountCode: "220505", balanceCents: -700 },
      ],
      accounts: ACCOUNTS,
      cutoff: "2026-01-01",
      openYearStart: "2026-01-01",
      utilidadLabel: "Utilidad",
    });
    expect(roto.balanced).toBe(false);
    expect(roto.totals.differenceCents).toBe(300);
    // Un centavo de redondeo se tolera.
    const casi = buildBalanceSheet({
      balances: [
        { accountCode: "110505", balanceCents: 1_000 },
        { accountCode: "220505", balanceCents: -999 },
      ],
      accounts: ACCOUNTS,
      cutoff: "2026-01-01",
      openYearStart: "2026-01-01",
      utilidadLabel: "Utilidad",
    });
    expect(casi.balanced).toBe(true);
    expect(casi.totals.differenceCents).toBe(1);
  });
});

describe("la utilidad del ejercicio vive en el patrimonio", () => {
  it("es la ÚLTIMA línea del patrimonio, sintética, con énfasis y el rótulo dado", () => {
    const b = balanceAl("2025-12-30");
    const last = b.sections.patrimonio.rows.at(-1)!;
    expect(last).toMatchObject({
      key: UTILIDAD_ROW_KEY,
      code: "",
      name: "Utilidad (desde 2025-01-01)",
      depth: 0,
      ancestors: [],
      hasChildren: false,
      synthetic: true,
      emphasis: true,
      valueCents: 3_000_000,
    });
    expect(b.totals.totalPatrimonioCents).toBe(13_000_000);
    expect(b.sections.patrimonio.totalCents).toBe(13_000_000);
  });

  it("la víspera del cierre el resultado está en 4/5/6 y la 3605 no aparece", () => {
    const b = balanceAl("2025-12-30");
    expect(b.totals.utilidadCents).toBe(3_000_000);
    expect(rowOf(b.sections.patrimonio.rows, "360505")).toBeUndefined();
  });

  it("el día del cierre el resultado está CONTABILIZADO en la 3605 y la utilidad al vuelo es cero", () => {
    const b = balanceAl("2025-12-31");
    expect(b.totals.utilidadCents).toBe(0);
    expect(rowOf(b.sections.patrimonio.rows, "360505")).toBe(3_000_000);
    // El patrimonio NO cambia por cerrar: la misma cifra, en otra línea.
    expect(b.totals.totalPatrimonioCents).toBe(13_000_000);
    expect(b.openYearStart).toBe("2026-01-01");
  });

  it("después del cierre la utilidad al vuelo es SOLO la del período abierto", () => {
    const b = balanceAl("2026-03-10");
    expect(b.totals.utilidadCents).toBe(900_000);
    expect(rowOf(b.sections.patrimonio.rows, "360505")).toBe(3_000_000);
    expect(b.totals.totalPatrimonioCents).toBe(13_900_000);
    expect(b.sections.patrimonio.rows.at(-1)!.name).toBe("Utilidad (desde 2026-01-01)");
  });
});

describe("secciones: árbol PUC, signos normalizados y ceros fuera", () => {
  it("cada nodo es la suma de sus hojas y las cifras salen positivas", () => {
    const b = balanceAl("2025-12-31");
    const codes = b.sections.activo.rows.map((r) => `${r.depth}:${r.code}`);
    expect(codes).toEqual([
      "0:11",
      "1:1105",
      "2:110505",
      "1:1110",
      "2:111005",
      "0:13",
      "1:1305",
      "2:130505",
      "0:14",
      "1:1435",
      "2:143505",
    ]);
    expect(rowOf(b.sections.activo.rows, "110505")).toBe(8_800_000);
    expect(rowOf(b.sections.activo.rows, "111005")).toBe(-800_000);
    expect(rowOf(b.sections.activo.rows, "11")).toBe(8_000_000);
    expect(b.sections.activo.totalCents).toBe(8_000_000 + 5_000_000 + 2_000_000);
    // El pasivo se normaliza a positivo aunque el saldo llegue acreedor.
    expect(rowOf(b.sections.pasivo.rows, "220505")).toBe(2_000_000);
    expect(rowOf(b.sections.pasivo.rows, "22")).toBe(2_000_000);
    expect(b.sections.pasivo.totalCents).toBe(2_000_000);
    // Los nombres de los niveles agregados salen del plan.
    expect(b.sections.activo.rows.find((r) => r.code === "11")?.name).toBe("Disponible");
  });

  it("las cuentas con saldo cero no salen (pero la utilidad sí, aunque sea cero)", () => {
    const b = balanceAl("2025-12-31");
    // 4/5/6 quedaron en cero por el cierre: no son del balance, y las de
    // patrimonio en cero tampoco aparecen.
    const zero = buildBalanceSheet({
      balances: [
        { accountCode: "110505", balanceCents: 500 },
        { accountCode: "111005", balanceCents: 0 },
        { accountCode: "310505", balanceCents: -500 },
        { accountCode: "360505", balanceCents: 0 },
      ],
      accounts: ACCOUNTS,
      cutoff: "2026-01-01",
      openYearStart: "2026-01-01",
      utilidadLabel: "Utilidad",
    });
    expect(zero.sections.activo.rows.map((r) => r.code)).toEqual(["11", "1105", "110505"]);
    expect(zero.sections.patrimonio.rows.map((r) => r.code)).toEqual(["31", "3105", "310505", ""]);
    expect(b.balanced).toBe(true);
  });

  it("las llaves de plegado son los prefijos (estables entre secciones)", () => {
    const b = balanceAl("2026-03-10");
    const groups = b.sections.activo.rows.filter((r) => r.hasChildren).map((r) => r.key);
    expect(groups).toEqual(["11", "1105", "1110", "13", "1305", "14", "1435"]);
    expect(b.sections.activo.rows.find((r) => r.code === "110505")?.ancestors).toEqual(["11", "1105"]);
  });
});

describe("CSV", () => {
  const LABELS = {
    activo: "Activo",
    pasivo: "Pasivo",
    patrimonio: "Patrimonio",
    totalActivo: "Total activo",
    totalPasivo: "Total pasivo",
    totalPatrimonio: "Total patrimonio",
    totalPasivoPatrimonio: "Total pasivo + patrimonio",
  };

  it("árbol completo con subtotales, totales de sección y el total final", () => {
    const b = balanceAl("2026-03-10");
    const rows = balanceSheetCsvRows(b, LABELS);
    expect(rows[0]).toEqual(["Activo", "11", "Disponible", 8_900_000]);
    expect(rows).toContainEqual(["Activo", "110505", "Caja general", 9_700_000]);
    expect(rows).toContainEqual(["Activo", "", "Total activo", 15_900_000]);
    expect(rows).toContainEqual(["Pasivo", "", "Total pasivo", 2_000_000]);
    expect(rows).toContainEqual(["Patrimonio", "", "Utilidad (desde 2026-01-01)", 900_000]);
    expect(rows).toContainEqual(["Patrimonio", "", "Total patrimonio", 13_900_000]);
    expect(rows.at(-1)).toEqual(["", "", "Total pasivo + patrimonio", 15_900_000]);
  });

  it("con nota del corte como primera fila y montos con coma decimal", () => {
    const b = balanceAl("2026-03-10");
    const csv = buildReportCsv({
      headers: ["Sección", "Código", "Cuenta", "Valor"],
      rows: balanceSheetCsvRows(b, LABELS),
      note: "Estado de situación financiera con corte al 10 mar 2026",
    });
    const lines = csv.slice(CSV_BOM.length).split("\r\n");
    expect(lines[0]).toBe("Estado de situación financiera con corte al 10 mar 2026");
    expect(lines[1]).toBe("Sección;Código;Cuenta;Valor");
    expect(lines[2]).toBe("Activo;11;Disponible;89000,00");
    expect(lines.at(-1)).toBe(";;Total pasivo + patrimonio;159000,00");
  });
});
