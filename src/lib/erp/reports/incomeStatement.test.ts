import { describe, expect, it } from "vitest";
import {
  buildIncomeStatement,
  cascadeToRows,
  incomeBands,
  incomeStatementCsvRows,
  summarizeIncome,
  type CascadeRow,
  type ResultAccountInput,
  type ResultMovement,
} from "./incomeStatement";
import { labelText, type StatementLabel } from "./statementLabel";

/**
 * Plan mínimo con las cuentas que ejercitan cada tramo de la cascada
 * colombiana: 41 (ordinarios), 4210 (financieros), 4295 (otros), 6135
 * (costos), 5105/5205 (personal, por naturaleza), 5110 (honorarios), 5305
 * (financieros), 5395 (otros gastos), 5405 (impuesto de renta), 3805 (ORI).
 */
const ACCOUNTS: ResultAccountInput[] = [
  { code: "41", name: "Operacionales", type: "ingreso" },
  { code: "4135", name: "Comercio", type: "ingreso" },
  { code: "413505", name: "Venta de alimentos", type: "ingreso" },
  { code: "42", name: "No operacionales", type: "ingreso" },
  { code: "4210", name: "Financieros", type: "ingreso" },
  { code: "421005", name: "Rendimientos", type: "ingreso" },
  { code: "4295", name: "Diversos", type: "ingreso" },
  { code: "429505", name: "Ingresos diversos", type: "ingreso" },
  { code: "61", name: "Costo de ventas", type: "costo" },
  { code: "6135", name: "Comercio", type: "costo" },
  { code: "613505", name: "Costo de alimentos", type: "costo" },
  { code: "51", name: "Operacionales de administración", type: "gasto" },
  { code: "5105", name: "Gastos de personal", type: "gasto" },
  { code: "510506", name: "Sueldos administración", type: "gasto" },
  { code: "5110", name: "Honorarios", type: "gasto" },
  { code: "511005", name: "Honorarios", type: "gasto" },
  { code: "52", name: "Operacionales de ventas", type: "gasto" },
  { code: "5205", name: "Gastos de personal (ventas)", type: "gasto" },
  { code: "520506", name: "Sueldos ventas", type: "gasto" },
  { code: "53", name: "No operacionales", type: "gasto" },
  { code: "5305", name: "Financieros", type: "gasto" },
  { code: "530505", name: "Gastos bancarios", type: "gasto" },
  { code: "5395", name: "Gastos diversos", type: "gasto" },
  { code: "539505", name: "Gastos diversos", type: "gasto" },
  { code: "54", name: "Impuesto de renta", type: "gasto" },
  { code: "5405", name: "Impuesto de renta y complementarios", type: "gasto" },
  { code: "540505", name: "Impuesto de renta", type: "gasto" },
  { code: "38", name: "Superávit por valorizaciones", type: "patrimonio" },
  { code: "3805", name: "De inversiones", type: "patrimonio" },
  { code: "380505", name: "Valorización", type: "patrimonio" },
];

const M = (accountCode: string, movementCents: number, month = "2026-03"): ResultMovement => ({
  accountCode,
  month,
  movementCents,
});

/** Movimientos de marzo 2026 (créditos negativos). */
const MOVS: ResultMovement[] = [
  M("413505", -1_000_000),
  M("421005", -50_000),
  M("429505", -20_000),
  M("613505", 400_000),
  M("510506", 150_000),
  M("520506", 50_000),
  M("511005", 20_000),
  M("530505", 30_000),
  M("539505", 10_000),
  M("540505", 60_000),
  M("380505", -5_000),
];

const t = (key: string, params?: Record<string, string | number>) =>
  params ? `[${key}:${Object.values(params).join(",")}]` : `[${key}]`;
const text = (l: StatementLabel) => labelText(l, t);

const build = (movements = MOVS, country: string | null = "CO", from = "2026-03-01", to = "2026-03-31") =>
  buildIncomeStatement({ movements, accounts: ACCOUNTS, country, from, to });

