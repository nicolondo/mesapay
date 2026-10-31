// Capa de datos de contabilidad (ERP B2): agrega ventas, CMV real del
// ledger (A4), mermas, gastos y compras del mes y se los pasa a la
// lógica pura de src/lib/erp/accounting.ts. Compartida por el P&L del
// operador y el consolidado de grupo.
import { db } from "@/lib/db";
import {
  buildPnl,
  splitPurchaseInventoryCost,
  type CategoryLine,
  embeddedTaxCents,
  type LaborSummary,
  netCategorySales,
  netSalesCents,
  netSalesTaxByRate,
  type Pnl,
  refundAdjustment,
  type SalesDetail,
  type SalesTaxKind,
  type SalesTaxSlice,
  type TaxSummary,
} from "@/lib/erp/accounting";
import { frozenSalesTax, type InvoiceSnapshot } from "@/lib/invoice";
import { PURCHASE_LINE_AMOUNTS_SELECT, purchaseOrderTotals, receivedPurchaseLineAmounts } from "@/lib/erp/purchaseTax";
import { derivedHourlyCents, shiftSurcharge } from "@/lib/erp/staff";
import { grossQty } from "@/lib/erp/recipes";
import { holidaysForYear, isSunday } from "@/lib/erp/holidays";
import { isModuleEnabled } from "@/lib/modules";
import { reportingPaymentMethod } from "@/lib/payments/methods";
import type { CreditNoteSnapshot } from "@/lib/dian/creditNotes/types";
import {
  acceptedCreditNoteWhere,
  creditNoteInstant,
  inFiscalRange,
  issuedAtWindow,
  loadUnlinkedRefundsCents,
  logInvalidCreditNote,
  storedNoteSlices,
} from "@/lib/erp/creditNoteAccounting";
import { creditNoteFiscalDate, sumSlices, type CreditNoteTaxSlice } from "@/lib/erp/creditNoteLedger";
import { isoDateUtc } from "@/lib/erp/reports/period";

export type MonthRange = { from: Date; to: Date };

/**
 * Ventas y CMV por categoría del MENÚ. Ventas = Σ precio de los ítems
 * vendidos (no cancelados) por categoría. CMV = costo real consumido
 * (movimientos sale_consumption) atribuido a la categoría del plato que
 * usó cada insumo, en proporción a cuánto consumió (re-explotando recetas).
 * El costo que no se puede atribuir (insumo sin receta viva) va a "(otros)".
 */
/** Categoría con su precio de carta (todo y sólo platos de carta) antes de repartir. */
type CategoryGross = { category: string; listCents: number; menuListCents: number; cmvCents: number };

