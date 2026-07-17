// Estados contables (Fase 3), derivados de los asientos del Libro Diario:
//  - Balance de comprobación (del mes): sumas y saldos por cuenta.
//  - Estado de Resultados (del mes): ingresos − costos − gastos.
//  - Estado de Situación Financiera (acumulado a fin de mes): activo =
//    pasivo + patrimonio + resultado.
//
// Todo se calcula de las líneas de asiento (JournalLine), agrupadas por cuenta.
// Cuadra por construcción porque el motor de la Fase 2 sólo persiste asientos
// balanceados.
import { db } from "@/lib/db";
import type { MonthRange } from "./accountingData";
import { loadChartOfAccounts } from "./ledger";

type Sums = Map<string, { debit: number; credit: number }>;

/** Σ débito/crédito por cuenta para los asientos con fecha en el filtro. */
async function accountSums(
  restaurantId: string,
  dateFilter: { gte?: Date; lt?: Date },
): Promise<Sums> {
  const rows = await db.journalLine.groupBy({
    by: ["accountCode"],
    where: { entry: { restaurantId, date: dateFilter } },
    _sum: { debitCents: true, creditCents: true },
  });
  return new Map(
    rows.map((r) => [
      r.accountCode,
      { debit: r._sum.debitCents ?? 0, credit: r._sum.creditCents ?? 0 },
    ]),
  );
}

export type TrialRow = {
  code: string;
  name: string;
  debitCents: number;
  creditCents: number;
  balanceCents: number;
};
export type StatementLine = { code: string; name: string; amountCents: number };

export type Statements = {
  trial: {
    rows: TrialRow[];
    totalDebitCents: number;
    totalCreditCents: number;
    balanced: boolean;
  };
  income: {
    ingresosCents: number;
    costosCents: number;
    gastosCents: number;
    utilidadBrutaCents: number;
    utilidadOperacionalCents: number;
    ingresos: StatementLine[];
    costos: StatementLine[];
    gastos: StatementLine[];
  };
  balance: {
    activoCents: number;
    pasivoCents: number;
    patrimonioCents: number;
    resultadoCents: number;
    patrimonioTotalCents: number;
    balanced: boolean;
    activo: StatementLine[];
    pasivo: StatementLine[];
    patrimonio: StatementLine[];
  };
};

export async function loadStatements(
  restaurantId: string,
  range: MonthRange,
): Promise<Statements> {
  const [chart, monthSums, cumSums] = await Promise.all([
    loadChartOfAccounts(restaurantId),
    accountSums(restaurantId, { gte: range.from, lt: range.to }),
    accountSums(restaurantId, { lt: range.to }),
  ]);
  const meta = new Map(chart.map((a) => [a.code, a]));

  // ── Balance de comprobación (del mes) ──────────────────────────────
  const trialRows: TrialRow[] = [];
  let totalDebit = 0;
  let totalCredit = 0;
  for (const [code, s] of monthSums) {
    const a = meta.get(code);
    if (!a) continue;
    totalDebit += s.debit;
    totalCredit += s.credit;
    const bal =
      a.nature === "debito" ? s.debit - s.credit : s.credit - s.debit;
    trialRows.push({
      code,
      name: a.name,
      debitCents: s.debit,
      creditCents: s.credit,
      balanceCents: bal,
    });
  }
  trialRows.sort((x, y) => x.code.localeCompare(y.code));

  // ── Estado de Resultados (del mes) ─────────────────────────────────
  // Neto por clase: ingresos = crédito−débito (4); gastos/costos = débito−crédito.
  const income = { ingresos: 0, costos: 0, gastos: 0 };
  const ingresosLines: StatementLine[] = [];
  const costosLines: StatementLine[] = [];
  const gastosLines: StatementLine[] = [];
  for (const [code, s] of monthSums) {
    const a = meta.get(code);
    if (!a || !a.postable) continue;
    const cls = code[0];
    if (cls === "4") {
      const amt = s.credit - s.debit;
      income.ingresos += amt;
      if (amt !== 0) ingresosLines.push({ code, name: a.name, amountCents: amt });
    } else if (cls === "5") {
      const amt = s.debit - s.credit;
      income.gastos += amt;
      if (amt !== 0) gastosLines.push({ code, name: a.name, amountCents: amt });
    } else if (cls === "6") {
      const amt = s.debit - s.credit;
      income.costos += amt;
      if (amt !== 0) costosLines.push({ code, name: a.name, amountCents: amt });
    }
  }
  const utilidadBruta = income.ingresos - income.costos;
  const utilidadOperacional = utilidadBruta - income.gastos;

  // ── Estado de Situación Financiera (acumulado a fin de mes) ─────────
  const bal = { activo: 0, pasivo: 0, patrimonio: 0, ing: 0, gas: 0, cos: 0 };
  const activoLines: StatementLine[] = [];
  const pasivoLines: StatementLine[] = [];
  const patrimonioLines: StatementLine[] = [];
  for (const [code, s] of cumSums) {
    const a = meta.get(code);
    if (!a) continue;
    const cls = code[0];
    if (cls === "1") {
      const amt = s.debit - s.credit; // contra-activos (crédito) restan solos
      bal.activo += amt;
      if (a.postable && amt !== 0)
        activoLines.push({ code, name: a.name, amountCents: amt });
    } else if (cls === "2") {
      const amt = s.credit - s.debit;
      bal.pasivo += amt;
      if (a.postable && amt !== 0)
        pasivoLines.push({ code, name: a.name, amountCents: amt });
    } else if (cls === "3") {
      const amt = s.credit - s.debit;
      bal.patrimonio += amt;
      if (a.postable && amt !== 0)
        patrimonioLines.push({ code, name: a.name, amountCents: amt });
    } else if (cls === "4") bal.ing += s.credit - s.debit;
    else if (cls === "5") bal.gas += s.debit - s.credit;
    else if (cls === "6") bal.cos += s.debit - s.credit;
  }
  const resultado = bal.ing - bal.cos - bal.gas;
  const patrimonioTotal = bal.patrimonio + resultado;

  return {
    trial: {
      rows: trialRows,
      totalDebitCents: totalDebit,
      totalCreditCents: totalCredit,
      balanced: totalDebit === totalCredit,
    },
    income: {
      ingresosCents: income.ingresos,
      costosCents: income.costos,
      gastosCents: income.gastos,
      utilidadBrutaCents: utilidadBruta,
      utilidadOperacionalCents: utilidadOperacional,
      ingresos: ingresosLines.sort((x, y) => y.amountCents - x.amountCents),
      costos: costosLines.sort((x, y) => y.amountCents - x.amountCents),
      gastos: gastosLines.sort((x, y) => y.amountCents - x.amountCents),
    },
    balance: {
      activoCents: bal.activo,
      pasivoCents: bal.pasivo,
      patrimonioCents: bal.patrimonio,
      resultadoCents: resultado,
      patrimonioTotalCents: patrimonioTotal,
      balanced: bal.activo === bal.pasivo + patrimonioTotal,
      activo: activoLines.sort((x, y) => x.code.localeCompare(y.code)),
      pasivo: pasivoLines.sort((x, y) => x.code.localeCompare(y.code)),
      patrimonio: patrimonioLines.sort((x, y) => x.code.localeCompare(y.code)),
    },
  };
}