describe("summarizeIncome — las siete cifras", () => {
  it("CO: impuesto de renta aparte, ORI desde 38*", () => {
    expect(summarizeIncome(MOVS, ACCOUNTS, "CO")).toEqual({
      incomeCents: 1_070_000,
      costCents: 400_000,
      expensesCents: 260_000,
      incomeTaxCents: 60_000,
      resultCents: 350_000,
      oriCents: 5_000,
      integralCents: 355_000,
    });
  });

  it("fuera de CO: sin impuesto separado ni ORI (54 es un gasto más)", () => {
    expect(summarizeIncome(MOVS, ACCOUNTS, "MX")).toEqual({
      incomeCents: 1_070_000,
      costCents: 400_000,
      expensesCents: 320_000,
      incomeTaxCents: 0,
      resultCents: 350_000,
      oriCents: 0,
      integralCents: 350_000,
    });
  });

  it("una cuenta fuera del plan se clasifica por la clase del PUC", () => {
    const s = summarizeIncome([M("419505", -100), M("719505", 40)], [], "CO");
    expect(s.incomeCents).toBe(100);
    expect(s.costCents).toBe(40);
    expect(s.resultCents).toBe(60);
  });
});

describe("cascada colombiana", () => {
  const stmt = build();
  const line = (key: string) => stmt.cascade.find((r) => r.key === key)!;

  it("va en el orden del estado, con cada subtotal y el integral", () => {
    expect(stmt.classification).toBe("co");
    expect(stmt.cascade.map((r) => r.key)).toEqual([
      "ing",
      "ing-fin",
      "otros-ing",
      "costo-inv",
      "nat-05",
      "nat-10",
      "costos-fin",
      "otros-gastos",
      "antes-imp",
      "imp",
      "neto",
      "ori-head",
      "ori",
      "integral",
    ]);
    expect(line("ing")).toMatchObject({ type: "line", code: "41", valueCents: 1_000_000 });
    expect(line("ing-fin")).toMatchObject({ code: "4210", valueCents: 50_000 });
    expect(line("otros-ing")).toMatchObject({ valueCents: 20_000 });
    expect(line("costo-inv")).toMatchObject({ valueCents: -400_000 });
    expect(line("costos-fin")).toMatchObject({ code: "5305", valueCents: -30_000 });
    expect(line("otros-gastos")).toMatchObject({ valueCents: -10_000 });
    expect(line("antes-imp")).toMatchObject({ type: "subtotal", valueCents: 410_000 });
    expect(line("imp")).toMatchObject({ code: "54", valueCents: -60_000 });
    expect(line("neto")).toMatchObject({ type: "subtotal", valueCents: 350_000 });
    expect(text(line("neto").label)).toBe("[isResult]");
    expect(line("ori-head").type).toBe("head");
    expect(line("ori")).toMatchObject({ code: "38", valueCents: 5_000 });
    expect(line("integral")).toMatchObject({ type: "total", valueCents: 355_000 });
  });

  it("cada subtotal es la suma visible de lo que tiene encima", () => {
    let acc = 0;
    for (const r of stmt.cascade) {
      if (r.type === "line") acc += r.valueCents;
      if (r.type === "subtotal" || r.type === "total") expect(r.valueCents).toBe(acc);
    }
  });

  it("gastos por naturaleza: 5105 + 5205 se funden y se rotulan con la 51xx del plan", () => {
    expect(line("nat-05")).toMatchObject({ code: "x05", valueCents: -200_000 });
    expect(line("nat-05").label).toEqual({ text: "Gastos de personal" });
    expect(line("nat-10")).toMatchObject({ code: "x10", valueCents: -20_000 });
    expect(line("nat-10").label).toEqual({ text: "Honorarios" });
  });

  it("un 52xx solo se rotula igual con la 51xx; sin 51xx en el plan, clave de respaldo", () => {
    const solo52 = build([M("520506", 50_000)]);
    expect(solo52.cascade.find((r) => r.key === "nat-05")!.label).toEqual({ text: "Gastos de personal" });
    const sinPlan = buildIncomeStatement({
      movements: [M("529506", 7_000)],
      accounts: [{ code: "529506", name: "Diversos ventas", type: "gasto" }],
      country: "CO",
      from: "2026-03-01",
      to: "2026-03-31",
    });
    const nat = sinPlan.cascade.find((r) => r.key === "nat-95")!;
    expect(nat.label).toEqual({ key: "isNatureFallback", params: { sub: "95" } });
    expect(text(nat.label)).toBe("[isNatureFallback:95]");
  });

  it("las líneas opcionales solo salen con cifra; sin ORI va la nota", () => {
    const minimo = build([M("413505", -100), M("510506", 30)]);
    expect(minimo.cascade.map((r) => r.key)).toEqual([
      "ing",
      "costo-inv",
      "nat-05",
      "antes-imp",
      "imp",
      "neto",
      "ori-head",
      "ori-nota",
      "integral",
    ]);
    expect(minimo.cascade.find((r) => r.key === "ori-nota")!.type).toBe("note");
  });

  it("con pérdida el resultado se rotula como pérdida", () => {
    const perdida = build([M("413505", -100), M("510506", 300)]);
    expect(perdida.summary.resultCents).toBe(-200);
    expect(text(perdida.cascade.find((r) => r.key === "neto")!.label)).toBe("[isResultLoss]");
  });

  it("avisa de cuentas de resultado fuera de los prefijos habituales", () => {
    expect(stmt.issues).toEqual([]);
    const raro = buildIncomeStatement({
      movements: [M("819505", -100)],
      accounts: [{ code: "819505", name: "Rara", type: "ingreso" }],
      country: "CO",
      from: "2026-03-01",
      to: "2026-03-31",
    });
    expect(raro.issues).toEqual([{ key: "isIssueOutOfPrefix" }]);
  });
});

