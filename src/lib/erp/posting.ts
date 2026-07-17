// Motor de asientos (Fase 2). Genera comprobantes de doble partida a partir de
// los agregados mensuales que ya calcula accountingData.ts. Un asiento-resumen
// por fuente y por mes (source + sourceRef=mes), idempotente: re-generar borra
// y recrea el del mes, así se refresca cuando entra más data.
//
// Las cuentas son las POSTABLES (subcuentas de 6 dígitos) del PUC NIIF sembrado.
// El mapeo lo debe validar el contador.
import { db } from "@/lib/db";
import { embeddedTaxCents } from "./accounting";
import {
  type MonthRange,
  computeMonthPnl,
  computeTaxSummary,
  loadPurchasesBook,
  loadSalesBook,
} from "./accountingData";
import { ensureChartOfAccounts, loadAccountMap } from "./ledger";

type Line = { code: string; debit?: number; credit?: number; memo?: string };
type DraftEntry = { source: string; memo: string; lines: Line[] };

export type GenResult = { source: string; totalCents: number };

/** Método de pago → cuenta de caja/banco/pasarela (débito de la venta). */
function cashAccountForMethod(method: string): string {
  if (method === "cash" || method === "demo_cash") return "110505"; // Caja
  if (method === "external_terminal") return "111005"; // Banco (datáfono propio)
  return "112005"; // kushki_* → saldo en pasarela
}

/** Categoría del gasto → cuenta PUC (heurística por palabras clave). */
export function expenseAccountFor(category: string): string {
  const c = category.toLowerCase();
  if (/(arriend|alquil|\blocal\b|renta)/.test(c)) return "512010";
  if (/(honorar|contad|asesor|jur[ií]dic)/.test(c)) return "511005";
  if (/(internet|tel[eé]fon|datos|celular|plan)/.test(c)) return "513535";
  if (/(servici|agua|luz|energ|\bgas\b|acueduct|p[uú]blic)/.test(c)) return "513505";
  if (/(manteni|reparac|arreglo)/.test(c)) return "514505";
  if (/(comis|pasarela|tarjeta|dat[aá]fono)/.test(c)) return "524505";
  if (/(public|marketing|redes|pauta|volante)/.test(c)) return "529505";
  if (/(n[oó]mina|salari|sueld|personal)/.test(c)) return "510506";
  return "519505"; // Gastos diversos
}

async function sumRefunds(
  restaurantId: string,
  range: MonthRange,
): Promise<number> {
  const r = await db.kushkiTransaction.aggregate({
    where: {
      restaurantId,
      kind: "refund",
      createdAt: { gte: range.from, lt: range.to },
    },
    _sum: { amountCents: true },
  });
  return r._sum.amountCents ?? 0;
}

/**
 * Arma (sin persistir) los asientos-resumen del mes. Cada uno cuadra por
 * construcción: la cuenta "plug" (ingreso 4135 en ventas, proveedores 2205 en
 * compras) absorbe la diferencia.
 */
async function buildMonthEntries(
  restaurantId: string,
  range: MonthRange,
): Promise<DraftEntry[]> {
  const [salesBook, purchasesBook, tax, pnl, refunds] = await Promise.all([
    loadSalesBook(restaurantId, range),
    loadPurchasesBook(restaurantId, range),
    computeTaxSummary(restaurantId, range),
    computeMonthPnl(restaurantId, range),
    sumRefunds(restaurantId, range),
  ]);

  const salesTaxCode =
    tax.sales.kind === "iva"
      ? "240805"
      : tax.sales.kind === "inc"
        ? "241205"
        : null;

  const entries: DraftEntry[] = [];

  // 1) VENTAS — D caja/banco/pasarela · C ingresos + impuesto + propinas.
  {
    const lines: Line[] = [];
    let totalCash = 0;
    for (const m of salesBook.totals.byMethod) {
      if (m.amountCents <= 0) continue;
      lines.push({
        code: cashAccountForMethod(m.method),
        debit: m.amountCents,
        memo: m.method,
      });
      totalCash += m.amountCents;
    }
    const salesTax = tax.sales.taxCents;
    const tips = salesBook.totals.tipCents;
    const income = totalCash - salesTax - tips;
    if (totalCash > 0 && income >= 0) {
      if (income > 0) lines.push({ code: "413505", credit: income });
      if (salesTax > 0 && salesTaxCode)
        lines.push({ code: salesTaxCode, credit: salesTax });
      if (tips > 0) lines.push({ code: "238030", credit: tips });
      entries.push({ source: "sale", memo: "Ventas del mes", lines });
    }
  }

  // 2) COMPRAS — D inventario + IVA descontable · C proveedores − retenciones.
  {
    const t = purchasesBook.totals;
    const invDebit = t.receivedCents + t.incCents; // INC como parte del costo
    if (invDebit > 0 || t.ivaCents > 0) {
      const lines: Line[] = [];
      if (invDebit > 0) lines.push({ code: "143505", debit: invDebit });
      if (t.ivaCents > 0) lines.push({ code: "240805", debit: t.ivaCents });
      if (t.retefuenteCents > 0)
        lines.push({ code: "236505", credit: t.retefuenteCents });
      if (t.reteIvaCents > 0)
        lines.push({ code: "236705", credit: t.reteIvaCents });
      if (t.reteIcaCents > 0)
        lines.push({ code: "236805", credit: t.reteIcaCents });
      const ret = t.retefuenteCents + t.reteIvaCents + t.reteIcaCents;
      const proveedores = invDebit + t.ivaCents - ret;
      lines.push({ code: "220505", credit: proveedores });
      entries.push({ source: "purchase", memo: "Compras del mes", lines });
    }
  }

  // 3) COSTO DE VENTAS — D costo · C inventario.
  if (pnl.consumptionCents > 0) {
    entries.push({
      source: "cogs",
      memo: "Costo de ventas del mes",
      lines: [
        { code: "613505", debit: pnl.consumptionCents },
        { code: "143505", credit: pnl.consumptionCents },
      ],
    });
  }

  // 4) MERMAS — D gasto · C inventario.
  if (pnl.wasteCents > 0) {
    entries.push({
      source: "waste",
      memo: "Mermas del mes",
      lines: [
        { code: "519505", debit: pnl.wasteCents },
        { code: "143505", credit: pnl.wasteCents },
      ],
    });
  }

  // 5) GASTOS — D gasto por categoría · C bancos.
  {
    const cats = pnl.expensesByCategory.filter((e) => e.amountCents > 0);
    const total = cats.reduce((s, e) => s + e.amountCents, 0);
    if (total > 0) {
      const lines: Line[] = cats.map((e) => ({
        code: expenseAccountFor(e.category),
        debit: e.amountCents,
        memo: e.category,
      }));
      lines.push({ code: "111005", credit: total });
      entries.push({ source: "expense", memo: "Gastos del mes", lines });
    }
  }

  // 6) NÓMINA — D gastos de personal · C salarios por pagar.
  {
    const labor = pnl.labor?.totalCents ?? 0;
    if (labor > 0) {
      entries.push({
        source: "payroll",
        memo: "Nómina del mes",
        lines: [
          { code: "510506", debit: labor },
          { code: "250505", credit: labor },
        ],
      });
    }
  }

  // 7) DEVOLUCIONES — D devoluciones + impuesto · C pasarela.
  if (refunds > 0) {
    const rtax =
      tax.sales.kind === "none" ? 0 : embeddedTaxCents(refunds, tax.sales.pct);
    const lines: Line[] = [{ code: "417505", debit: refunds - rtax }];
    if (rtax > 0 && salesTaxCode)
      lines.push({ code: salesTaxCode, debit: rtax });
    lines.push({ code: "112005", credit: refunds });
    entries.push({ source: "refund", memo: "Devoluciones del mes", lines });
  }

  return entries;
}