async function computeCategoryBreakdown(
  restaurantId: string,
  range: MonthRange,
  cmvEnabled: boolean,
): Promise<CategoryGross[]> {
  const UNCAT = "(sin categoría)";
  const OTHER = "(otros)";
  const items = await db.orderItem.findMany({
    where: {
      order: {
        restaurantId,
        status: "paid",
        paidAt: { gte: range.from, lt: range.to },
      },
      // Los de rounds cancelados no venden ni consumen.
      OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }],
    },
    select: {
      qty: true,
      priceCentsSnapshot: true,
      menuItemId: true,
      taxKind: true,
      cancelledAt: true,
      cancellationKind: true,
      menuItem: { select: { category: { select: { label: true } } } },
    },
  });
  const catOf = (i: (typeof items)[number]) =>
    i.menuItem?.category?.label?.trim() || UNCAT;

  // Ventas: solo ítems NO cancelados (los comp no se cobran). Aparte, lo
  // de platos de carta (`taxKind` null): sólo ellos llevan el impuesto
  // adentro del precio; las líneas libres lo suman encima.
  const sales = new Map<string, number>();
  const menuSales = new Map<string, number>();
  for (const it of items) {
    if (it.cancelledAt) continue;
    const amount = it.priceCentsSnapshot * it.qty;
    sales.set(catOf(it), (sales.get(catOf(it)) ?? 0) + amount);
    if (it.taxKind == null) menuSales.set(catOf(it), (menuSales.get(catOf(it)) ?? 0) + amount);
  }

  const cmv = new Map<string, number>();
  if (cmvEnabled) {
    // Consumen: vivos + comp (se prepararon aunque no se cobren); cancel no.
    // Las líneas libres no tienen receta ni descuentan inventario, así que
    // tampoco aportan al costo de ventas.
    const consuming = items.filter(
      (it): it is typeof it & { menuItemId: string } =>
        it.menuItemId !== null &&
        (!it.cancelledAt || it.cancellationKind === "comp"),
    );
    const menuItemIds = [...new Set(consuming.map((i) => i.menuItemId))];
    const recipes = await db.recipe.findMany({
      where: { restaurantId, menuItemId: { in: menuItemIds } },
      select: {
        menuItemId: true,
        items: { select: { ingredientId: true, qtyBase: true, wastePct: true } },
      },
    });
    const recipeMap = new Map(
      recipes.filter((r) => r.menuItemId).map((r) => [r.menuItemId!, r.items]),
    );
    // (ingredientId → categoría → qtyBase) + total por insumo.
    const perIngCat = new Map<string, Map<string, number>>();
    const perIngTotal = new Map<string, number>();
    for (const it of consuming) {
      const lines = recipeMap.get(it.menuItemId);
      if (!lines) continue;
      const cat = catOf(it);
      for (const line of lines) {
        const g = Math.round(grossQty(line.qtyBase, line.wastePct)) * it.qty;
        if (g <= 0) continue;
        const m = perIngCat.get(line.ingredientId) ?? new Map<string, number>();
        m.set(cat, (m.get(cat) ?? 0) + g);
        perIngCat.set(line.ingredientId, m);
        perIngTotal.set(line.ingredientId, (perIngTotal.get(line.ingredientId) ?? 0) + g);
      }
    }
    // Costo real consumido por insumo (movimientos del mes).
    const moves = await db.stockMovement.groupBy({
      by: ["ingredientId"],
      where: {
        restaurantId,
        kind: "sale_consumption",
        createdAt: { gte: range.from, lt: range.to },
      },
      _sum: { valueCents: true },
    });
    for (const mv of moves) {
      const cost = Math.abs(mv._sum.valueCents ?? 0);
      const total = perIngTotal.get(mv.ingredientId) ?? 0;
      const catQtys = perIngCat.get(mv.ingredientId);
      if (total <= 0 || !catQtys) {
        cmv.set(OTHER, (cmv.get(OTHER) ?? 0) + cost);
        continue;
      }
      // Reparto proporcional; el residual de redondeo va a la última.
      const entries = [...catQtys.entries()];
      let assigned = 0;
      entries.forEach(([cat, q], idx) => {
        const share =
          idx === entries.length - 1
            ? cost - assigned
            : Math.round((cost * q) / total);
        assigned += share;
        cmv.set(cat, (cmv.get(cat) ?? 0) + share);
      });
    }
  }

  const cats = new Set([...sales.keys(), ...cmv.keys()]);
  return [...cats].map((category) => ({
    category,
    listCents: sales.get(category) ?? 0,
    menuListCents: menuSales.get(category) ?? 0,
    cmvCents: cmv.get(category) ?? 0,
  }));
}

/**
 * Ventas por categoría NETAS (sin impuesto, netas de descuento), para que
 * sumen los ingresos del PYG antes de notas crédito y devoluciones.
 */
function netCategoryBreakdown(
  categories: readonly CategoryGross[],
  detail: SalesDetail,
): CategoryLine[] {
  const net = netCategorySales(categories, detail);
  return categories
    .map((c) => ({ category: c.category, salesCents: net.get(c.category) ?? 0, cmvCents: c.cmvCents }))
    .sort((a, b) => b.salesCents - a.salesCents);
}