describe("bandas (presentación)", () => {
  const stmt = build();

  it("recogen tiradas consecutivas; una sola hija sale suelta; los subtotales no caen dentro", () => {
    expect(stmt.rows.filter((r) => r.depth === 0).map((r) => r.key)).toEqual([
      "g-ingresos",
      "costo-inv",
      "g-gastos-oper",
      "g-no-oper",
      "antes-imp",
      "imp",
      "neto",
      "ori-head",
      "ori",
      "integral",
    ]);
    const group = (k: string) => stmt.rows.find((r) => r.key === k)!;
    expect(group("g-ingresos")).toMatchObject({ variant: "group", valueCents: 1_070_000, hasChildren: true });
    expect(group("g-gastos-oper")).toMatchObject({ variant: "group", valueCents: -220_000 });
    expect(group("g-no-oper")).toMatchObject({ variant: "group", valueCents: -40_000 });
    expect(stmt.rows.find((r) => r.key === "nat-05")).toMatchObject({ depth: 1, ancestors: ["g-gastos-oper"] });
    expect(stmt.rows.find((r) => r.key === "ori-head")).toMatchObject({ variant: "head", valueCents: null });
    // Ninguna línea se pierde ni se reordena.
    expect(stmt.rows.filter((r) => r.variant !== "group").map((r) => r.key)).toEqual(
      stmt.cascade.map((r) => r.key),
    );
  });

  it("con una sola naturaleza la banda de gastos no se inventa", () => {
    const una = build([M("413505", -100), M("510506", 30), M("530505", 5)]);
    expect(una.rows.map((r) => r.key)).toEqual([
      "ing",
      "costo-inv",
      "nat-05",
      "costos-fin",
      "antes-imp",
      "imp",
      "neto",
      "ori-head",
      "ori-nota",
      "integral",
    ]);
  });

  it("cascadeToRows: dos tiradas de la misma banda dan dos bandas con llave distinta", () => {
    const cascade: CascadeRow[] = [
      { type: "line", key: "ing", label: { key: "a" }, valueCents: 1 },
      { type: "line", key: "ing-fin", label: { key: "b" }, valueCents: 2 },
      { type: "subtotal", key: "s", label: { key: "s" }, valueCents: 3 },
      { type: "line", key: "otros-ing", label: { key: "c" }, valueCents: 4 },
    ];
    const rows = cascadeToRows(cascade, incomeBands([]));
    expect(rows.map((r) => `${r.depth}:${r.key}`)).toEqual(["0:g-ingresos", "1:ing", "1:ing-fin", "0:s", "0:otros-ing"]);
  });
});

