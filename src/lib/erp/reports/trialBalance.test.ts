import { describe, expect, it } from "vitest";
import { buildReportCsv } from "./csv";
import {
  buildTrialBalance,
  inAccountRange,
  parseTrialBalanceLevel,
  trialBalanceCsvRows,
  type TrialBalanceDbRow,
} from "./trialBalance";

const accounts = [
  { code: "1", name: "Activo" },
  { code: "11", name: "Efectivo y equivalentes" },
  { code: "1105", name: "Caja" },
  { code: "110505", name: "Caja general" },
  { code: "1110", name: "Bancos" },
  { code: "111005", name: "Moneda nacional" },
  { code: "14", name: "Inventarios" },
  { code: "1435", name: "Mercancías" },
  { code: "143505", name: "Inventario de insumos" },
  { code: "2", name: "Pasivo" },
  { code: "22", name: "Proveedores" },
  { code: "2205", name: "Nacionales" },
  { code: "220505", name: "Proveedores nacionales" },
  { code: "4", name: "Ingresos" },
  { code: "41", name: "Operacionales" },
  { code: "4135", name: "Comercio" },
  { code: "413505", name: "Ventas restaurante" },
];

/** Libro cuadrado: Σ D = Σ C en el rango y saldos coherentes. */
const balancedRows: TrialBalanceDbRow[] = [
  { accountCode: "110505", initialCents: 100_000, debitCents: 50_000, creditCents: 20_000, finalCents: 130_000 },
  { accountCode: "111005", initialCents: 300_000, debitCents: 0, creditCents: 30_000, finalCents: 270_000 },
  { accountCode: "143505", initialCents: 80_000, debitCents: 30_000, creditCents: 0, finalCents: 110_000 },
  { accountCode: "220505", initialCents: -180_000, debitCents: 20_000, creditCents: 30_000, finalCents: -190_000 },
  { accountCode: "413505", initialCents: -300_000, debitCents: 0, creditCents: 20_000, finalCents: -320_000 },
];

describe("buildTrialBalance — niveles", () => {
  it("nivel 6: clase → grupo → cuenta → subcuenta, cada nodo = Σ hojas", () => {
    const tb = buildTrialBalance(balancedRows, { level: 6, accounts });
    expect(tb.rows.map((r) => `${r.depth}:${r.code}`)).toEqual([
      "0:1", "1:11", "2:1105", "3:110505", "2:1110", "3:111005", "1:14", "2:1435", "3:143505",
      "0:2", "1:22", "2:2205", "3:220505",
      "0:4", "1:41", "2:4135", "3:413505",
    ]);
    const activo = tb.rows.find((r) => r.code === "1")!;
    expect(activo).toMatchObject({
      name: "Activo",
      initialCents: 480_000,
      debitCents: 80_000,
      creditCents: 50_000,
      finalCents: 510_000,
    });
    const efectivo = tb.rows.find((r) => r.code === "11")!;
    expect(efectivo).toMatchObject({ initialCents: 400_000, debitCents: 50_000, creditCents: 50_000, finalCents: 400_000 });
  });

  it("nivel 4 corta en la cuenta; nivel 2 en el grupo; nivel 1 en la clase", () => {
    const l4 = buildTrialBalance(balancedRows, { level: 4, accounts });
    expect(l4.rows.map((r) => r.code)).toEqual(["1", "11", "1105", "1110", "14", "1435", "2", "22", "2205", "4", "41", "4135"]);
    expect(l4.rows.find((r) => r.code === "1105")!.finalCents).toBe(130_000);
    const l2 = buildTrialBalance(balancedRows, { level: 2, accounts });
    expect(l2.rows.map((r) => r.code)).toEqual(["1", "11", "14", "2", "22", "4", "41"]);
    const l1 = buildTrialBalance(balancedRows, { level: 1, accounts });
    expect(l1.rows.map((r) => r.code)).toEqual(["1", "2", "4"]);
    expect(l1.rows.find((r) => r.code === "1")!.hasChildren).toBe(false);
    // Los totales no dependen del nivel.
    expect(l1.totals).toEqual(l4.totals);
  });

  it("parseTrialBalanceLevel: 1/2/4/6, cualquier otra cosa → 6", () => {
    expect(parseTrialBalanceLevel("2")).toBe(2);
    expect(parseTrialBalanceLevel("3")).toBe(6);
    expect(parseTrialBalanceLevel(undefined)).toBe(6);
  });
});

