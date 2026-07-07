// Capa de datos de contabilidad (ERP B2): agrega ventas, CMV real del
// ledger (A4), mermas, gastos y compras del mes y se los pasa a la
// lógica pura de src/lib/erp/accounting.ts. Compartida por el P&L del
// operador y el consolidado de grupo.
import { db } from "@/lib/db";
import { buildPnl, type LaborSummary, type Pnl } from "@/lib/erp/accounting";
import { shiftCost } from "@/lib/erp/staff";
import { isModuleEnabled } from "@/lib/modules";

export type MonthRange = { from: Date; to: Date };

export async function computeMonthPnl(
  restaurantId: string,
  range: MonthRange,
): Promise<Pnl> {
  const [tenant, sales, movements, expenses] = await Promise.all([
    db.restaurant.findUnique({
      where: { id: restaurantId },
      select: { enabledModules: true },
    }),
    db.order.aggregate({
      where: { restaurantId, paidAt: { gte: range.from, lt: range.to } },
      _sum: { subtotalCents: true, tipCents: true, taxCents: true },
    }),
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
  ]);

  const byKind = new Map(
    movements.map((m) => [m.kind, m._sum.valueCents ?? 0]),
  );

  // C1 — costo laboral del mes: real (punchado) + estimado (planeado sin
  // punch). Solo con el módulo staff activo; apagado, el P&L no cambia.
  let labor: LaborSummary | null = null;
  if (isModuleEnabled(tenant?.enabledModules, "staff")) {
    const shifts = await db.staffShift.findMany({
      where: { restaurantId, date: { gte: range.from, lt: range.to } },
      select: {
        startMinutes: true,
        endMinutes: true,
        checkInAt: true,
        checkOutAt: true,
        employee: { select: { hourlyRateCents: true } },
      },
    });
    labor = {
      totalCents: 0,
      actualCents: 0,
      estimatedCents: 0,
      shifts: shifts.length,
      missingRateShifts: 0,
    };
    for (const sh of shifts) {
      const c = shiftCost({
        startMinutes: sh.startMinutes,
        endMinutes: sh.endMinutes,
        checkInAt: sh.checkInAt,
        checkOutAt: sh.checkOutAt,
        hourlyRateCents: sh.employee.hourlyRateCents,
      });
      labor.totalCents += c.costCents;
      if (c.source === "actual") labor.actualCents += c.costCents;
      else labor.estimatedCents += c.costCents;
      if (c.missingRate) labor.missingRateShifts++;
    }
  }

  return buildPnl({
    salesCents: sales._sum.subtotalCents ?? 0,
    tipsCents: sales._sum.tipCents ?? 0,
    taxesCents: sales._sum.taxCents ?? 0,
    consumptionCents: Math.abs(byKind.get("sale_consumption") ?? 0),
    wasteCents: Math.abs(byKind.get("waste") ?? 0),
    expensesByCategory: expenses.map((e) => ({
      category: e.category,
      amountCents: e._sum.amountCents ?? 0,
    })),
    purchasesReceivedCents: Math.abs(byKind.get("purchase_in") ?? 0),
    labor,
  });
}

// ── Libros (D5): filas para la vista JSON y el export CSV ──────────────────

export async function loadSalesBook(restaurantId: string, range: MonthRange) {
  const orders = await db.order.findMany({
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
  });

  const byMethod = new Map<string, number>();
  for (const o of orders) {
    for (const p of o.payments) {
      byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + p.amountCents);
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
  return { orders, totals };
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
      supplier: { select: { name: true } },
      items: { select: { receivedCostCents: true } },
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
    receivedCents: o.items.reduce((s, i) => s + i.receivedCostCents, 0),
  }));
  const totals = {
    count: rows.length,
    receivedCents: rows.reduce((s, r) => s + r.receivedCents, 0),
    unpaidCents: rows
      .filter((r) => !r.paidAt)
      .reduce((s, r) => s + r.receivedCents, 0),
  };
  return { rows, totals };
}
