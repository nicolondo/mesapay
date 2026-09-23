// Motor de asientos (Fase 2). Genera comprobantes de doble partida a partir de
// los agregados mensuales que ya calcula accountingData.ts. Un asiento-resumen
// por fuente y por mes (source + sourceRef=mes), idempotente: re-generar borra
// y recrea el del mes, así se refresca cuando entra más data.
//
// Los códigos base viven en engineCodes.ts (ENGINE). Antes de asentar, cada
// uno se resuelve a su cuenta IMPUTABLE (chart.ts resolvePostableCode): si
// el contador abrió auxiliares debajo, el movimiento cae en la auxiliar.
// El mapeo lo debe validar el contador.
import { db } from "@/lib/db";
import { embeddedTaxCents, monthRange } from "./accounting";
import {
  type MonthRange,
  computeMonthPnl,
  computeTaxSummary,
  loadPurchasesBook,
  loadSalesBook,
} from "./accountingData";
import { ensureChartOfAccounts, loadAccountIndex } from "./ledger";
import { depreciationLinesForMonth } from "./activos";
import { deferredAmortizationLinesForMonth } from "./deferred";
import { resolvePostableCode } from "./chart";
import { ENGINE } from "./engineCodes";
import { ivaGeneradoCodeForPct } from "./pucNiif";
import { payrollTotalsForPosting } from "./payrollData";
import { resolvePurchasePaymentAccount } from "./paymentAccounts";

type Line = {
  code: string;
  debit?: number;
  credit?: number;
  memo?: string;
  /** Centro de costos de la línea (hoy sólo lo traen los diferidos). */
  costCenterId?: string | null;
};
type DraftEntry = { source: string; memo: string; lines: Line[] };

export type GenResult = { source: string; totalCents: number };

/** Método de pago → cuenta de caja/banco/pasarela (débito de la venta). */
function cashAccountForMethod(method: string): string {
  if (method === "cash" || method === "demo_cash") return ENGINE.CAJA; // Caja
  if (method === "external_terminal") return ENGINE.BANCOS; // Banco (datáfono propio)
  // Bono empresarial: no entra plata en la mesa — baja el pasivo "bonos por
  // redimir". El lado del pasivo (emisión/cobro del lote) lo define la fase
  // fiscal; acá sólo se evita clasificarlo como caja o pasarela.
  if (method === "voucher") return ENGINE.BONOS_POR_REDIMIR;
  // Venta a crédito a un cliente de facturación: tampoco entra plata —
  // debita Clientes (CxC). La plata llega con los abonos (bloque 1b).
  if (method === "customer_credit") return ENGINE.CLIENTES;
  return ENGINE.PASARELA; // kushki_* → saldo en pasarela
}

/**
 * Cuenta donde se acumulan los gastos por pagar. El gasto acredita acá al
 * registrarse y se cancela contra la caja/banco al pagarse.
 */
export const EXPENSE_PAYABLE_CODE = ENGINE.GASTOS_POR_PAGAR;