describe("fuera de Colombia: secciones genéricas por tipo", () => {
  const stmt = build(MOVS, "MX");

  it("tres líneas y el resultado, sin bandas, con el aviso de clasificación", () => {
    expect(stmt.classification).toBe("generic");
    expect(stmt.cascade.map((r) => r.key)).toEqual(["ing", "costo-inv", "otros-gastos", "neto"]);
    expect(stmt.cascade.find((r) => r.key === "otros-gastos")).toMatchObject({ valueCents: -320_000 });
    expect(stmt.rows.map((r) => r.key)).toEqual(["ing", "costo-inv", "otros-gastos", "neto"]);
    expect(stmt.issues).toEqual([{ key: "isIssueGeneric" }]);
    expect(stmt.summary.integralCents).toBe(350_000);
  });
});

describe("meses del rango", () => {
  it("un resumen por mes, con `partial` cuando el rango corta el mes", () => {
    const stmt = build(
      [M("413505", -100, "2026-01"), M("413505", -200, "2026-02"), M("510506", 50, "2026-03")],
      "CO",
      "2026-01-15",
      "2026-03-10",
    );
    expect(stmt.months.map((m) => [m.key, m.from, m.to, m.partial])).toEqual([
      ["2026-01", "2026-01-15", "2026-01-31", true],
      ["2026-02", "2026-02-01", "2026-02-28", false],
      ["2026-03", "2026-03-01", "2026-03-10", true],
    ]);
    expect(stmt.months.map((m) => m.incomeCents)).toEqual([100, 200, 0]);
    expect(stmt.months.map((m) => m.resultCents)).toEqual([100, 200, -50]);
    expect(stmt.months.map((m) => m.integralCents)).toEqual([100, 200, -50]);
  });

  it("un ejercicio completo son 12 meses enteros", () => {
    const stmt = build([], "CO", "2025-01-01", "2025-12-31");
    expect(stmt.months).toHaveLength(12);
    expect(stmt.months.every((m) => !m.partial)).toBe(true);
    expect(stmt.hasMovements).toBe(false);
  });

  it("un movimiento fuera del rango es un error de datos, no se traga", () => {
    expect(() => build([M("413505", -100, "2026-04")], "CO", "2026-03-01", "2026-03-31")).toThrow(
      /movement_out_of_period/,
    );
    expect(() => build([], "CO", "2026-03-31", "2026-03-01")).toThrow("period");
  });
});

describe("CSV", () => {
  it("bandas, líneas, subtotales y total con cifra; la sección es el último encabezado", () => {
    const rows = incomeStatementCsvRows(build(), text);
    expect(rows[0]).toEqual(["", "", "[isBandIncome]", 1_070_000]);
    expect(rows[1]).toEqual(["", "41", "[isIncomeOrdinary]", 1_000_000]);
    expect(rows).toContainEqual(["", "x05", "Gastos de personal", -200_000]);
    expect(rows).toContainEqual(["", "", "[isBeforeTax]", 410_000]);
    expect(rows).toContainEqual(["[isOriHead]", "38", "[isOri]", 5_000]);
    expect(rows.at(-1)).toEqual(["[isOriHead]", "", "[isIntegral]", 355_000]);
    expect(rows.some((r) => r[2] === "[isOriHead]")).toBe(false);
  });

  it("las notas sin cifra se omiten", () => {
    const rows = incomeStatementCsvRows(build([M("413505", -100)]), text);
    expect(rows.some((r) => r[2] === "[isOriNone]")).toBe(false);
  });
});
