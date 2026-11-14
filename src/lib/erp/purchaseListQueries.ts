import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { bogotaBusinessDateIso, bogotaDayRange, bogotaTodayIso } from "@/lib/bogota";
import { PURCHASE_LINE_AMOUNTS_SELECT, purchaseOrderTotals } from "@/lib/erp/purchaseTax";
import {
  PURCHASE_PAGE_SIZE,
  isPayable,
  matchesPurchaseSearch,
  matchesStatusFilter,
  pageWindow,
  parsePurchaseSearch,
  payStatusOf,
  summarizePurchases,
  type PoStatus,
  type PurchaseListPage,
  type PurchaseListParams,
  type PurchaseListRow,
} from "@/lib/erp/purchaseList";

export type { PurchaseListPage, PurchaseListRow };

/** Proveedores del comercio para el filtro (también los inactivos: tienen compras viejas). */
export async function loadPurchaseFilterSuppliers(restaurantId: string) {
  return db.supplier.findMany({
    where: { restaurantId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, taxId: true, active: true },
  });
}

/**
 * Página de compras con los filtros de la URL, y el resumen (total, por
 * pagar, vencido) de TODAS las que los cumplen — no sólo de la página.
 *
 * El total de una compra sale de sus líneas e impuestos de cabecera
 * (`purchaseOrderTotals`, el mismo cálculo de Cartera y del detalle), que
 * no se puede expresar en SQL sin duplicar esa lógica. Por eso la base
 * filtra lo que puede (comercio, proveedor, fechas, estado de la orden) y
 * el resto —búsqueda normalizada, estado de pago, resumen y página— se
 * resuelve aquí sobre ese conjunto. Un comercio tiene cientos o pocos miles
 * de compras; con el rango de fechas o un proveedor el conjunto se achica.
 */
export async function loadPurchaseListPage(
  restaurantId: string,
  params: PurchaseListParams,
  opts: { todayIso?: string; pageSize?: number } = {},
): Promise<PurchaseListPage> {
  const todayIso = opts.todayIso ?? bogotaTodayIso();
  const pageSize = opts.pageSize ?? PURCHASE_PAGE_SIZE;

  const where: Prisma.PurchaseOrderWhereInput = { restaurantId };
  if (params.supplier) where.supplierId = params.supplier;
  if (params.from || params.to) {
    where.createdAt = {
      ...(params.from ? { gte: bogotaDayRange(params.from).start } : {}),
      ...(params.to ? { lt: bogotaDayRange(params.to).end } : {}),
    };
  }
  if (params.tab === "unpaid" || params.status === "paid") {
    where.status = { in: ["received", "partially_received"] };
  } else if (params.status !== "all" && ["draft", "sent", "partially_received", "received", "canceled"].includes(params.status)) {
    where.status = params.status as PoStatus;
  }

  const orders = await db.purchaseOrder.findMany({
    where,
    orderBy: params.tab === "unpaid" ? [{ invoiceDueAt: "asc" }, { createdAt: "asc" }, { id: "asc" }] : [{ createdAt: "desc" }, { number: "desc" }],
    // Todos los escalares (impuestos de cabecera incluidos) + montos de las líneas.
    include: {
      supplier: { select: { id: true, name: true, taxId: true } },
      items: { select: PURCHASE_LINE_AMOUNTS_SELECT },
    },
  });

  const search = parsePurchaseSearch(params.q);
  const rows: PurchaseListRow[] = [];
  for (const o of orders) {
    if (
      !matchesPurchaseSearch(
        {
          number: o.number,
          supplierInvoiceNumber: o.supplierInvoiceNumber,
          supplierName: o.supplier.name,
          supplierTaxId: o.supplier.taxId,
        },
        search,
      )
    ) {
      continue;
    }
    const ordered = purchaseOrderTotals(o);
    const received = purchaseOrderTotals(o, "received");
    const status = o.status as PoStatus;
    const outstandingCents = isPayable(status) ? Math.max(0, received.totalCents - o.paidCents) : 0;
    const payStatus = payStatusOf(
      {
        status,
        outstandingCents,
        paidCents: o.paidCents,
        dueDate: o.invoiceDueAt ? bogotaBusinessDateIso(o.invoiceDueAt) : null,
      },
      todayIso,
    );
    if (!matchesStatusFilter({ status, payStatus }, params.tab, params.status)) continue;
    rows.push({
      id: o.id,
      number: o.number,
      status,
      createdAt: o.createdAt.toISOString(),
      supplier: { id: o.supplier.id, name: o.supplier.name },
      supplierInvoiceNumber: o.supplierInvoiceNumber,
      invoiceDueAt: o.invoiceDueAt ? o.invoiceDueAt.toISOString() : null,
      itemCount: o.items.length,
      orderTotalCents: ordered.totalCents,
      receivedTotalCents: received.totalCents,
      receivedRetentionsCents: received.retentionsCents,
      paidCents: o.paidCents,
      outstandingCents,
      payStatus,
    });
  }

  const summary = summarizePurchases(
    rows.map((r) => ({
      status: r.status,
      // Lo mismo que muestra la fila: el saldo de la cuenta en «Por pagar»
      // (sobre lo recibido), el total de la orden en «Órdenes».
      totalCents: params.tab === "unpaid" ? r.receivedTotalCents : r.orderTotalCents,
      outstandingCents: r.outstandingCents,
      payStatus: r.payStatus,
    })),
  );
  const win = pageWindow(params.page, rows.length, pageSize);
  return {
    rows: rows.slice(win.start, win.end),
    page: win.page,
    pageCount: win.pageCount,
    from: win.from,
    to: win.to,
    total: rows.length,
    summary,
  };
}