export async function computeMonthPnl(
  restaurantId: string,
  range: MonthRange,
): Promise<Pnl> {
  const [tenant, sales, salesTax, movements, expenses, purchases] = await Promise.all([
    db.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        enabledModules: true,
        country: true,
        staffStrictAttendance: true,
        staffHolidayPct: true,
        staffSundayPct: true,
        staffHoursDivisor: true,
      },
    }),
    db.order.aggregate({
      where: { restaurantId, paidAt: { gte: range.from, lt: range.to } },
      _sum: { subtotalCents: true, discountCents: true, tipCents: true, taxCents: true },
    }),
    // El impuesto incluido, las notas crédito y las devoluciones salen del
    // MISMO cálculo que la tarjeta de impuestos (y que el asiento): así el
    // PYG, «Impuestos» y los libros cuentan la misma cifra.
    computeSalesTaxSummary(restaurantId, range),
    // sale_consumption/waste = CMV y mermas reales (A4); purchase_in
    // valorado al recibir = compras del mes (cubre recepciones parciales
    // y entradas manuales — línea informativa del P&L).
    db.stockMovement.groupBy({
      by: ["kind"],
      where: {
        restaurantId,
        kind: { in: ["sale_consumption", "waste", "purchase_in"] },
        createdAt: { gte: range.from, lt: range.to },
      },
      _sum: { valueCents: true },
    }),
    db.expense.groupBy({
      by: ["category"],
      // recurring:false = gastos reales (las plantillas no son gasto; sus
      // copias materializadas nacen con recurring:false).
      where: {
        restaurantId,
        recurring: false,
        date: { gte: range.from, lt: range.to },
      },
      _sum: { amountCents: true },
    }),
    loadPurchasesBook(restaurantId, range),
  ]);

  const byKind = new Map(
    movements.map((m) => [m.kind, m._sum.valueCents ?? 0]),
  );

  // Costo laboral del mes (modelo de salario mensual): base fija = Σ
  // salarios de los empleados activos; encima, recargos festivo/dominical
  // de los turnos. Solo con el módulo staff activo; apagado, el P&L no
  // cambia.
  let labor: LaborSummary | null = null;
  if (isModuleEnabled(tenant?.enabledModules, "staff")) {
    const divisor = tenant?.staffHoursDivisor ?? 240;
    const [employees, shifts] = await Promise.all([
      db.employee.findMany({
        where: { restaurantId, active: true },
        select: { monthlySalaryCents: true },
      }),
      db.staffShift.findMany({
        where: { restaurantId, date: { gte: range.from, lt: range.to } },
        select: {
          date: true,
          startMinutes: true,
          endMinutes: true,
          checkInAt: true,
          checkOutAt: true,
          employee: { select: { monthlySalaryCents: true } },
        },
      }),
    ]);
    // Base salarial: salario completo del mes de cada empleado activo con
    // salario (sin prorrateo por altas/bajas a mitad de mes — fuera de
    // alcance). Independiente de si tiene turnos.
    const salaried = employees.filter((e) => e.monthlySalaryCents != null);
    labor = {
      totalCents: 0,
      baseSalaryCents: salaried.reduce(
        (a, e) => a + (e.monthlySalaryCents ?? 0),
        0,
      ),
      surchargeCents: 0,
      salariedEmployees: salaried.length,
      missingSalaryEmployees: employees.length - salaried.length,
      shifts: shifts.length,
      absentShifts: 0,
    };
    // C2: recargos por festivo/domingo y faltas (modo estricto) — mismas
    // reglas del GET semanal, para que el P&L cuadre con Horarios.
    const holidaySet = new Set([
      ...holidaysForYear(tenant?.country, range.from.getUTCFullYear()),
      ...holidaysForYear(tenant?.country, range.to.getUTCFullYear()),
    ]);
    const now = new Date();
    for (const sh of shifts) {
      const c = shiftSurcharge(
        {
          startMinutes: sh.startMinutes,
          endMinutes: sh.endMinutes,
          checkInAt: sh.checkInAt,
          checkOutAt: sh.checkOutAt,
          hourlyValueCents: derivedHourlyCents(
            sh.employee.monthlySalaryCents,
            divisor,
          ),
        },
        {
          isHoliday: holidaySet.has(sh.date.toISOString().slice(0, 10)),
          isSunday: isSunday(sh.date),
          holidayPct: tenant?.staffHolidayPct ?? 0,
          sundayPct: tenant?.staffSundayPct ?? 0,
          strict: tenant?.staffStrictAttendance ?? false,
          now,
          shiftDate: sh.date,
        },
      );
      labor.surchargeCents += c.surchargeCents;
      if (c.source === "absent") labor.absentShifts++;
    }
    labor.totalCents = labor.baseSalaryCents + labor.surchargeCents;
  }

  // CMV por categoría solo si hay consumo real (módulos inventory+recipes).
  const cmvEnabled =
    isModuleEnabled(tenant?.enabledModules, "inventory") &&
    isModuleEnabled(tenant?.enabledModules, "recipes");
  const categories = await computeCategoryBreakdown(
    restaurantId,
    range,
    cmvEnabled,
  );

  // Ingresos por ventas: sin impuesto ni propina, netos de descuentos y de
  // notas crédito y devoluciones (ver `netSalesCents`). Antes era Σ
  // subtotal: con el impuesto adentro, antes de descuentos y sin restar
  // notas, así que el margen salía inflado frente al estado de resultado.
  const salesDetail: SalesDetail = {
    listCents: sales._sum.subtotalCents ?? 0,
    discountCents: sales._sum.discountCents ?? 0,
    includedTaxCents: salesTax.taxCents,
    creditNotesCents: salesTax.creditNotes.baseCents,
    refundsCents: salesTax.refunds.baseCents,
  };
  const categoryBreakdown = netCategoryBreakdown(categories, salesDetail);

  return {
    ...buildPnl({
      salesCents: netSalesCents(salesDetail),
      salesDetail,
      tipsCents: sales._sum.tipCents ?? 0,
      taxesCents: sales._sum.taxCents ?? 0,
      consumptionCents: Math.abs(byKind.get("sale_consumption") ?? 0),
      wasteCents: Math.abs(byKind.get("waste") ?? 0),
      expensesByCategory: [
        ...expenses.map((e) => ({ category: e.category, amountCents: e._sum.amountCents ?? 0 })),
        ...(purchases.totals.nonInventoryReceivedCents + purchases.totals.nonInventoryIncCents + purchases.totals.nonInventoryNonDeductibleTaxCents > 0
          ? [{ category: "", source: "non_inventory_purchases" as const,
              amountCents: purchases.totals.nonInventoryReceivedCents + purchases.totals.nonInventoryIncCents + purchases.totals.nonInventoryNonDeductibleTaxCents }]
          : []),
      ],
      purchasesReceivedCents: Math.abs(byKind.get("purchase_in") ?? 0)
        + purchases.totals.nonInventoryReceivedCents + purchases.totals.nonInventoryIncCents + purchases.totals.nonInventoryNonDeductibleTaxCents,
      labor,
    }),
    categoryBreakdown,
  };
}

