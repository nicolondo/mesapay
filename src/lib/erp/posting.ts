// Motor de asientos (Fase 2). Genera comprobantes de doble partida a partir
// de la operación. Dos ritmos:
//
//  · Fuentes TRANSACCIONALES (ventas, abonos de clientes, compras, pagos a
//    proveedores, costo de ventas, mermas, gastos, pagos de gastos,
//    devoluciones, notas crédito): un asiento-resumen por fuente y por DÍA
//    DE NEGOCIO del comercio (Bogotá con `Restaurant.businessDayCutoffHour`,
//    el mismo criterio del cierre de día), fechado a la medianoche de Bogotá
//    de ese día (`YYYY-MM-DDT05:00:00.000Z`, ver businessDays.ts). Así el
//    libro refleja los movimientos el día en que ocurren y un estado de
//    resultado semanal corta bien.
//  · Fuentes MENSUALES (nómina, depreciación, diferidos): un asiento al mes,
//    fechado el último instante UTC del mes, como siempre.
//
// Todos llevan `sourceRef = "YYYY-MM"`: regenerar un mes borra los asientos
// del motor de esa fuente y ese mes y crea los N del día en la misma
// transacción (idempotente), sin tocar manuales, numerados ni anulados.
// Los hechos del mes se cargan UNA vez y se agrupan en memoria por día.
//
// Los códigos base viven en engineCodes.ts (ENGINE). Antes de asentar, cada
// uno se resuelve a su cuenta IMPUTABLE (chart.ts resolvePostableCode): si
// el contador abrió auxiliares debajo, el movimiento cae en la auxiliar.
// El mapeo lo debe validar el contador.
import { db } from "@/lib/db";
import { embeddedTaxCents, monthRange } from "./accounting";
import {
  type MonthRange,
  type SalesPostingOrder,
  computeMonthLabor,
  loadPurchasesBook,
  loadSalesPostingOrders,
} from "./accountingData";
import { ensureChartOfAccounts, loadAccountIndex } from "./ledger";
import { depreciationLinesForMonth } from "./activos";
import { deferredAmortizationLinesForMonth } from "./deferred";
import { businessDaysOfMonth, calendarDayOf, dailyEntryDate } from "./businessDays";
import { resolvePostableCode } from "./chart";
import { ENGINE, ENGINE_SOURCES } from "./engineCodes";
import { lineCentsToNumbers } from "./ledgerCents";
import { ivaGeneradoCodeForPct } from "./pucNiif";
import { loadCreditNoteMonthPosting, loadRefundMonthPosting } from "./creditNoteAccounting";
import { NO_TIP_POSTING, sumSlices } from "./creditNoteLedger";
import { payrollTotalsForPosting } from "./payrollData";
import { resolvePurchasePaymentAccount } from "./paymentAccounts";
import { type PurchaseBookRowAmounts, sumPurchaseBookRows } from "./purchaseTax";
import {
  type SalesTaxOrder,
  currentSalesTaxOf,
  freeLineTaxSlicesFor,
  salesTaxByRate,
  salesTaxLabel,
  salesTaxSlicesFor,
} from "./salesTaxSlices";
import { isCashMethod } from "@/lib/payments/methods";
import { bogotaBusinessDateIso } from "@/lib/bogota";

type Line = {
  code: string;
  debit?: number;
  credit?: number;
  memo?: string;
  /** Centro de costos de la línea (hoy sólo lo traen los diferidos). */
  costCenterId?: string | null;
};
type DraftEntry = {
  source: string;
  memo: string;
  /** Fecha del asiento (medianoche de Bogotá del día, o fin de mes UTC). */
  date: Date;
  /** Día de negocio ("YYYY-MM-DD") en los diarios; para el log. */
  day?: string;
  lines: Line[];
  /**
   * Sólo los asientos «Notas crédito»: notas que incluye. Al persistirlo
   * quedan marcadas con `postedMonth` (en la misma transacción).
   */
  creditNoteIds?: string[];
  /** Ídem, notas cuya propina devuelta incluye: se marcan con `tipPostedMonth`. */
  creditNoteTipIds?: string[];
};

/** Total asentado por fuente en el mes (Σ de sus asientos del día). */
export type GenResult = { source: string; totalCents: number };