describe("buildTrialBalance — cuadre", () => {
  it("cuadra con datos cuadrados (Σ D = Σ C) y totales = Σ hojas", () => {
    const tb = buildTrialBalance(balancedRows, { level: 6, accounts });
    expect(tb.totals).toEqual({
      initialCents: 0,
      debitCents: 100_000,
      creditCents: 100_000,
      finalCents: 0,
    });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceCents).toBe(0);
    expect(tb.filtered).toBe(false);
    expect(tb.dimension).toBe("none");
  });

  it("tolera 1 centavo de redondeo, no más", () => {
    const oneCent = balancedRows.map((r) =>
      r.accountCode === "413505" ? { ...r, creditCents: r.creditCents + 1 } : r,
    );
    expect(buildTrialBalance(oneCent, { level: 6, accounts }).balanced).toBe(true);
    const twoCents = balancedRows.map((r) =>
      r.accountCode === "413505" ? { ...r, creditCents: r.creditCents + 2 } : r,
    );
    const tb = buildTrialBalance(twoCents, { level: 6, accounts });
    expect(tb.balanced).toBe(false);
    expect(tb.differenceCents).toBe(-2);
  });

  it("descuadre real → balanced false con la diferencia", () => {
    const broken = balancedRows.map((r) =>
      r.accountCode === "110505" ? { ...r, debitCents: 60_000 } : r,
    );
    const tb = buildTrialBalance(broken, { level: 6, accounts });
    expect(tb.balanced).toBe(false);
    expect(tb.differenceCents).toBe(10_000);
  });

  it("original anulado + reversa: la consulta trae ambos y la cuenta queda en cero con movimiento", () => {
    // `loadTrialBalanceRows` NO filtra por status, así que la fila de la
    // cuenta ya llega neteada: D 9.000 (reversa) y C 9.000 (original).
    const withReversal: TrialBalanceDbRow[] = [
      ...balancedRows,
      { accountCode: "110510", initialCents: 0, debitCents: 9_000, creditCents: 9_000, finalCents: 0 },
      { accountCode: "530505", initialCents: 0, debitCents: 9_000, creditCents: 9_000, finalCents: 0 },
    ];
    const tb = buildTrialBalance(withReversal, { level: 6, accounts });
    const caja = tb.rows.find((r) => r.code === "110510")!;
    expect(caja).toMatchObject({ initialCents: 0, debitCents: 9_000, creditCents: 9_000, finalCents: 0 });
    expect(tb.balanced).toBe(true);
    expect(tb.totals.debitCents).toBe(118_000);
  });

  it("descarta las cuentas sin saldo ni movimiento", () => {
    const tb = buildTrialBalance(
      [...balancedRows, { accountCode: "999999", initialCents: 0, debitCents: 0, creditCents: 0, finalCents: 0 }],
      { level: 6, accounts },
    );
    expect(tb.rows.some((r) => r.code.startsWith("9"))).toBe(false);
  });
});

describe("buildTrialBalance — filtro por prefijo", () => {
  it("inAccountRange: prefijos inclusivos en ambos extremos", () => {
    expect(inAccountRange("110505", "1105", "1110")).toBe(true);
    expect(inAccountRange("111005", "1105", "1110")).toBe(true);
    expect(inAccountRange("111505", "1105", "1110")).toBe(false);
    expect(inAccountRange("110505", "1110", null)).toBe(false);
    expect(inAccountRange("413505", null, "2")).toBe(false);
    expect(inAccountRange("413505", null, null)).toBe(true);
  });

  it("con filtro: filas y totales del filtro, `filtered`, y el cuadre sigue midiendo TODO el libro", () => {
    const tb = buildTrialBalance(balancedRows, { level: 6, accounts, accountFrom: "11", accountTo: "11" });
    expect(tb.filtered).toBe(true);
    expect(tb.rows.map((r) => r.code)).toEqual(["1", "11", "1105", "110505", "1110", "111005"]);
    expect(tb.totals).toEqual({ initialCents: 400_000, debitCents: 50_000, creditCents: 50_000, finalCents: 400_000 });
    expect(tb.bookTotals).toEqual({ initialCents: 0, debitCents: 100_000, creditCents: 100_000, finalCents: 0 });
    expect(tb.balanced).toBe(true);
    const only2 = buildTrialBalance(balancedRows, { level: 6, accounts, accountFrom: "2", accountTo: "2" });
    expect(only2.rows.map((r) => r.code)).toEqual(["2", "22", "2205", "220505"]);
    expect(only2.totals.debitCents).toBe(20_000);
    expect(only2.balanced).toBe(true);
  });
});

describe("trialBalanceCsvRows", () => {
  it("jerarquía completa + fila TOTAL, montos con coma decimal en el CSV", () => {
    const tb = buildTrialBalance(balancedRows, { level: 2, accounts });
    const rows = trialBalanceCsvRows(tb, "TOTAL");
    expect(rows).toHaveLength(tb.rows.length + 1);
    expect(rows[0]).toEqual(["1", "Activo", 480_000, 80_000, 50_000, 510_000]);
    expect(rows.at(-1)).toEqual(["", "TOTAL", 0, 100_000, 100_000, 0]);
    const csv = buildReportCsv({
      headers: ["Código", "Cuenta", "Saldo anterior", "Débitos", "Créditos", "Nuevo saldo"],
      rows,
    });
    const lines = csv.slice(1).split("\r\n");
    expect(lines[1]).toBe("1;Activo;4800,00;800,00;500,00;5100,00");
    expect(lines.at(-1)).toBe(";TOTAL;0,00;1000,00;1000,00;0,00");
  });
});