/**
 * Resumen de impuestos del mes (ERP A3) para la contabilidad y el reporte al
 * contador. Compras: IVA desde el taxPct de las líneas recibidas +
 * INC/retenciones capturados a nivel factura en la OC.
 *
 * Lado ventas, el impuesto embebido sale de lo FACTURADO: cada
 * `SimpleInvoice` congeló en su snapshot la tarifa vigente al emitirla y
 * el impuesto/base que declaró (ver `InvoiceSnapshot.embeddedTaxCents`),
 * y acá se suma eso agrupado por tarifa. Antes era "tarifa de HOY ×
 * ventas del mes": prender INC a mitad de septiembre recalculaba
 * septiembre entero con impuesto —incluidas facturas ya aceptadas por la
 * DIAN con impuesto cero— y los libros decían una cosa y las facturas
 * otra. Ahora prender el impuesto no toca nada emitido antes.
 *
 * El mes se corta por `Order.paidAt`, la misma fecha del libro de ventas
 * (`loadSalesBook`) y del asiento, para que impuesto y bruto caigan en el
 * mismo período aunque la tirilla se haya numerado después.
 *
 * Bruto y neto: `byRate`, `grossCents`, `taxCents` y `baseCents` son el
 * BRUTO de lo facturado (lo que asienta «Ventas del mes»). Aparte vienen
 * lo que restan las notas crédito aceptadas con fecha fiscal en el mes y
 * los reembolsos sin nota, y `net`, que es bruto − notas − devoluciones:
 * la misma regla de «Impuestos del período» (`reports/taxesDocuments`).
 *
 * Criterios documentados:
 *   · Snapshot sin tarifa (anterior a congelarla) ⇒ tramo "none", cero
 *     impuesto: es la verdad de cómo se emitió y así lo declaró el XML.
 *   · Ventas pagadas SIN factura (comercio sin facturación electrónica,
 *     o cuentas que nunca la generaron) siguen como hasta hoy: tarifa
 *     actual del comercio × su subtotal. No hay documento que las
 *     congele, y es lo que el contador venía recibiendo.
 */