/** Categoría del gasto → cuenta PUC (heurística por palabras clave). */
export function expenseAccountFor(category: string): string {
  const c = category.toLowerCase();
  if (/(arriend|alquil|\blocal\b|renta)/.test(c)) return ENGINE.ARRIENDOS;
  if (/(honorar|contad|asesor|jur[ií]dic)/.test(c)) return ENGINE.HONORARIOS;
  if (/(internet|tel[eé]fon|datos|celular|plan)/.test(c)) return ENGINE.TELECOMUNICACIONES;
  if (/(servici|agua|luz|energ|\bgas\b|acueduct|p[uú]blic)/.test(c)) return ENGINE.SERVICIOS_PUBLICOS;
  if (/(manteni|reparac|arreglo)/.test(c)) return ENGINE.MANTENIMIENTO;
  if (/(comis|pasarela|tarjeta|dat[aá]fono)/.test(c)) return ENGINE.COMISIONES;
  if (/(public|marketing|redes|pauta|volante)/.test(c)) return ENGINE.PUBLICIDAD;
  if (/(n[oó]mina|salari|sueld|personal)/.test(c)) return ENGINE.NOMINA_SALARIOS;
  return ENGINE.GASTOS_DIVERSOS; // Gastos diversos
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
  month: string,
  range: MonthRange,
): Promise<DraftEntry[]> {
  const [salesBook, purchasesBook, tax, pnl, refunds, grossPays] =
    await Promise.all([
      loadSalesBook(restaurantId, range),
      loadPurchasesBook(restaurantId, range),
      computeTaxSummary(restaurantId, range),
      computeMonthPnl(restaurantId, range),
      sumRefunds(restaurantId, range),
      // Cobros BRUTOS por método (approved + refunded): el asiento de ventas
      // debita lo cobrado originalmente; las devoluciones tienen su propio
      // asiento que acredita la pasarela. Si filtráramos sólo approved, un
      // pago totalmente devuelto (status→refunded) desaparecería del débito
      // pero la devolución igual acreditaría → doble descuento.
      db.payment.groupBy({
        by: ["method"],
        where: {
          status: { in: ["approved", "refunded"] },
          order: {
            restaurantId,
            paidAt: { gte: range.from, lt: range.to },
          },
        },
        _sum: { amountCents: true },
      }),
    ]);

  // IVA por TARIFA y dirección (árbol 2408 abierto en auxiliares): el IVA
  // generado va al auxiliar de la tarifa — habilita armar el formulario
  // 300 directo del libro. INC (restaurantes) va a 241205.
  const salesTaxCodeFor = (kind: string, pct: number): string | null =>
    kind === "iva" ? ivaGeneradoCodeForPct(pct) : kind === "inc" ? ENGINE.INC_GENERADO : null;
  // Para las devoluciones (que no tienen factura que las congele) se usa el
  // régimen con el que quedó etiquetado el mes.
  const salesTaxCode = salesTaxCodeFor(tax.sales.kind, tax.sales.pct);

  const entries: DraftEntry[] = [];

  // 1) VENTAS — D caja/banco/pasarela (bruto) · C ingresos + impuesto + propinas.
  {
    const lines: Line[] = [];
    let totalCash = 0;
    // Consolidar por cuenta destino (varios métodos caen en la misma cuenta).
    const byAccount = new Map<string, number>();
    for (const m of grossPays) {
      const amt = m._sum.amountCents ?? 0;
      if (amt <= 0) continue;
      const code = cashAccountForMethod(m.method);
      byAccount.set(code, (byAccount.get(code) ?? 0) + amt);
      totalCash += amt;
    }
    for (const [code, amt] of byAccount) lines.push({ code, debit: amt });
    // El impuesto va por TRAMO: lo que cada factura congeló, agrupado por
    // tarifa (`computeTaxSummary`). Un mes en el que el comercio cambió de
    // tarifa lleva un crédito por código (241205 + el auxiliar de IVA);
    // un mes normal, uno solo. Nunca "tarifa de hoy × ventas del mes".
    const taxByCode = new Map<string, number>();
    for (const slice of tax.sales.byRate) {
      const code = salesTaxCodeFor(slice.kind, slice.pct);
      if (!code || slice.taxCents <= 0) continue;
      taxByCode.set(code, (taxByCode.get(code) ?? 0) + slice.taxCents);
    }
    const salesTax = [...taxByCode.values()].reduce((s, v) => s + v, 0);
    const tips = salesBook.totals.tipCents;
    const income = totalCash - salesTax - tips;
    if (totalCash > 0 && income >= 0) {
      if (income > 0) lines.push({ code: ENGINE.INGRESOS, credit: income });
      for (const [code, credit] of taxByCode) lines.push({ code, credit });
      if (tips > 0) lines.push({ code: ENGINE.PROPINAS_POR_PAGAR, credit: tips });
      entries.push({ source: "sale", memo: "Ventas del mes", lines });
    } else if (totalCash > 0) {
      // Cobros < impuesto + propinas de los pedidos: datos inconsistentes
      // (pagos parciales cruzando meses, etc.). No inventamos un asiento —
      // lo dejamos trazado para diagnóstico.
      console.error("[posting] ventas con ingreso negativo — asiento omitido", {
        restaurantId,
        totalCash,
        salesTax,
        tips,
      });
    }
  }

  // 1b) ABONOS DE CLIENTES — D cuenta de dinero de cada abono · C clientes.
  // La venta a crédito debitó Clientes (130505) en "1)"; acá se cancela
  // esa CxC cuando el cliente paga, agrupado por la cuenta (caja, banco,
  // pasarela) que eligió el operador al registrar el abono.
  {
    const pays = await db.customerCreditPayment.findMany({
      where: {
        restaurantId,
        paidAt: { gte: range.from, lt: range.to },
      },
      select: { amountCents: true, accountCode: true },
    });
    const byAccount = new Map<string, number>();
    for (const p of pays) {
      if (p.amountCents <= 0) continue;
      byAccount.set(p.accountCode, (byAccount.get(p.accountCode) ?? 0) + p.amountCents);
    }
    const total = [...byAccount.values()].reduce((s, v) => s + v, 0);
    if (total > 0) {
      const lines: Line[] = [];
      for (const [code, amount] of byAccount) lines.push({ code, debit: amount });
      lines.push({ code: ENGINE.CLIENTES, credit: total });
      entries.push({ source: "customer_credit_payment", memo: "Abonos de clientes", lines });
    }
  }

  // 2) COMPRAS — D inventario + IVA descontable · C proveedores − retenciones.
  {
    const t = purchasesBook.totals;
    const purchaseCost = t.receivedCents + t.incCents;
    const nonInventoryNetCost = t.nonInventoryReceivedCents + t.nonInventoryIncCents;
    const expenseDebit = nonInventoryNetCost + t.nonInventoryNonDeductibleTaxCents;
    const invDebit = purchaseCost - nonInventoryNetCost;
    const deductibleVat = t.ivaCents - t.nonInventoryNonDeductibleTaxCents;
    if (purchaseCost > 0 || t.ivaCents > 0) {
      const lines: Line[] = [];
      if (invDebit > 0) lines.push({ code: ENGINE.INVENTARIO, debit: invDebit });
      if (expenseDebit > 0) lines.push({ code: ENGINE.GASTOS_DIVERSOS, debit: expenseDebit });
      // IVA de compras al DESCONTABLE (240810), no al generado de ventas —
      // debitarlo a 240805 mezclaba las dos direcciones del impuesto.
      if (deductibleVat > 0)
        lines.push({ code: ENGINE.IVA_DESCONTABLE, debit: deductibleVat });
      if (t.retefuenteCents > 0)
        lines.push({ code: ENGINE.RETEFUENTE, credit: t.retefuenteCents });
      if (t.reteIvaCents > 0)
        lines.push({ code: ENGINE.RETEIVA, credit: t.reteIvaCents });
      if (t.reteIcaCents > 0)
        lines.push({ code: ENGINE.RETEICA, credit: t.reteIcaCents });
      const ret = t.retefuenteCents + t.reteIvaCents + t.reteIcaCents;
      const proveedores = purchaseCost + t.ivaCents - ret;
      if (proveedores >= 0) {
        lines.push({ code: ENGINE.PROVEEDORES, credit: proveedores });
        entries.push({ source: "purchase", memo: "Compras del mes", lines });
      } else {
        // Retenciones > compra: datos mal capturados. Un crédito negativo no
        // es un asiento válido — omitimos y dejamos rastro.
        console.error("[posting] compras con proveedores negativo — omitido", {
          restaurantId,
          invDebit,
          iva: t.ivaCents,
          ret,
        });
      }
    }
  }

  // 2b) PAGOS A PROVEEDORES — D proveedores (220505) · C de donde salió.
  // Hasta ahora los abonos de compras no se asentaban: la CxP que crea "2)"
  // nunca se cancelaba y proveedores crecía sin fin. Se agrupa por la cuenta
  // que eligió el operador en cada abono (caja, banco, pasarela); los abonos
  // anteriores al campo caen en caja/banco según el texto del método.
  {
    const pays = await db.purchasePayment.findMany({
      where: {
        restaurantId,
        paidAt: { gte: range.from, lt: range.to },
      },
      select: { amountCents: true, accountCode: true, method: true },
    });
    const byAccount = new Map<string, number>();
    for (const p of pays) {
      if (p.amountCents <= 0) continue;
      const code = resolvePurchasePaymentAccount(p);
      byAccount.set(code, (byAccount.get(code) ?? 0) + p.amountCents);
    }
    const total = [...byAccount.values()].reduce((s, v) => s + v, 0);
    if (total > 0) {
      const lines: Line[] = [{ code: ENGINE.PROVEEDORES, debit: total }];
      for (const [code, amount] of byAccount) lines.push({ code, credit: amount });
      entries.push({ source: "purchase_payment", memo: "Pagos a proveedores", lines });
    }
  }

  // 3) COSTO DE VENTAS — D costo · C inventario.
  if (pnl.consumptionCents > 0) {
    entries.push({
      source: "cogs",
      memo: "Costo de ventas del mes",
      lines: [
        { code: ENGINE.COSTO_VENTAS, debit: pnl.consumptionCents },
        { code: ENGINE.INVENTARIO, credit: pnl.consumptionCents },
      ],
    });
  }

  // 4) MERMAS — D gasto · C inventario.
  if (pnl.wasteCents > 0) {
    entries.push({
      source: "waste",
      memo: "Mermas del mes",
      lines: [
        { code: ENGINE.GASTOS_DIVERSOS, debit: pnl.wasteCents },
        { code: ENGINE.INVENTARIO, credit: pnl.wasteCents },
      ],
    });
  }

  // 5) GASTOS del mes — D la cuenta del gasto · C costos y gastos por pagar.
  //
  // Antes acreditaba bancos directo, o sea que daba por pagado TODO gasto en
  // el momento de registrarlo. Un gasto que se debe no puede sacar plata del
  // banco: nace como pasivo y se cancela con el asiento 5b cuando se paga.
  // La cuenta del débito sale del gasto si el operador la fijó; si no, de la
  // heurística por categoría de siempre.
  {
    const rows = await db.expense.findMany({
      where: {
        restaurantId,
        recurring: false, // las plantillas no son gasto (igual que el P&L)
        date: { gte: range.from, lt: range.to },
      },
      select: { amountCents: true, category: true, accountCode: true },
    });
    const byAccount = new Map<string, { amount: number; memo: string }>();
    for (const e of rows) {
      if (e.amountCents <= 0) continue;
      const code = e.accountCode ?? expenseAccountFor(e.category);
      const cur = byAccount.get(code);
      byAccount.set(code, {
        amount: (cur?.amount ?? 0) + e.amountCents,
        memo: cur?.memo ?? e.category,
      });
    }
    const total = [...byAccount.values()].reduce((s, v) => s + v.amount, 0);
    if (total > 0) {
      const lines: Line[] = [...byAccount].map(([code, v]) => ({
        code,
        debit: v.amount,
        memo: v.memo,
      }));
      lines.push({ code: EXPENSE_PAYABLE_CODE, credit: total });
      entries.push({ source: "expense", memo: "Gastos del mes", lines });
    }
  }

  // 5b) PAGOS DE GASTOS — D costos y gastos por pagar · C de donde salió.
  // Se agrupa por la cuenta que eligió el operador en cada abono, así el
  // crédito cae en la caja o el banco real y no en uno fijo.
  {
    const pays = await db.expensePayment.findMany({
      where: {
        restaurantId,
        paidAt: { gte: range.from, lt: range.to },
      },
      select: { amountCents: true, accountCode: true },
    });
    const byAccount = new Map<string, number>();
    for (const p of pays) {
      if (p.amountCents <= 0) continue;
      byAccount.set(p.accountCode, (byAccount.get(p.accountCode) ?? 0) + p.amountCents);
    }
    const total = [...byAccount.values()].reduce((s, v) => s + v, 0);
    if (total > 0) {
      const lines: Line[] = [{ code: EXPENSE_PAYABLE_CODE, debit: total }];
      for (const [code, amount] of byAccount) lines.push({ code, credit: amount });
      entries.push({ source: "expense_payment", memo: "Pagos de gastos", lines });
    }
  }

  // 6b) DEPRECIACIÓN — cuota mensual de los activos fijos, cada uno contra
  // SUS cuentas (Debe gasto 5xxx · Haber depreciación acumulada 15xx),
  // agregadas por cuenta. Antes era el par fijo 516005/159205 para todos;
  // ahora las cuentas viven en cada activo (defaults iguales). Línea recta,
  // arranca el mes siguiente a la compra — ver erp/activos.
  {
    const lines = await depreciationLinesForMonth(restaurantId, month);
    const total = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
    if (total > 0) {
      entries.push({ source: "depreciation", memo: "Depreciación del mes", lines });
    }
  }

  // 6c) DIFERIDOS — amortización del mes: gastos pagados por anticipado
  // (D gasto/costo · C puente 17xx) e ingresos recibidos por anticipado
  // (D puente 27xx · C ingreso), agregados por cuenta y centro de costos.
  // La cuota se calcula al vuelo por mes (ver erp/deferred): regenerar el
  // mes ya cubre huecos y bajas, sin filas por período ni cron.
  {
    const lines = await deferredAmortizationLinesForMonth(restaurantId, month);
    const total = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
    if (total > 0) {
      entries.push({
        source: "deferred",
        memo: "Amortización de diferidos del mes",
        lines,
      });
    }
  }

  // 6) NÓMINA — con corrida liquidada: asiento completo (devengados, aportes,
  // provisiones, retenciones y neto por pagar). Sin corrida: fallback simple
  // salario+recargos del P&L.
  {
    const run = await payrollTotalsForPosting(restaurantId, month);
    if (run) {
      const lines: Line[] = [
        { code: ENGINE.NOMINA_SALARIOS, debit: run.devengadoCents },
        {
          code: ENGINE.NOMINA_APORTES,
          debit:
            run.aportesCents +
            run.provCesantiasCents +
            run.provPrimaCents +
            run.provVacacionesCents,
        },
        {
          code: ENGINE.SALARIOS_POR_PAGAR,
          credit: run.devengadoCents - run.deduccionesCents,
        },
        {
          code: ENGINE.RETENCIONES_Y_APORTES_NOMINA,
          credit: run.deduccionesCents + run.aportesCents,
        },
      ];
      if (run.provCesantiasCents > 0)
        lines.push({ code: ENGINE.CESANTIAS, credit: run.provCesantiasCents });
      if (run.provPrimaCents > 0)
        lines.push({ code: ENGINE.PRIMA, credit: run.provPrimaCents });
      if (run.provVacacionesCents > 0)
        lines.push({ code: ENGINE.VACACIONES, credit: run.provVacacionesCents });
      entries.push({
        source: "payroll",
        memo: "Nómina del mes (liquidación)",
        lines: lines.filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0),
      });
    } else {
      const labor = pnl.labor?.totalCents ?? 0;
      if (labor > 0) {
        entries.push({
          source: "payroll",
          memo: "Nómina del mes",
          lines: [
            { code: ENGINE.NOMINA_SALARIOS, debit: labor },
            { code: ENGINE.SALARIOS_POR_PAGAR, credit: labor },
          ],
        });
      }
    }
  }

  // 7) DEVOLUCIONES — D devoluciones + impuesto · C pasarela.
  if (refunds > 0) {
    const rtax =
      tax.sales.kind === "none" ? 0 : embeddedTaxCents(refunds, tax.sales.pct);
    const lines: Line[] = [{ code: ENGINE.DEVOLUCIONES, debit: refunds - rtax }];
    if (rtax > 0 && salesTaxCode)
      lines.push({ code: salesTaxCode, debit: rtax });
    lines.push({ code: ENGINE.PASARELA, credit: refunds });
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
  const index = await loadAccountIndex(restaurantId);
  const drafts = await buildMonthEntries(restaurantId, month, range);
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
    // Cada código base se resuelve a su cuenta IMPUTABLE: si el contador
    // abrió auxiliares debajo (11100501 Bancolombia), el movimiento cae en
    // la auxiliar y la línea guarda ESE código. Sin dónde asentar (cuenta
    // faltante o madre sin hijas imputables) el asiento entero se omite.
    const lines: Array<Line & { accountId: string }> = [];
    let unresolved: string | null = null;
    for (const l of e.lines) {
      const code = resolvePostableCode(index, l.code);
      const account = code ? index.get(code) : undefined;
      if (!code || !account) {
        unresolved = l.code;
        break;
      }
      lines.push({ ...l, code, accountId: account.id });
    }
    if (unresolved) {
      console.error("[posting] cuenta no imputable", {
        source: e.source,
        month,
        code: unresolved,
      });
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
            create: lines.map((l) => ({
              accountId: l.accountId,
              accountCode: l.code,
              debitCents: l.debit ?? 0,
              creditCents: l.credit ?? 0,
              memo: l.memo,
              // Sólo cuando la fuente lo trae: las demás siguen creando
              // la línea exactamente igual que antes.
              ...(l.costCenterId ? { costCenterId: l.costCenterId } : {}),
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
  voucherNumber: number | null;
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
  const range = monthRange(month);
  const [entries, accounts] = await Promise.all([
    db.journalEntry.findMany({
      // Por FECHA (no por sourceRef): así el diario incluye también los
      // asientos de conciliación bancaria (sourceRef = línea) y el cierre
      // del ejercicio (sourceRef = año) fechados dentro del mes.
      where: range
        ? { restaurantId, date: { gte: range.from, lt: range.to } }
        : { restaurantId, sourceRef: month },
      orderBy: [{ date: "asc" }, { source: "asc" }, { createdAt: "asc" }],
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
    voucherNumber: e.voucherNumber,
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