/** Método de pago → cuenta de caja/banco/pasarela (débito de la venta). */
function cashAccountForMethod(method: string): string {
  if (isCashMethod(method)) return ENGINE.CAJA; // Caja (cash o el histórico demo_cash)
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

/** Cuenta de una retención de gasto sin cuenta guardada: la del motor por tipo (como las compras). */
const EXPENSE_RETENTION_FALLBACK: Record<string, string> = {
  retefuente: ENGINE.RETEFUENTE,
  reteiva: ENGINE.RETEIVA,
  reteica: ENGINE.RETEICA,
};

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

/**
 * ¿Se asienta la nómina ESTIMADA (salarios de hoy) de `month`? Sólo en el
 * mes en curso o uno futuro (hora de Colombia). Un mes que ya terminó no se
 * estima con la planta de hoy: la corrida diaria lo regeneraría con gente
 * que no trabajaba ese mes, o sin la que ya se fue. Su nómina entra al
 * liquidar la corrida de ese mes.
 */
export function payrollEstimateApplies(month: string, now: Date): boolean {
  return month >= bogotaBusinessDateIso(now).slice(0, 7);
}

/** Agrupa filas por una clave de día, con los días en orden. */
function groupByDay<T>(rows: readonly T[], dayOf: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const day = dayOf(row);
    const list = out.get(day);
    if (list) list.push(row);
    else out.set(day, [row]);
  }
  return new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** Suma por clave (cuenta) ignorando montos no positivos. */
function sumByKey<T>(rows: readonly T[], key: (r: T) => string, amount: (r: T) => number): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const amt = amount(r);
    if (amt <= 0) continue;
    const k = key(r);
    out.set(k, (out.get(k) ?? 0) + amt);
  }
  return out;
}

const sumValues = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + v, 0);

/**
 * Arma (sin persistir) los asientos del mes: los diarios de las fuentes
 * transaccionales y los mensuales. Cada uno cuadra por construcción: la
 * cuenta "plug" (ingreso 4135 en ventas, proveedores 2205 en compras)
 * absorbe la diferencia. `range` es el mes UTC (`monthRange`): lo usan las
 * fuentes que viven en un DATE o son mensuales; los hechos con timestamp se
 * cargan con el mes de NEGOCIO (días de negocio 1..último).
 */