/**
 * Genera (o refresca) los asientos-resumen del mes `month` (YYYY-MM). Borra los
 * existentes de ese mes por fuente y los recrea. Sólo persiste los que cuadran.
 */
export async function generateJournalForMonth(
  restaurantId: string,
  month: string,
  range: MonthRange,
): Promise<GenResult[]> {
  await ensureChartOfAccounts(restaurantId);
  const map = await loadAccountMap(restaurantId);
  const drafts = await buildMonthEntries(restaurantId, range);
  // Fecha del asiento = último instante del mes.
  const date = new Date(range.to.getTime() - 1);

  const results: GenResult[] = [];
  for (const e of drafts) {
    const debit = e.lines.reduce((s, l) => s + (l.debit ?? 0), 0);
    const credit = e.lines.reduce((s, l) => s + (l.credit ?? 0), 0);
    // Guarda de balance + que todas las cuentas existan.
    if (debit !== credit || debit === 0) {
      if (debit !== credit) {
        console.error("[posting] asiento desbalanceado", {
          source: e.source,
          month,
          debit,
          credit,
        });
      }
      continue;
    }
    if (e.lines.some((l) => !map.get(l.code))) {
      console.error("[posting] cuenta faltante", { source: e.source, month });
      continue;
    }
    await db.$transaction(async (tx) => {
      await tx.journalEntry.deleteMany({
        where: { restaurantId, source: e.source, sourceRef: month },
      });
      await tx.journalEntry.create({
        data: {
          restaurantId,
          date,
          source: e.source,
          sourceRef: month,
          memo: e.memo,
          status: "posted",
          lines: {
            create: e.lines.map((l) => ({
              accountId: map.get(l.code)!,
              accountCode: l.code,
              debitCents: l.debit ?? 0,
              creditCents: l.credit ?? 0,
              memo: l.memo,
            })),
          },
        },
      });
    });
    results.push({ source: e.source, totalCents: debit });
  }
  return results;
}

export type JournalEntryDto = {
  id: string;
  date: string;
  source: string;
  memo: string | null;
  lines: Array<{
    accountCode: string;
    accountName: string;
    debitCents: number;
    creditCents: number;
    memo: string | null;
  }>;
};

/** Asientos del mes (para el Libro Diario), con el nombre de cada cuenta. */
export async function loadJournalForMonth(
  restaurantId: string,
  month: string,
): Promise<JournalEntryDto[]> {
  const [entries, accounts] = await Promise.all([
    db.journalEntry.findMany({
      where: { restaurantId, sourceRef: month },
      orderBy: [{ date: "asc" }, { source: "asc" }],
      include: { lines: true },
    }),
    db.ledgerAccount.findMany({
      where: { restaurantId },
      select: { code: true, name: true },
    }),
  ]);
  const nameByCode = new Map(accounts.map((a) => [a.code, a.name]));
  return entries.map((e) => ({
    id: e.id,
    date: e.date.toISOString(),
    source: e.source,
    memo: e.memo,
    lines: e.lines
      .slice()
      .sort((a, b) => b.debitCents - a.debitCents)
      .map((l) => ({
        accountCode: l.accountCode,
        accountName: nameByCode.get(l.accountCode) ?? "—",
        debitCents: l.debitCents,
        creditCents: l.creditCents,
        memo: l.memo,
      })),
  }));
}
