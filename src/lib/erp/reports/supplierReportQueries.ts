/**
 * Capa de DATOS del informe de proveedores: la única que toca Prisma. Todo
 * se filtra por `restaurantId` (aislamiento por comercio) y la agregación
 * es de `supplierReport.ts`.
 *
 * Se agrega en memoria y no en SQL: el orden por promedio o por total
 * exige tener TODOS los proveedores calculados antes de cortar la página,
 * y un comercio tiene decenas o pocos cientos de proveedores. La pantalla
 * pagina sobre el resultado; la exportación lo lleva entero.
 */
import { db } from "@/lib/db";
import { NO_SUPPLIER_ID } from "./cartera";
import { cutoffEnd, loadPayablesDocs } from "./carteraQueries";
import { periodToUtcRange, isoDateUtc } from "./period";
import { supplierCreditTotalsBySupplier } from "./supplierCreditReport";
import { loadSupplierCreditReport } from "./supplierCreditReportQueries";
import {
  PURCHASE_LINE_AMOUNTS_SELECT,
  PURCHASE_ORDER_TAX_SELECT,
  RECEIVED_VAT_LINE_SELECT,
} from "@/lib/erp/purchaseTax";
import {
  buildSupplierReport,
  COUNTED_PURCHASE_STATUSES,
  expenseSupplierDoc,
  purchaseOrderDate,
  purchaseOrderSupplierDoc,
  type SupplierPurchaseDoc,
  type SupplierReportQuery,
  type SupplierReportRow,
} from "./supplierReport";

/** Recepciones de la OC: insumo y valor (IVA capitalizado) y su fecha (primera recepción). */
const RECEPTIONS_SELECT = {
  where: { kind: "purchase_in" as const },
  select: { ingredientId: true, valueCents: true, createdAt: true },
  orderBy: { createdAt: "asc" as const },
};

function bumpLatest(map: Map<string, string>, supplierId: string | null, date: Date | null | undefined) {
  if (!supplierId || !date) return;
  const iso = isoDateUtc(date);
  const prev = map.get(supplierId);
  if (!prev || iso > prev) map.set(supplierId, iso);
}

/**
 * Filas del informe (todas, sin filtrar ni paginar) para la query dada.
 * `today` = fecha local del comercio: corta la «última compra» y el saldo
 * por pagar (que es el de hoy, como la cartera).
 */
export async function loadSupplierReportRows(
  restaurantId: string,
  query: Pick<SupplierReportQuery, "period" | "basis" | "includeExpenses">,
  today: string,
): Promise<SupplierReportRow[]> {
  const { from, to } = periodToUtcRange({ desde: query.period.desde, hasta: query.period.hasta });
  const todayEnd = cutoffEnd(today);
  const statuses = [...COUNTED_PURCHASE_STATUSES];

  const [suppliers, orders, expenses, lastReceived, undatedOrders, lastExpenses, payableDocs, agreementNotes] = await Promise.all([
    db.supplier.findMany({
      where: { restaurantId },
      select: { id: true, name: true, taxId: true, taxIdType: true, paymentTermsDays: true, active: true },
    }),
    // OC con algo recibido cuya fecha PUEDE caer en el período: recepción
    // completa en el rango, o sin recepción completa (parcial: su fecha es la
    // primera recepción, que se resuelve en JS) creada antes del fin.
    db.purchaseOrder.findMany({
      where: {
        restaurantId,
        status: { in: statuses },
        OR: [{ receivedAt: { gte: from, lt: to } }, { receivedAt: null, createdAt: { lt: to } }],
      },
      select: {
        supplierId: true,
        status: true,
        receivedAt: true,
        createdAt: true,
        ...PURCHASE_ORDER_TAX_SELECT,
        items: { select: { ...PURCHASE_LINE_AMOUNTS_SELECT, ...RECEIVED_VAT_LINE_SELECT } },
        movements: RECEPTIONS_SELECT,
      },
    }),
    query.includeExpenses
      ? db.expense.findMany({
          where: { restaurantId, recurring: false, supplierId: { not: null }, date: { gte: from, lt: to } },
          select: {
            supplierId: true,
            recurring: true,
            date: true,
            amountCents: true,
            baseCents: true,
            ivaCents: true,
            incCents: true,
          },
        })
      : Promise.resolve([]),
    // Última compra (toda la historia hasta hoy): OC recibidas completas…
    db.purchaseOrder.groupBy({
      by: ["supplierId"],
      where: { restaurantId, status: { in: statuses }, receivedAt: { lt: todayEnd } },
      _max: { receivedAt: true },
    }),
    // …y las que no tienen recepción completa (su fecha es la primera recepción).
    db.purchaseOrder.findMany({
      where: { restaurantId, status: { in: statuses }, receivedAt: null },
      select: {
        supplierId: true,
        receivedAt: true,
        createdAt: true,
        movements: { ...RECEPTIONS_SELECT, select: { createdAt: true }, take: 1 },
      },
    }),
    query.includeExpenses
      ? db.expense.groupBy({
          by: ["supplierId"],
          where: { restaurantId, recurring: false, supplierId: { not: null }, date: { lt: todayEnd } },
          _max: { date: true },
        })
      : Promise.resolve([]),
    loadPayablesDocs(restaurantId, today),
    // Notas crédito vigentes de acuerdos comerciales del período (mismo
    // criterio y cifra que el reporte «Notas crédito de proveedores»).
    loadSupplierCreditReport(
      restaurantId,
      { desde: query.period.desde, hasta: query.period.hasta },
      { kind: "agreement" },
    ),
  ]);

  const docs: SupplierPurchaseDoc[] = [];
  for (const po of orders) {
    const d = purchaseOrderSupplierDoc(po);
    if (d) docs.push(d);
  }
  for (const e of expenses) {
    const d = expenseSupplierDoc(e);
    if (d) docs.push(d);
  }

  const lastPurchase = new Map<string, string>();
  for (const g of lastReceived) bumpLatest(lastPurchase, g.supplierId, g._max.receivedAt);
  for (const po of undatedOrders) {
    const at = purchaseOrderDate(po);
    if (at < todayEnd) bumpLatest(lastPurchase, po.supplierId, at);
  }
  for (const g of lastExpenses) bumpLatest(lastPurchase, g.supplierId, g._max.date);

  // Saldo de hoy, el mismo de la cartera; con «sólo compras», sin los gastos.
  const payables = new Map<string, number>();
  for (const d of payableDocs) {
    if (d.partnerId === NO_SUPPLIER_ID) continue;
    if (!query.includeExpenses && d.source === "expense") continue;
    payables.set(d.partnerId, (payables.get(d.partnerId) ?? 0) + d.outstandingCents);
  }

  const agreements = new Map<string, number>();
  for (const [supplierId, credit] of supplierCreditTotalsBySupplier(agreementNotes)) {
    if (credit.agreementCents !== 0) agreements.set(supplierId, credit.agreementCents);
  }

  return buildSupplierReport({
    suppliers,
    docs,
    period: query.period,
    basis: query.basis,
    lastPurchase,
    payables,
    agreements,
  });
}