async function buildMonthEntries(
  restaurantId: string,
  month: string,
  range: MonthRange,
  now: Date,
): Promise<DraftEntry[]> {
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { businessDayCutoffHour: true, salesTaxKind: true, salesTaxPct: true },
  });
  const cutoff = tenant?.businessDayCutoffHour ?? 0;
  const days = businessDaysOfMonth(month, cutoff);
  if (days.length === 0) return [];
  const biz: MonthRange = { from: days[0]!.from, to: days[days.length - 1]!.to };
  const lastDay = days[days.length - 1]!.day;
  /** Día de negocio de un instante (cobros, recepciones, movimientos…). */
  const dayOf = (at: Date) => bogotaBusinessDateIso(at, cutoff);
  /** Fecha de un asiento diario. */
  const dateOf = (day: string) => dailyEntryDate(day);
  /** Fecha de los asientos mensuales = último instante del mes. */
  const monthEnd = new Date(range.to.getTime() - 1);

  // Primero las notas crédito: además de leerlas, fija las aceptadas que
  // quedaron sin fijar, y el cruce de los reembolsos de abajo las necesita.
  const creditNotes = await loadCreditNoteMonthPosting(restaurantId, month);
  const tsRange = { gte: biz.from, lt: biz.to };
  const [orders, purchasesBook, labor, refunds, creditPays, purchasePays, stock, expenses, expensePays] =
    await Promise.all([
      loadSalesPostingOrders(restaurantId, biz),
      loadPurchasesBook(restaurantId, biz),
      // Nómina estimada: salario del mes + recargos de turnos (DATE) → mes calendario.
      computeMonthLabor(restaurantId, range),
      loadRefundMonthPosting(restaurantId, biz),
      db.customerCreditPayment.findMany({
        where: { restaurantId, paidAt: tsRange },
        select: { amountCents: true, accountCode: true, paidAt: true },
      }),
      db.purchasePayment.findMany({
        where: { restaurantId, paidAt: tsRange },
        select: { amountCents: true, accountCode: true, method: true, paidAt: true },
      }),
      // sale_consumption/waste = CMV y mermas reales (ledger A4), una fila por
      // movimiento: se agrupan por día en memoria.
      db.stockMovement.findMany({
        where: {
          restaurantId,
          kind: { in: ["sale_consumption", "waste"] },
          createdAt: tsRange,
        },
        select: { kind: true, valueCents: true, createdAt: true },
      }),
      // Gastos: `Expense.date` es una FECHA contable (la elige el operador),
      // así que va por día calendario y mes calendario, no de negocio.
      db.expense.findMany({
        where: {
          restaurantId,
          recurring: false, // las plantillas no son gasto (igual que el P&L)
          date: { gte: range.from, lt: range.to },
        },
        select: {
          amountCents: true,
          ivaCents: true,
          ivaDeductible: true,
          category: true,
          accountCode: true,
          costCenterId: true,
          date: true,
          retentions: { select: { kind: true, accountCode: true, amountCents: true } },
        },
      }),
      db.expensePayment.findMany({
        where: { restaurantId, paidAt: tsRange },
        select: { amountCents: true, accountCode: true, paidAt: true },
      }),
    ]);

  // IVA por TARIFA y dirección (árbol 2408 abierto en auxiliares): el IVA
  // generado va al auxiliar de la tarifa — habilita armar el formulario
  // 300 directo del libro. INC (restaurantes) va a 241205.
  const salesTaxCodeFor = (kind: string, pct: number): string | null =>
    kind === "iva" ? ivaGeneradoCodeForPct(pct) : kind === "inc" ? ENGINE.INC_GENERADO : null;
  const current = currentSalesTaxOf(tenant);
  const toTaxOrder = (o: SalesPostingOrder): SalesTaxOrder => ({
    subtotalCents: o.subtotalCents,
    invoiceSnapshot: o.invoiceSnapshot,
    freeLines: o.freeLines,
  });
  // Sólo los pedidos en estado pagado causan impuesto (misma regla que la
  // tarjeta de impuestos); los cobros y propinas cuentan por `paidAt`.
  const taxable = (list: readonly SalesPostingOrder[]) =>
    list.filter((o) => o.status === "paid").map(toTaxOrder);
  // Régimen del MES (el tramo que más causó): las devoluciones sin nota no
  // tienen factura que las congele y se estiman con él.
  const monthLabel = salesTaxLabel(salesTaxByRate(salesTaxSlicesFor(taxable(orders), current)), current);
  const refundTaxCode = salesTaxCodeFor(monthLabel.kind, monthLabel.pct);

  const entries: DraftEntry[] = [];

  // 1) VENTAS — por día de negocio del pago del pedido. D caja/banco/pasarela
  // (bruto) · C ingresos + impuesto + propinas. El impuesto es el EMBEBIDO
  // de la carta más el que las LÍNEAS LIBRES suman encima (servicios,
  // cargos sueltos con IVA/INC propio): la base de la línea libre queda en
  // ingresos y su impuesto va al generado de su tipo y tarifa, igual que lo
  // declaró la factura. Antes ese impuesto caía en 4135 (el ingreso es la
  // cuenta que cuadra el asiento).
  for (const [day, dayOrders] of groupByDay(orders, (o) => dayOf(o.paidAt))) {
    const lines: Line[] = [];
    // Consolidar por cuenta destino (varios métodos caen en la misma cuenta).
    const byAccount = sumByKey(
      dayOrders.flatMap((o) => o.payments),
      (p) => cashAccountForMethod(p.method),
      (p) => p.amountCents,
    );
    const totalCash = sumValues(byAccount);
    for (const [code, amt] of byAccount) lines.push({ code, debit: amt });
    // El impuesto va por TRAMO: lo que cada factura congeló, agrupado por
    // tarifa (`salesTaxSlices`). Un día en el que el comercio cambió de
    // tarifa lleva un crédito por código (241205 + el auxiliar de IVA);
    // un día normal, uno solo. Nunca "tarifa de hoy × ventas del día".
    const taxByCode = new Map<string, number>();
    const dayTaxable = taxable(dayOrders);
    for (const slice of [
      ...salesTaxByRate(salesTaxSlicesFor(dayTaxable, current)),
      ...salesTaxByRate(freeLineTaxSlicesFor(dayTaxable)),
    ]) {
      const code = salesTaxCodeFor(slice.kind, slice.pct);
      if (!code || slice.taxCents <= 0) continue;
      taxByCode.set(code, (taxByCode.get(code) ?? 0) + slice.taxCents);
    }
    const salesTax = sumValues(taxByCode);
    const tips = dayOrders.reduce((s, o) => s + o.tipCents, 0);
    const income = totalCash - salesTax - tips;
    if (totalCash > 0 && income >= 0) {
      if (income > 0) lines.push({ code: ENGINE.INGRESOS, credit: income });
      for (const [code, credit] of taxByCode) lines.push({ code, credit });
      if (tips > 0) lines.push({ code: ENGINE.PROPINAS_POR_PAGAR, credit: tips });
      entries.push({ source: "sale", memo: "Ventas del día", date: dateOf(day), day, lines });
    } else if (totalCash > 0) {
      // Cobros < impuesto + propinas de los pedidos del día: datos
      // inconsistentes. No inventamos un asiento — se omite SÓLO ese día y
      // queda trazado para diagnóstico.
      console.error("[posting] ventas con ingreso negativo — día omitido", {
        restaurantId,
        day,
        totalCash,
        salesTax,
        tips,
      });
    }
  }

  // 1b) ABONOS DE CLIENTES — por día del abono. D cuenta de dinero de cada
  // abono · C clientes. La venta a crédito debitó Clientes (130505) en "1)";
  // acá se cancela esa CxC cuando el cliente paga, agrupado por la cuenta
  // (caja, banco, pasarela) que eligió el operador al registrar el abono.
  for (const [day, pays] of groupByDay(creditPays, (p) => dayOf(p.paidAt))) {
    const byAccount = sumByKey(pays, (p) => p.accountCode, (p) => p.amountCents);
    const total = sumValues(byAccount);
    if (total <= 0) continue;
    const lines: Line[] = [];
    for (const [code, amount] of byAccount) lines.push({ code, debit: amount });
    lines.push({ code: ENGINE.CLIENTES, credit: total });
    entries.push({ source: "customer_credit_payment", memo: "Abonos de clientes", date: dateOf(day), day, lines });
  }

  // 2) COMPRAS — por día de negocio de la recepción. D inventario + IVA
  // descontable · C proveedores − retenciones. La misma suma del libro de
  // compras, sobre las facturas de cada día.
  //
  // Compra recibida con IVA NO descontable (`purchaseIvaDeductible = false`
  // al recibir): ese IVA es mayor valor del costo, no un crédito fiscal. El
  // de las líneas inventariables va a 143505 —el kardex ya valoró esa
  // mercancía al bruto y el costo de ventas lo saca de ahí: el inventario
  // del libro queda igual al del kardex— y el de las no inventariables al
  // gasto; nada a 2408. Antes el de las inventariables se debitaba a
  // 24081001 aunque el inventario ya lo incluía: contado dos veces. Lo que
  // se capitalizó lo dice el kardex (`capitalizedInventoryVatByLine`), no el
  // ajuste de hoy; una compra recibida con IVA descontable tiene
  // `inventoryNonDeductibleTaxCents` 0 y su asiento es el de siempre.
  const purchaseRows = purchasesBook.rows.filter(
    (r): r is typeof r & { receivedAt: Date } => r.receivedAt != null,
  );
  for (const [day, rows] of groupByDay(purchaseRows, (r) => dayOf(r.receivedAt))) {
    const t = sumPurchaseBookRows(rows as PurchaseBookRowAmounts[]);
    const purchaseCost = t.receivedCents + t.incCents;
    const nonInventoryNetCost = t.nonInventoryReceivedCents + t.nonInventoryIncCents;
    const expenseDebit = nonInventoryNetCost + t.nonInventoryNonDeductibleTaxCents;
    // Nunca más que el IVA que queda después del del gasto: así el asiento
    // cuadra aunque una línea traiga datos raros.
    const inventoryVat = Math.min(
      t.inventoryNonDeductibleTaxCents,
      Math.max(0, t.ivaCents - t.nonInventoryNonDeductibleTaxCents),
    );
    const invDebit = purchaseCost - nonInventoryNetCost + inventoryVat;
    const deductibleVat = t.ivaCents - t.nonInventoryNonDeductibleTaxCents - inventoryVat;
    if (purchaseCost <= 0 && t.ivaCents <= 0) continue;
    const lines: Line[] = [];
    // Ajuste al peso de las facturas (con signo): el proveedor se acredita por
    // el Total impreso y la diferencia de redondeo va a gastos diversos —
    // débito si se paga de más, crédito si se paga de menos—. No toca el
    // inventario: el libro sigue igual al kardex.
    const diversos = expenseDebit + t.roundingCents;
    if (invDebit > 0) lines.push({ code: ENGINE.INVENTARIO, debit: invDebit });
    if (diversos > 0) lines.push({ code: ENGINE.GASTOS_DIVERSOS, debit: diversos });
    else if (diversos < 0) lines.push({ code: ENGINE.GASTOS_DIVERSOS, credit: -diversos });
    // IVA de compras al DESCONTABLE (240810), no al generado de ventas —
    // debitarlo a 240805 mezclaba las dos direcciones del impuesto.
    if (deductibleVat > 0) lines.push({ code: ENGINE.IVA_DESCONTABLE, debit: deductibleVat });
    if (t.retefuenteCents > 0) lines.push({ code: ENGINE.RETEFUENTE, credit: t.retefuenteCents });
    if (t.reteIvaCents > 0) lines.push({ code: ENGINE.RETEIVA, credit: t.reteIvaCents });
    if (t.reteIcaCents > 0) lines.push({ code: ENGINE.RETEICA, credit: t.reteIcaCents });
    const ret = t.retefuenteCents + t.reteIvaCents + t.reteIcaCents;
    const proveedores = purchaseCost + t.ivaCents - ret + t.roundingCents;
    if (proveedores >= 0) {
      lines.push({ code: ENGINE.PROVEEDORES, credit: proveedores });
      entries.push({ source: "purchase", memo: "Compras del día", date: dateOf(day), day, lines });
    } else {
      // Retenciones > compra: datos mal capturados. Un crédito negativo no
      // es un asiento válido — omitimos SÓLO ese día y dejamos rastro.
      console.error("[posting] compras con proveedores negativo — día omitido", {
        restaurantId,
        day,
        invDebit,
        iva: t.ivaCents,
        ret,
      });
    }
  }

  // 2b) PAGOS A PROVEEDORES — por día del abono. D proveedores (220505) · C
  // de donde salió. La CxP que crea "2)" se cancela acá, agrupado por la
  // cuenta que eligió el operador en cada abono (caja, banco, pasarela); los
  // abonos anteriores al campo caen en caja/banco según el texto del método.
  for (const [day, pays] of groupByDay(purchasePays, (p) => dayOf(p.paidAt))) {
    const byAccount = sumByKey(pays, (p) => resolvePurchasePaymentAccount(p), (p) => p.amountCents);
    const total = sumValues(byAccount);
    if (total <= 0) continue;
    const lines: Line[] = [{ code: ENGINE.PROVEEDORES, debit: total }];
    for (const [code, amount] of byAccount) lines.push({ code, credit: amount });
    entries.push({ source: "purchase_payment", memo: "Pagos a proveedores", date: dateOf(day), day, lines });
  }

  // 3) COSTO DE VENTAS y 4) MERMAS — por día de negocio del movimiento de
  // inventario. Las salidas tienen `valueCents` negativo: el neto del día
  // (−Σ) va D costo/gasto · C inventario. Un día cuyo neto sea positivo
  // (más reversas que salidas) se asienta al revés, D inventario · C
  // costo/gasto, para que Σ días == mes también en ese caso.
  for (const [day, moves] of groupByDay(stock, (m) => dayOf(m.createdAt))) {
    const net = (kind: string) => -moves.filter((m) => m.kind === kind).reduce((s, m) => s + m.valueCents, 0);
    const pair = (debit: string, credit: string, cents: number): Line[] =>
      cents >= 0
        ? [{ code: debit, debit: cents }, { code: credit, credit: cents }]
        : [{ code: credit, debit: -cents }, { code: debit, credit: -cents }];
    const consumption = net("sale_consumption");
    if (consumption !== 0) {
      entries.push({
        source: "cogs",
        memo: "Costo de ventas del día",
        date: dateOf(day),
        day,
        lines: pair(ENGINE.COSTO_VENTAS, ENGINE.INVENTARIO, consumption),
      });
    }
    const waste = net("waste");
    if (waste !== 0) {
      entries.push({
        source: "waste",
        memo: "Mermas del día",
        date: dateOf(day),
        day,
        lines: pair(ENGINE.GASTOS_DIVERSOS, ENGINE.INVENTARIO, waste),
      });
    }
  }

  // 5) GASTOS — por día calendario de `Expense.date`. D la cuenta del gasto
  // (el COSTO: base + INC + IVA no descontable) + IVA descontable (240810,
  // la misma cuenta de las compras, sólo si el gasto lo descuenta) · C cada
  // retención a la cuenta de su concepto (2365/2367/2368) · C costos y
  // gastos por pagar por el TOTAL A PAGAR (base + IVA + INC − retenciones).
  //
  // Un gasto que se debe no puede sacar plata del banco: nace como pasivo y
  // se cancela con el asiento 5b cuando se paga (el «pagado de contado» es
  // un abono por el total a pagar en la misma fecha). La cuenta del débito
  // sale del gasto si el operador la fijó; si no, de la heurística por
  // categoría. Un gasto sin impuestos queda exactamente como antes.
  for (const [day, rows] of groupByDay(expenses, (e) => calendarDayOf(e.date))) {
    // Por cuenta Y centro de costos: agrupar sólo por cuenta perdía el
    // centro y el presupuesto por centro no veía los gastos.
    const byAccount = new Map<string, { code: string; costCenterId: string | null; amount: number; memo: string }>();
    for (const e of rows) {
      if (e.amountCents <= 0) continue;
      const code = e.accountCode ?? expenseAccountFor(e.category);
      const key = `${code}|${e.costCenterId ?? ""}`;
      const cur = byAccount.get(key);
      byAccount.set(key, {
        code,
        costCenterId: e.costCenterId ?? null,
        amount: (cur?.amount ?? 0) + e.amountCents,
        memo: cur?.memo ?? e.category,
      });
    }
    const costTotal = [...byAccount.values()].reduce((s, v) => s + v.amount, 0);
    if (costTotal <= 0) continue;
    const valid = rows.filter((e) => e.amountCents > 0);
    const deductibleVat = valid.reduce((s, e) => s + (e.ivaDeductible ? Math.max(0, e.ivaCents ?? 0) : 0), 0);
    const retentionByCode = sumByKey(
      valid.flatMap((e) => e.retentions ?? []),
      (r) => r.accountCode || EXPENSE_RETENTION_FALLBACK[r.kind] || ENGINE.RETEFUENTE,
      (r) => r.amountCents,
    );
    const retentions = sumValues(retentionByCode);
    // Cuentas por pagar = débitos − retenciones (cuadra por construcción;
    // coincide con Σ payableCents de los gastos del día).
    const payable = costTotal + deductibleVat - retentions;
    if (payable < 0) {
      console.error("[posting] gastos con por-pagar negativo — día omitido", {
        restaurantId,
        day,
        costTotal,
        deductibleVat,
        retentions,
      });
      continue;
    }
    const lines: Line[] = [...byAccount.values()].map((v) => ({
      code: v.code,
      debit: v.amount,
      memo: v.memo,
      costCenterId: v.costCenterId,
    }));
    if (deductibleVat > 0) lines.push({ code: ENGINE.IVA_DESCONTABLE, debit: deductibleVat });
    for (const [code, amount] of retentionByCode) lines.push({ code, credit: amount });
    if (payable > 0) lines.push({ code: EXPENSE_PAYABLE_CODE, credit: payable });
    entries.push({ source: "expense", memo: "Gastos del día", date: dateOf(day), day, lines });
  }

  // 5b) PAGOS DE GASTOS — por día del pago. D costos y gastos por pagar · C
  // de donde salió, agrupado por la cuenta que eligió el operador en cada
  // abono, así el crédito cae en la caja o el banco real y no en uno fijo.
  for (const [day, pays] of groupByDay(expensePays, (p) => dayOf(p.paidAt))) {
    const byAccount = sumByKey(pays, (p) => p.accountCode, (p) => p.amountCents);
    const total = sumValues(byAccount);
    if (total <= 0) continue;
    const lines: Line[] = [{ code: EXPENSE_PAYABLE_CODE, debit: total }];
    for (const [code, amount] of byAccount) lines.push({ code, credit: amount });
    entries.push({ source: "expense_payment", memo: "Pagos de gastos", date: dateOf(day), day, lines });
  }

  // 6b) DEPRECIACIÓN (mensual) — cuota del mes de los activos fijos, cada
  // uno contra SUS cuentas (Debe gasto 5xxx · Haber depreciación acumulada
  // 15xx), agregadas por cuenta. Línea recta, arranca el mes siguiente a la
  // compra — ver erp/activos.
  {
    const lines = await depreciationLinesForMonth(restaurantId, month);
    const total = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
    if (total > 0) {
      entries.push({ source: "depreciation", memo: "Depreciación del mes", date: monthEnd, lines });
    }
  }

  // 6c) DIFERIDOS (mensual) — amortización del mes: gastos pagados por
  // anticipado (D gasto/costo · C puente 17xx) e ingresos recibidos por
  // anticipado (D puente 27xx · C ingreso), agregados por cuenta y centro
  // de costos. La cuota se calcula al vuelo por mes (ver erp/deferred):
  // regenerar el mes ya cubre huecos y bajas, sin filas por período ni cron.
  {
    const lines = await deferredAmortizationLinesForMonth(restaurantId, month);
    const total = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
    if (total > 0) {
      entries.push({
        source: "deferred",
        memo: "Amortización de diferidos del mes",
        date: monthEnd,
        lines,
      });
    }
  }

  // 6) NÓMINA (mensual) — con corrida liquidada: asiento completo
  // (devengados, aportes, provisiones, retenciones y neto por pagar). Sin
  // corrida: fallback simple salario+recargos del costo laboral del mes.
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
        date: monthEnd,
        lines: lines.filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0),
      });
    } else {
      // Sin corrida: estimado con los salarios de hoy, sólo en el mes en
      // curso (ver `payrollEstimateApplies`).
      const laborCents = labor?.totalCents ?? 0;
      if (laborCents > 0 && payrollEstimateApplies(month, now)) {
        entries.push({
          source: "payroll",
          memo: "Nómina del mes",
          date: monthEnd,
          lines: [
            { code: ENGINE.NOMINA_SALARIOS, debit: laborCents },
            { code: ENGINE.SALARIOS_POR_PAGAR, credit: laborCents },
          ],
        });
      }
    }
  }

  // 7) DEVOLUCIONES — por día de negocio del reembolso. D devoluciones +
  // impuesto · C pasarela. Un reembolso POSTERIOR a una nota crédito del
  // mismo pedido no es una devolución nueva: la nota ya debitó devoluciones
  // e impuesto y dejó el pasivo «reintegros por pagar». Esa parte (hasta lo
  // que la nota dejó pendiente, ya cruzada reembolso por reembolso) cancela
  // el pasivo; sólo el resto se estima como antes, con el impuesto embebido
  // del régimen del mes.
  for (const [day, dayRefunds] of groupByDay(refunds.refunds, (r) => dayOf(r.createdAt))) {
    const total = dayRefunds.reduce((s, r) => s + r.amountCents, 0);
    if (total <= 0) continue;
    const liability = dayRefunds.reduce((s, r) => s + r.liabilityCents, 0);
    const withNote = Math.min(Math.max(0, liability), total);
    const withoutNote = total - withNote;
    const rtax = monthLabel.kind === "none" ? 0 : embeddedTaxCents(withoutNote, monthLabel.pct);
    const lines: Line[] = [];
    if (withoutNote > 0) lines.push({ code: ENGINE.DEVOLUCIONES, debit: withoutNote - rtax });
    if (rtax > 0 && refundTaxCode) lines.push({ code: refundTaxCode, debit: rtax });
    if (withNote > 0) lines.push({ code: ENGINE.DEVOLUCIONES_POR_PAGAR, debit: withNote });
    lines.push({ code: ENGINE.PASARELA, credit: total });
    entries.push({
      source: "refund",
      memo: "Devoluciones del día",
      date: dateOf(day),
      day,
      lines: lines.filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0),
    });
  }

  // 8) NOTAS CRÉDITO — por día FISCAL de cada nota (día colombiano de
  // emisión). D devoluciones en ventas (base) + IVA/INC generado por tarifa
  // (lo que declaró cada nota, no la tarifa de hoy) · C Clientes por lo que
  // canceló cartera de crédito y C «reintegros por pagar» por lo que el
  // comercio le debe devolver al cliente. Lo que ya cubrió un reembolso
  // ANTERIOR a la nota no se repite (ver creditNoteLedger). Una nota
  // contabilizada en un mes distinto al de su fecha fiscal (su mes estaba
  // cerrado → primer mes abierto, o quedó fijada con `postedMonth`) va al
  // último día del mes.
  //
  // PROPINA DEVUELTA con la anulación (no es venta ni tiene impuesto): D
  // propinas por pagar (238030) · C Clientes por lo que canceló cartera · C
  // reintegros por pagar por lo que se le debe al cliente. Si un reembolso
  // ANTERIOR a la nota ya devolvió la propina, ese reembolso la asentó como
  // devolución estimada (con impuesto embebido del régimen): esa parte se
  // reclasifica con C devoluciones + impuesto estimado, en vez de crear un
  // pasivo que ya se pagó. Cada cuenta va neteada en una sola línea.
  const noteDay = (fiscalDate: string) => (fiscalDate.slice(0, 7) === month ? fiscalDate : lastDay);
  for (const [day, notes] of groupByDay(creditNotes.notes, (n) => noteDay(n.fiscalDate))) {
    const slices = sumSlices(notes.map((n) => n.slices));
    // Neto por cuenta: positivo = débito, negativo = crédito.
    const net = new Map<string, number>();
    const add = (code: string, cents: number) => {
      if (cents !== 0) net.set(code, (net.get(code) ?? 0) + cents);
    };
    add(ENGINE.DEVOLUCIONES, slices.reduce((s, x) => s + x.baseCents, 0));
    for (const slice of slices) {
      const code = salesTaxCodeFor(slice.kind, slice.pct);
      if (!code || slice.taxCents <= 0) continue;
      add(code, slice.taxCents);
    }
    const tipOf = (n: (typeof notes)[number]) => n.tip ?? NO_TIP_POSTING;
    add(ENGINE.PROPINAS_POR_PAGAR, notes.reduce((s, n) => s + tipOf(n).refundCents, 0));
    add(ENGINE.CLIENTES, -notes.reduce((s, n) => s + n.receivableCents + tipOf(n).receivableCents, 0));
    add(ENGINE.DEVOLUCIONES_POR_PAGAR, -notes.reduce((s, n) => s + n.liabilityCents + tipOf(n).liabilityCents, 0));
    const tipCovered = notes.reduce((s, n) => s + tipOf(n).coveredByPriorRefundsCents, 0);
    if (tipCovered > 0) {
      // Mismo estimado que el asiento «Devoluciones» de un reembolso sin nota.
      const tipTax = monthLabel.kind === "none" || !refundTaxCode ? 0 : embeddedTaxCents(tipCovered, monthLabel.pct);
      add(ENGINE.DEVOLUCIONES, -(tipCovered - tipTax));
      if (tipTax > 0 && refundTaxCode) add(refundTaxCode, -tipTax);
    }
    const lines: Line[] = [];
    for (const [code, cents] of net) {
      if (cents > 0) lines.push({ code, debit: cents });
      else if (cents < 0) lines.push({ code, credit: -cents });
    }
    // Con líneas vacías (notas que ya cubrieron por completo reembolsos
    // anteriores) no se asienta nada, pero las notas quedan contabilizadas.
    entries.push({
      source: "credit_note",
      memo: "Notas crédito del día",
      date: dateOf(day),
      day,
      lines,
      creditNoteIds: notes.filter((n) => n.postsFiscal !== false).map((n) => n.id),
      creditNoteTipIds: notes.filter((n) => n.postsTip).map((n) => n.id),
    });
  }

  return entries;
}