export async function computeTaxSummary(
  restaurantId: string,
  range: MonthRange,
): Promise<TaxSummary> {
  const [sales, poHeaders] = await Promise.all([
    computeSalesTaxSummary(restaurantId, range),
    // Impuestos documentales y acumulados: misma fuente que pagos y libros.
    db.purchaseOrder.findMany({
      where: { restaurantId, receivedAt: { gte: range.from, lt: range.to } },
      select: {
        incCents: true,
        retefuenteCents: true,
        reteIvaCents: true,
        reteIcaCents: true,
        items: { select: PURCHASE_LINE_AMOUNTS_SELECT },
      },
    }),
  ]);

  const purchaseAmounts = poHeaders.map((order) => purchaseOrderTotals(order, "received"));
  const ivaCents = purchaseAmounts.reduce((sum, order) => sum + order.taxCents, 0);

  return {
    sales,
    purchases: {
      ivaCents,
      incCents: purchaseAmounts.reduce((sum, order) => sum + order.incCents, 0),
      retefuenteCents: poHeaders.reduce((sum, order) => sum + order.retefuenteCents, 0),
      reteIvaCents: poHeaders.reduce((sum, order) => sum + order.reteIvaCents, 0),
      reteIcaCents: poHeaders.reduce((sum, order) => sum + order.reteIcaCents, 0),
    },
  };
}

/** Lado ventas de `computeTaxSummary` (también lo usa el PYG). */
async function computeSalesTaxSummary(
  restaurantId: string,
  range: MonthRange,
): Promise<TaxSummary["sales"]> {
  const paidInMonth = {
    status: "paid" as const,
    paidAt: { gte: range.from, lt: range.to },
  };
  const [tenant, sales, uninvoiced, invoices, creditNotes, refundsCents] = await Promise.all([
    db.restaurant.findUnique({
      where: { id: restaurantId },
      select: { salesTaxKind: true, salesTaxPct: true },
    }),
    db.order.aggregate({
      where: { restaurantId, ...paidInMonth },
      _sum: { subtotalCents: true },
    }),
    // Ventas del mes que no tienen factura: siguen con la tarifa actual.
    db.order.aggregate({
      where: { restaurantId, ...paidInMonth, simpleInvoice: null },
      _sum: { subtotalCents: true },
    }),
    // Facturas del mes: lo que cada una congeló. El snapshot es JSON, así
    // que se agrupa en memoria (una fila por venta facturada del mes).
    db.simpleInvoice.findMany({
      where: { restaurantId, order: paidInMonth },
      select: { snapshot: true },
    }),
    loadMonthCreditNotes(restaurantId, range),
    loadUnlinkedRefundsCents(restaurantId, range.from, range.to),
  ]);

  const current = {
    kind: (tenant?.salesTaxKind ?? "none") as SalesTaxKind,
    pct: tenant?.salesTaxPct ?? 0,
  };
  if (current.kind === "none") current.pct = 0;

  // Tramos por tarifa: (tipo, %) → acumulado.
  const slices = new Map<string, SalesTaxSlice>();
  const add = (kind: SalesTaxKind, pct: number, grossCents: number, taxCents: number) => {
    const key = `${kind}:${pct}`;
    const s = slices.get(key) ?? { kind, pct, grossCents: 0, taxCents: 0, baseCents: 0 };
    s.grossCents += grossCents;
    s.taxCents += taxCents;
    s.baseCents = s.grossCents - s.taxCents;
    slices.set(key, s);
  };
  for (const inv of invoices) {
    const snap = inv.snapshot as unknown as InvoiceSnapshot;
    const frozen = frozenSalesTax(snap);
    const taxCents = frozen.kind === "none" ? 0 : (snap.embeddedTaxCents ?? 0);
    // Bruto del tramo: los platos del menú (base + impuesto) cuando el
    // snapshot lo congeló; para los viejos, el subtotal entero, que es lo
    // que el cálculo anterior tomaba como bruto.
    const grossCents =
      snap.embeddedBaseCents != null
        ? snap.embeddedBaseCents + taxCents
        : snap.subtotalCents;
    add(frozen.kind, frozen.pct, grossCents, taxCents);
  }
  const uninvoicedGross = uninvoiced._sum.subtotalCents ?? 0;
  if (uninvoicedGross > 0) {
    add(
      current.kind,
      current.pct,
      uninvoicedGross,
      current.kind === "none" ? 0 : embeddedTaxCents(uninvoicedGross, current.pct),
    );
  }

  const byRate = [...slices.values()]
    .filter((s) => s.kind !== "none" && s.taxCents > 0)
    .sort((a, b) => b.taxCents - a.taxCents);
  const grossCents = sales._sum.subtotalCents ?? 0;
  const salesTaxCents = byRate.reduce((s, r) => s + r.taxCents, 0);
  const label = byRate[0] ?? current;

  // Lo que restan: las notas por la tarifa de sus líneas; las devoluciones
  // sin nota, estimadas con el tramo del mes (como su asiento).
  const noteBase = creditNotes.slices.reduce((s, x) => s + x.baseCents, 0);
  const noteTax = creditNotes.slices.reduce((s, x) => s + x.taxCents, 0);
  const refunds = refundAdjustment(refundsCents, label);
  const net = netSalesTaxByRate(byRate, creditNotes.slices, {
    kind: label.kind,
    pct: label.pct,
    taxCents: refunds.taxCents,
  });

  return {
    kind: label.kind,
    pct: label.pct,
    grossCents,
    taxCents: salesTaxCents,
    baseCents: grossCents - salesTaxCents,
    byRate,
    creditNotes: {
      count: creditNotes.count,
      grossCents: noteBase + noteTax,
      baseCents: noteBase,
      taxCents: noteTax,
    },
    refunds,
    net: {
      baseCents: grossCents - salesTaxCents - noteBase - refunds.baseCents,
      taxCents: salesTaxCents - noteTax - refunds.taxCents,
      byRate: net,
    },
  };
}

