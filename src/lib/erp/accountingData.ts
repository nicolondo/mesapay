// Capa de datos de contabilidad (ERP B2): agrega ventas, CMV real del
// ledger (A4), mermas, gastos y compras del mes y se los pasa a la
// lógica pura de src/lib/erp/accounting.ts. Compartida por el P&L del
// operador y el consolidado de grupo.
import { db } from "@/lib/db";
import {
  buildPnl,
  type CategoryLine,
  type LaborSummary,
  type Pnl,
} from "@/lib/erp/accounting";
import { derivedHourlyCents, shiftSurcharge } from "@/lib/erp/staff";
import { grossQty } from "@/lib/erp/recipes";
import { holidaysForYear, isSunday } from "@/lib/erp/holidays";
import { isModuleEnabled } from "@/lib/modules";

export type MonthRange = { from: Date; to: Date };

/**
 * Ventas y CMV por categoría del MENÚ. Ventas = Σ precio de los ítems
 * vendidos (no cancelados) por categoría. CMV = costo real consumido
 * (movimientos sale_consumption) atribuido a la categoría del plato que
 * usó cada insumo, en proporción a cuánto consumió (re-explotando recetas).
 * El costo que no se puede atribuir (insumo sin receta viva) va a "(otros)".
 */
async function computeCategoryBreakdown(
  restaurantId: string,
  range: MonthRange,
  cmvEnabled: boolean,
): Promise<CategoryLine[]> {
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
      cancelledAt: true,
      cancellationKind: true,
      menuItem: { select: { category: { select: { label: true } } } },
    },
  });
  const catOf = (i: (typeof items)[number]) =>
    i.menuItem?.category?.label?.trim() || UNCAT;

  // Ventas: solo ítems NO cancelados (los comp no se cobran).
  const sales = new Map<string, number>();
  for (const it of items) {
    if (it.cancelledAt) continue;
    sales.set(catOf(it), (sales.get(catOf(it)) ?? 0) + it.priceCentsSnapshot * it.qty);
  }

  const cmv = new Map<string, number>();
  if (cmvEnabled) {
    // Consumen: vivos + comp (se prepararon aunque no se cobren); cancel no.
    const consuming = items.filter(
      (it) => !it.cancelledAt || it.cancellationKind === "comp",
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
  return [...cats]
    .map((category) => ({
      category,
      salesCents: sales.get(category) ?? 0,
      cmvCents: cmv.get(category) ?? 0,
    }))
    .sort((a, b) => b.salesCents - a.salesCents);
}

export async function computeMonthPnl(
  restaurantId: string,
  range: MonthRange,
): Promise<Pnl> {
  const [tenant, sales, movements, expenses] = await Promise.all([
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
  const categoryBreakdown = await computeCategoryBreakdown(
    restaurantId,
    range,
    cmvEnabled,
  );

  return {
    ...buildPnl({
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
    }),
    categoryBreakdown,
  };
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