/**
 * Genera (o refresca) los asientos del motor del mes `month` (YYYY-MM).
 * Por fuente: borra los existentes de ese mes (`source, sourceRef = mes`) y
 * crea los nuevos —uno por día de negocio en las fuentes transaccionales,
 * uno al mes en las mensuales— en la misma transacción. Sólo persiste los
 * que cuadran; un día que no cuadra se omite solo (los demás se asientan).
 *
 * `range` es el mes UTC (`monthRange`), como siempre: con él se fechan los
 * asientos mensuales y se cortan los campos FECHA; los días de negocio se
 * construyen acá a partir del mes y la hora de corte del comercio.
 *
 * Una fuente del motor que este mes ya no produce asiento (se anuló el único
 * gasto, se dieron de baja todos los activos…) pierde los asientos viejos:
 * antes quedaban huérfanos. Nunca toca comprobantes manuales (no son fuentes
 * del motor) ni numerados o anulados.
 */
export async function generateJournalForMonth(
  restaurantId: string,
  month: string,
  range: MonthRange,
  opts: { now?: Date } = {},
): Promise<GenResult[]> {
  await ensureChartOfAccounts(restaurantId);
  const index = await loadAccountIndex(restaurantId);
  const drafts = await buildMonthEntries(restaurantId, month, range, opts.now ?? new Date());
  const produced = new Set(drafts.map((d) => d.source));
  const orphans = ENGINE_SOURCES.filter((source) => !produced.has(source));
  if (orphans.length > 0) {
    await db.$transaction(async (tx) => {
      await tx.journalEntry.deleteMany({
        where: {
          restaurantId,
          sourceRef: month,
          source: { in: orphans },
          voucherNumber: null,
          annulledAt: null,
        },
      });
    });
  }

  // Por fuente, en el orden en que el motor las arma.
  const bySource = new Map<string, DraftEntry[]>();
  for (const d of drafts) {
    const list = bySource.get(d.source);
    if (list) list.push(d);
    else bySource.set(d.source, [d]);
  }

  type Persisted = { draft: DraftEntry; lines: Array<Line & { accountId: string }>; debit: number };
  const results: GenResult[] = [];
  for (const [source, sourceDrafts] of bySource) {
    const valid: Persisted[] = [];
    // Notas de asientos sin monto (ya cubiertas por reembolsos anteriores):
    // no hay nada que asentar, pero quedan contabilizadas en este mes.
    const emptyNoteIds: string[] = [];
    const emptyTipIds: string[] = [];
    for (const e of sourceDrafts) {
      const debit = e.lines.reduce((s, l) => s + (l.debit ?? 0), 0);
      const credit = e.lines.reduce((s, l) => s + (l.credit ?? 0), 0);
      // Guarda de balance + que todas las cuentas existan.
      if (debit !== credit) {
        console.error("[posting] asiento desbalanceado", {
          source,
          month,
          day: e.day,
          debit,
          credit,
        });
        continue;
      }
      if (debit === 0) {
        if (e.creditNoteIds?.length) emptyNoteIds.push(...e.creditNoteIds);
        if (e.creditNoteTipIds?.length) emptyTipIds.push(...e.creditNoteTipIds);
        continue;
      }
      // Cada código base se resuelve a su cuenta IMPUTABLE: si el contador
      // abrió auxiliares debajo (11100501 Bancolombia), el movimiento cae en
      // la auxiliar y la línea guarda ESE código. Sin dónde asentar (cuenta
      // faltante o madre sin hijas imputables) el asiento del día se omite.
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
          source,
          month,
          day: e.day,
          code: unresolved,
        });
        continue;
      }
      valid.push({ draft: e, lines, debit });
    }
    // Nada válido y nada que marcar: la fuente queda como estaba (igual que
    // antes, un asiento que no se puede asentar no borra el anterior).
    if (valid.length === 0 && emptyNoteIds.length === 0 && emptyTipIds.length === 0) continue;

    const noteIds = [...valid.flatMap((v) => v.draft.creditNoteIds ?? []), ...emptyNoteIds];
    const tipIds = [...valid.flatMap((v) => v.draft.creditNoteTipIds ?? []), ...emptyTipIds];
    await db.$transaction(
      async (tx) => {
        await tx.journalEntry.deleteMany({
          where: { restaurantId, source, sourceRef: month },
        });
        for (const v of valid) {
          await tx.journalEntry.create({
            data: {
              restaurantId,
              date: v.draft.date,
              source,
              sourceRef: month,
              memo: v.draft.memo,
              status: "posted",
              lines: {
                create: v.lines.map((l) => ({
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
        }
        // Las notas crédito de los asientos quedan contabilizadas en este
        // mes: desde acá no se mueven aunque después se cierre o reabra otro.
        if (noteIds.length > 0) {
          await tx.creditNote.updateMany({
            where: {
              restaurantId,
              id: { in: noteIds },
              OR: [{ postedMonth: null }, { postedMonth: month }],
            },
            data: { postedMonth: month },
          });
        }
        // Ídem la propina devuelta de las notas (en general el mismo mes).
        if (tipIds.length > 0) {
          await tx.creditNote.updateMany({
            where: {
              restaurantId,
              id: { in: tipIds },
              OR: [{ tipPostedMonth: null }, { tipPostedMonth: month }],
            },
            data: { tipPostedMonth: month },
          });
        }
      },
      // Hasta 31 asientos con sus líneas por fuente: más que el tope por
      // defecto de una transacción interactiva.
      { maxWait: 10_000, timeout: 60_000 },
    );
    if (valid.length > 0) {
      results.push({ source, totalCents: valid.reduce((s, v) => s + v.debit, 0) });
    }
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

/**
 * Asientos del mes (para el Libro Diario), con el nombre de cada cuenta.
 * Con el motor diario son decenas por mes (uno por fuente y día): la
 * pantalla los agrupa por fecha.
 */
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
      .map(lineCentsToNumbers)
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