// ── Libros (D5): filas para la vista JSON y el export CSV ──────────────────

/** Una nota crédito aceptada en el libro de ventas (montos POSITIVOS; restan). */
export type SalesBookCreditNote = {
  id: string;
  documentNumber: string;
  /** Fecha fiscal "YYYY-MM-DD" (día colombiano de emisión). */
  date: string;
  /** Factura que ajusta, como la declaró su XML. */
  invoiceNumber: string;
  customerName: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
};

/** Una nota del mes con sus tramos por tarifa ya validados. */
type MonthCreditNote = SalesBookCreditNote & { slices: CreditNoteTaxSlice[] };

/**
 * Notas crédito ACEPTADAS por la DIAN con fecha fiscal (día colombiano de
 * emisión) dentro del mes. Una nota que no cuadra al centavo se excluye
 * (igual que en contabilidad e impuestos) y queda en el log.
 */
async function loadMonthCreditNoteRows(
  restaurantId: string,
  range: MonthRange,
): Promise<MonthCreditNote[]> {
  const desde = isoDateUtc(range.from);
  const hasta = isoDateUtc(new Date(range.to.getTime() - 1));
  const rows = await db.creditNote.findMany({
    where: {
      ...acceptedCreditNoteWhere(restaurantId),
      dianDocument: { is: { state: "accepted", issuedAt: issuedAtWindow(desde, hasta) } },
    },
    select: {
      id: true,
      documentNumber: true,
      subtotalCents: true,
      taxCents: true,
      totalCents: true,
      snapshot: true,
      createdAt: true,
      dianDocument: { select: { issuedAt: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const out: MonthCreditNote[] = [];
  for (const r of rows) {
    const instant = creditNoteInstant(r);
    if (!inFiscalRange(instant, desde, hasta)) continue;
    const slices = storedNoteSlices(r);
    if (!slices.ok) {
      logInvalidCreditNote(r.id, r.documentNumber, slices.reason);
      continue;
    }
    const snap = r.snapshot as unknown as CreditNoteSnapshot;
    out.push({
      id: r.id,
      documentNumber: r.documentNumber,
      date: creditNoteFiscalDate(instant),
      invoiceNumber: snap?.original?.invoiceNumber ?? "",
      customerName: snap?.original?.customer?.name ?? null,
      subtotalCents: r.subtotalCents,
      taxCents: r.taxCents,
      totalCents: r.totalCents,
      slices: slices.slices,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.documentNumber.localeCompare(b.documentNumber));
}

/**
 * Notas crédito aceptadas del mes para el libro de ventas: documentos en
 * negativo (montos positivos; restan).
 */
export async function loadSalesBookCreditNotes(
  restaurantId: string,
  range: MonthRange,
): Promise<SalesBookCreditNote[]> {
  const notes = await loadMonthCreditNoteRows(restaurantId, range);
  return notes.map((n) => ({
    id: n.id,
    documentNumber: n.documentNumber,
    date: n.date,
    invoiceNumber: n.invoiceNumber,
    customerName: n.customerName,
    subtotalCents: n.subtotalCents,
    taxCents: n.taxCents,
    totalCents: n.totalCents,
  }));
}

/** Notas crédito aceptadas del mes sumadas por tarifa (para impuestos y PYG). */
async function loadMonthCreditNotes(
  restaurantId: string,
  range: MonthRange,
): Promise<{ count: number; slices: CreditNoteTaxSlice[] }> {
  const notes = await loadMonthCreditNoteRows(restaurantId, range);
  return { count: notes.length, slices: sumSlices(notes.map((n) => n.slices)) };
}

export async function loadSalesBook(restaurantId: string, range: MonthRange) {
  const [creditNotes, orders] = await Promise.all([
    loadSalesBookCreditNotes(restaurantId, range),
    db.order.findMany({
      where: { restaurantId, paidAt: { gte: range.from, lt: range.to } },
      orderBy: { paidAt: "asc" },
      select: {
        id: true,
        shortCode: true,
        paidAt: true,
        orderType: true,
        subtotalCents: true,
        tipCents: true,
        taxCents: true,
        totalCents: true,
        table: { select: { number: true, label: true } },
        payments: {
          where: { status: "approved" },
          select: { method: true, amountCents: true },
        },
        simpleInvoice: { select: { invoiceNumber: true } },
      },
    }),
  ]);

  const byMethod = new Map<string, number>();
  for (const o of orders) {
    for (const p of o.payments) {
      // cash y el histórico demo_cash suman en una sola fila "Efectivo".
      const method = reportingPaymentMethod(p.method);
      byMethod.set(method, (byMethod.get(method) ?? 0) + p.amountCents);
    }
  }
  const totals = {
    count: orders.length,
    subtotalCents: orders.reduce((s, o) => s + o.subtotalCents, 0),
    tipCents: orders.reduce((s, o) => s + o.tipCents, 0),
    taxCents: orders.reduce((s, o) => s + o.taxCents, 0),
    totalCents: orders.reduce((s, o) => s + o.totalCents, 0),
    byMethod: [...byMethod.entries()]
      .map(([method, amountCents]) => ({ method, amountCents }))
      .sort((a, b) => b.amountCents - a.amountCents),
  };
  // Notas crédito del mes: documentos que restan de las ventas (no tocan
  // los totales de las cuentas cobradas, que siguen siendo lo que entró).
  const creditNoteTotals = {
    count: creditNotes.length,
    subtotalCents: creditNotes.reduce((s, n) => s + n.subtotalCents, 0),
    taxCents: creditNotes.reduce((s, n) => s + n.taxCents, 0),
    totalCents: creditNotes.reduce((s, n) => s + n.totalCents, 0),
  };
  return { orders, totals, creditNotes, creditNoteTotals };
}

export async function loadPurchasesBook(
  restaurantId: string,
  range: MonthRange,
) {
  const orders = await db.purchaseOrder.findMany({
    where: { restaurantId, receivedAt: { gte: range.from, lt: range.to } },
    orderBy: { receivedAt: "asc" },
    select: {
      id: true,
      number: true,
      receivedAt: true,
      supplierInvoiceNumber: true,
      invoiceDueAt: true,
      paidAt: true,
      paidCents: true,
      incCents: true,
      retefuenteCents: true,
      reteIvaCents: true,
      reteIcaCents: true,
      supplier: { select: { name: true } },
      items: { select: { ...PURCHASE_LINE_AMOUNTS_SELECT, nonInventoryReceivedCostCents: true, nonInventoryReceivedNonDeductibleTaxCents: true, nonInventoryReceivedIncCents: true } },
    },
  });
  const rows = orders.map((o) => ({
    id: o.id,
    number: o.number,
    receivedAt: o.receivedAt,
    supplierName: o.supplier.name,
    supplierInvoiceNumber: o.supplierInvoiceNumber,
    invoiceDueAt: o.invoiceDueAt,
    paidAt: o.paidAt,
    outstandingCents: Math.max(0, purchaseOrderTotals(o, "received").totalCents - (o.paidCents ?? 0)),
    receivedCents: o.items.reduce((s, i) => s + i.receivedCostCents, 0),
    nonInventoryReceivedCents: o.items.reduce((s, i) => s + i.nonInventoryReceivedCostCents, 0),
    nonInventoryNonDeductibleTaxCents: o.items.reduce((s, i) => s + i.nonInventoryReceivedNonDeductibleTaxCents, 0),
    nonInventoryIncCents: splitPurchaseInventoryCost({
      receivedCents: o.items.reduce((s, i) => s + i.receivedCostCents, 0),
      nonInventoryReceivedCents: o.items.reduce((s, i) => s + i.nonInventoryReceivedCostCents, 0),
      incCents: purchaseOrderTotals(o, "received").incCents,
      allocatedIncCents: o.items.reduce((s, i) => s + receivedPurchaseLineAmounts(i).incCents, 0),
      nonInventoryAllocatedIncCents: o.items.reduce((s, i) => s + (i.nonInventoryReceivedIncCents ?? 0), 0),
    }).nonInventoryIncCents,
    // Impuestos de la factura (ERP A3): IVA desde las líneas + INC/retenciones.
    ivaCents: o.items.reduce(
      (s, i) => s + receivedPurchaseLineAmounts(i).taxCents,
      0,
    ),
    incCents: purchaseOrderTotals(o, "received").incCents,
    retefuenteCents: o.retefuenteCents,
    reteIvaCents: o.reteIvaCents,
    reteIcaCents: o.reteIcaCents,
  }));
  const totals = {
    count: rows.length,
    receivedCents: rows.reduce((s, r) => s + r.receivedCents, 0),
    nonInventoryReceivedCents: rows.reduce((s, r) => s + r.nonInventoryReceivedCents, 0),
    nonInventoryNonDeductibleTaxCents: rows.reduce((s, r) => s + r.nonInventoryNonDeductibleTaxCents, 0),
    nonInventoryIncCents: rows.reduce((s, r) => s + r.nonInventoryIncCents, 0),
    unpaidCents: rows.reduce((s, r) => s + r.outstandingCents, 0),
    ivaCents: rows.reduce((s, r) => s + r.ivaCents, 0),
    incCents: rows.reduce((s, r) => s + r.incCents, 0),
    retefuenteCents: rows.reduce((s, r) => s + r.retefuenteCents, 0),
    reteIvaCents: rows.reduce((s, r) => s + r.reteIvaCents, 0),
    reteIcaCents: rows.reduce((s, r) => s + r.reteIcaCents, 0),
  };
  return { rows, totals };
}

/**
 * Costo de ventas (CMV) del mes por insumo: Σ |valueCents| de los
 * movimientos sale_consumption (ledger A4), agrupado por insumo. Es el costo
 * real de lo vendido — para el reporte al contador.
 */
export async function loadCogsBook(restaurantId: string, range: MonthRange) {
  const moves = await db.stockMovement.groupBy({
    by: ["ingredientId"],
    where: {
      restaurantId,
      kind: "sale_consumption",
      createdAt: { gte: range.from, lt: range.to },
    },
    _sum: { valueCents: true },
  });
  const ids = moves.map((m) => m.ingredientId).filter((x): x is string => !!x);
  const ingredients = ids.length
    ? await db.ingredient.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, category: true },
      })
    : [];
  const byId = new Map(ingredients.map((i) => [i.id, i]));
  const rows = moves
    .map((m) => ({
      ingredientName: byId.get(m.ingredientId ?? "")?.name ?? "—",
      category: byId.get(m.ingredientId ?? "")?.category ?? "",
      valueCents: Math.abs(m._sum.valueCents ?? 0),
    }))
    .filter((r) => r.valueCents > 0)
    .sort((a, b) => b.valueCents - a.valueCents);
  const totals = { valueCents: rows.reduce((s, r) => s + r.valueCents, 0) };
  return { rows, totals };
}

/**
 * Inventario ACTUAL valorado por insumo (snapshot, no depende del mes):
 * existencia en unidad base + valor total (promedio ponderado). Para el
 * reporte al contador.
 */
export async function loadInventoryBook(restaurantId: string) {
  const levels = await db.stockLevel.findMany({
    where: { restaurantId, ingredient: { active: true, trackInventory: true } },
    select: {
      qtyBase: true,
      totalValueCents: true,
      ingredient: {
        select: { name: true, category: true, measureKind: true },
      },
    },
  });
  const rows = levels
    .map((l) => ({
      ingredientName: l.ingredient.name,
      category: l.ingredient.category ?? "",
      measureKind: l.ingredient.measureKind,
      qtyBase: l.qtyBase,
      valueCents: l.totalValueCents,
    }))
    .sort((a, b) => b.valueCents - a.valueCents);
  const totals = { valueCents: rows.reduce((s, r) => s + r.valueCents, 0) };
  return { rows, totals };
}
