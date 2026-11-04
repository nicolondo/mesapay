/**
 * Capa de BASE DE DATOS del despliegue de impuestos (`taxesDrillReport.ts`
 * la compone con `taxesQueries.ts`; los módulos `taxesDrill`,
 * `taxesReconcile`, `taxesChecks` y `taxesTrend` son puros). Sólo lee lo que
 * el reporte de impuestos no traía:
 *
 *  · la configuración del comercio que las revisiones necesitan (hora de
 *    corte del día de negocio, IVA descontable, UVT);
 *  · los conceptos de retención CON su tarifa, base y umbral;
 *  · los PEDIDOS PAGADOS de la ventana (con y sin factura) con lo mínimo
 *    del snapshot para reproducir el impuesto que les causa el motor
 *    (`orderSalesTaxSlice` + `orderFreeLineTaxSlices`: lo embebido de la
 *    carta y lo que sus líneas libres suman encima);
 *  · los asientos del motor del período (fuente + día);
 *  · el estado ante la DIAN de las facturas y notas crédito del período;
 *  · las facturas de la ventana de la tendencia, sin el snapshot entero.
 *
 * Los snapshots se leen con `jsonb_build_object` de los campos que hacen
 * falta (no el JSON completo: un mes de facturas pesa megas). Consultas
 * parametrizadas (`Prisma.sql`), nunca por interpolación.
 */
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { formatInvoiceNumber, type InvoiceSnapshot } from "@/lib/invoice";
import { currentSalesTaxOf, orderFreeLineTaxSlices, orderSalesTaxSlice } from "../salesTaxSlices";
import { formatVoucherNumber } from "./generalLedger";
import { saleTaxOfSnapshot } from "./saleTaxSnapshot";
import type { SaleTaxInput } from "./taxesDocuments";
import type { DianState, RetentionConceptFull } from "./taxesChecks";
import type { EngineEntry, EngineOrder } from "./taxesReconcile";
import { ORIGIN_SOURCE } from "./taxesDrill";

export type DrillTenant = {
  cutoffHour: number;
  purchaseIvaDeductible: boolean;
  salesTaxKind: string;
  salesTaxPct: number;
  uvtCents: number;
};

/** UVT 2026 por defecto (igual que `AccountingConfig.uvtCents`). */
const DEFAULT_UVT_CENTS = 5_237_400;

export async function loadDrillTenant(restaurantId: string): Promise<DrillTenant> {
  const [r, cfg] = await Promise.all([
    db.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        businessDayCutoffHour: true,
        purchaseIvaDeductible: true,
        salesTaxKind: true,
        salesTaxPct: true,
      },
    }),
    db.accountingConfig.findUnique({ where: { restaurantId }, select: { uvtCents: true } }),
  ]);
  return {
    cutoffHour: r?.businessDayCutoffHour ?? 0,
    purchaseIvaDeductible: r?.purchaseIvaDeductible ?? false,
    salesTaxKind: r?.salesTaxKind ?? "none",
    salesTaxPct: r?.salesTaxPct ?? 0,
    uvtCents: cfg?.uvtCents ?? DEFAULT_UVT_CENTS,
  };
}

export async function loadRetentionConceptsFull(restaurantId: string): Promise<(RetentionConceptFull & { accountCode: string })[]> {
  return db.retentionConcept.findMany({
    where: { restaurantId },
    select: { kind: true, name: true, rateBps: true, base: true, thresholdUvt: true, active: true, accountCode: true },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });
}

/** Una línea libre viva tal como la arma `ORDER_FREE_LINES`. */
type RawFreeLine = { amountCents: number; taxKind: string | null; taxPct: number | null };

/**
 * Líneas LIBRES vivas del pedido `o` (sin cancelar, fuera de rondas
 * canceladas): el mismo criterio que `accountingData.FREE_LINES_INCLUDE`,
 * con el que las lee el motor.
 */
const ORDER_FREE_LINES = Prisma.sql`(
  SELECT jsonb_agg(jsonb_build_object(
           'amountCents', i."priceCentsSnapshot" * i."qty",
           'taxKind', i."taxKind",
           'taxPct', i."taxPct"))
    FROM "OrderItem" i
    LEFT JOIN "Round" rd ON rd."id" = i."roundId"
   WHERE i."orderId" = o."id"
     AND i."taxKind" IS NOT NULL
     AND i."cancelledAt" IS NULL
     AND (i."roundId" IS NULL OR rd."status" <> 'cancelled'))`;

/** ¿La factura `s` suma impuesto ENCIMA (líneas libres)? Sólo entonces hacen falta sus ítems. */
const SNAP_HAS_FREE_TAX = Prisma.sql`COALESCE((s."snapshot" ->> 'taxCents')::numeric, 0) > 0`;

type RawOrder = {
  id: string;
  shortCode: string | null;
  paidAt: Date;
  status: string;
  subtotalCents: number;
  invoiceId: string | null;
  snap: Partial<InvoiceSnapshot> | null;
  /** Líneas libres vivas del pedido (`ORDER_FREE_LINES`). */
  freeLines: RawFreeLine[] | null;
};

/**
 * Pedidos pagados en `[from, to)` (por `Order.paidAt`, como el motor) con
 * los tramos que les causa el motor: lo embebido de la carta y lo que suman
 * sus líneas libres (mismas funciones que «Ventas del día»).
 */
export async function loadEngineOrders(
  restaurantId: string,
  from: Date,
  to: Date,
  current: { salesTaxKind: string; salesTaxPct: number },
): Promise<{ orders: EngineOrder[] }> {
  const rows = await db.$queryRaw<RawOrder[]>(Prisma.sql`
    SELECT o."id", o."shortCode", o."paidAt", o."status"::text AS "status", o."subtotalCents",
           s."id" AS "invoiceId",
           CASE WHEN s."id" IS NULL THEN NULL ELSE jsonb_build_object(
             'salesTaxKind', s."snapshot" -> 'salesTaxKind',
             'salesTaxPct', s."snapshot" -> 'salesTaxPct',
             'embeddedTaxCents', s."snapshot" -> 'embeddedTaxCents',
             'embeddedBaseCents', s."snapshot" -> 'embeddedBaseCents',
             'subtotalCents', s."snapshot" -> 'subtotalCents',
             'taxCents', s."snapshot" -> 'taxCents',
             'taxByKind', s."snapshot" -> 'taxByKind',
             'items', CASE WHEN ${SNAP_HAS_FREE_TAX} THEN s."snapshot" -> 'items' END
           ) END AS "snap",
           ${ORDER_FREE_LINES} AS "freeLines"
    FROM "Order" o
    LEFT JOIN "SimpleInvoice" s ON s."orderId" = o."id"
    WHERE o."restaurantId" = ${restaurantId}
      AND o."paidAt" >= ${from}
      AND o."paidAt" < ${to}
    ORDER BY o."paidAt" ASC
  `);
  const tax = currentSalesTaxOf(current);
  const orders = rows.map((r): EngineOrder => {
    const snap = r.snap ? (stripNulls(r.snap) as InvoiceSnapshot) : null;
    const taxOrder = { subtotalCents: r.subtotalCents, invoiceSnapshot: snap, freeLines: r.freeLines ?? [] };
    const slice = orderSalesTaxSlice(taxOrder, tax);
    const freeSlices = orderFreeLineTaxSlices(taxOrder).map(({ kind, pct, baseCents, taxCents }) => ({ kind, pct, baseCents, taxCents }));
    return {
      orderId: r.id,
      shortCode: r.shortCode,
      paidAtIso: r.paidAt.toISOString(),
      status: r.status,
      invoiceId: r.invoiceId,
      slice: { kind: slice.kind, pct: slice.pct, baseCents: slice.baseCents, taxCents: slice.taxCents },
      ...(freeSlices.length > 0 ? { freeSlices } : {}),
    };
  });
  return { orders };
}

/** `jsonb_build_object` deja `null` en los campos ausentes: se quitan para que el snapshot parcial se lea igual que el completo. */
function stripNulls(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

/** Asientos del motor (fuentes de los orígenes documentales) del rango, con su día. */
export async function loadEngineEntries(restaurantId: string, from: Date, to: Date): Promise<EngineEntry[]> {
  const rows = await db.journalEntry.findMany({
    where: {
      restaurantId,
      source: { in: Object.values(ORIGIN_SOURCE) },
      date: { gte: from, lt: to },
    },
    select: { id: true, source: true, date: true, voucherNumber: true },
    orderBy: { date: "asc" },
  });
  return rows.map((e) => ({
    id: e.id,
    source: e.source,
    day: e.date.toISOString().slice(0, 10),
    voucher: formatVoucherNumber(e.voucherNumber),
  }));
}

/** Estado DIAN de las facturas electrónicas (por id de factura). */
export async function loadDianInvoiceStates(
  restaurantId: string,
  invoiceIds: readonly string[],
): Promise<Map<string, DianState>> {
  const out = new Map<string, DianState>();
  if (invoiceIds.length === 0) return out;
  // En tandas: un mes grande puede tener miles de facturas.
  for (let i = 0; i < invoiceIds.length; i += 1000) {
    const rows = await db.dianDocument.findMany({
      where: { restaurantId, simpleInvoiceId: { in: invoiceIds.slice(i, i + 1000) } },
      select: { simpleInvoiceId: true, state: true, lastError: true },
    });
    for (const r of rows) if (r.simpleInvoiceId) out.set(r.simpleInvoiceId, { state: r.state, lastError: r.lastError });
  }
  return out;
}

/** Notas crédito creadas en el rango que la DIAN todavía no acepta (o rechazó), sin las descartadas. */
export async function loadDianCreditNotes(restaurantId: string, from: Date, to: Date) {
  const rows = await db.creditNote.findMany({
    where: {
      restaurantId,
      abandonedAt: null,
      createdAt: { gte: from, lt: to },
      OR: [{ dianDocument: { is: null } }, { dianDocument: { is: { state: { not: "accepted" } } } }],
    },
    select: {
      id: true,
      documentNumber: true,
      taxCents: true,
      createdAt: true,
      dianDocument: { select: { state: true } },
      originalInvoice: { select: { invoiceNumber: true, snapshot: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => {
    const snap = r.originalInvoice.snapshot as unknown as InvoiceSnapshot;
    return {
      id: r.id,
      document: r.documentNumber,
      reference: formatInvoiceNumber(snap, r.originalInvoice.invoiceNumber),
      dateIso: r.createdAt.toISOString(),
      state: r.dianDocument?.state ?? "to_send",
      taxCents: r.taxCents,
      party: snap?.customer?.name ?? null,
      nit: snap?.customer?.docNumber ?? null,
    };
  });
}

type RawTrendSale = {
  id: string;
  paidAt: Date;
  subtotalCents: number;
  snap: Partial<InvoiceSnapshot>;
  freeLines: RawFreeLine[] | null;
};

/**
 * Facturas de la ventana de la tendencia con lo mínimo para el documental
 * (tarifa congelada, impuesto y base): mismas reglas que `loadSaleTaxDocs`
 * vía `saleTaxOfSnapshot`, sin el adquiriente ni el snapshot entero.
 */
export async function loadSaleTaxTrendDocs(restaurantId: string, from: Date, to: Date): Promise<SaleTaxInput[]> {
  const rows = await db.$queryRaw<RawTrendSale[]>(Prisma.sql`
    SELECT s."id", o."paidAt", o."subtotalCents",
           jsonb_build_object(
             'salesTaxKind', s."snapshot" -> 'salesTaxKind',
             'salesTaxPct', s."snapshot" -> 'salesTaxPct',
             'embeddedTaxCents', s."snapshot" -> 'embeddedTaxCents',
             'embeddedBaseCents', s."snapshot" -> 'embeddedBaseCents',
             'subtotalCents', s."snapshot" -> 'subtotalCents',
             'taxCents', s."snapshot" -> 'taxCents',
             'taxByKind', s."snapshot" -> 'taxByKind',
             'items', CASE WHEN ${SNAP_HAS_FREE_TAX} THEN s."snapshot" -> 'items' END
           ) AS "snap",
           CASE WHEN ${SNAP_HAS_FREE_TAX} THEN ${ORDER_FREE_LINES} END AS "freeLines"
    FROM "SimpleInvoice" s
    JOIN "Order" o ON o."id" = s."orderId"
    WHERE s."restaurantId" = ${restaurantId}
      AND o."paidAt" >= ${from}
      AND o."paidAt" < ${to}
  `);
  return rows.map((r) => {
    const snap = stripNulls(r.snap) as InvoiceSnapshot;
    const tax = saleTaxOfSnapshot(snap);
    // Lo que las líneas libres suman encima, como `loadSaleTaxDocs`: así el
    // último punto de la serie sigue siendo la tesela.
    const freeLineSlices = orderFreeLineTaxSlices({
      subtotalCents: r.subtotalCents,
      invoiceSnapshot: snap,
      freeLines: r.freeLines ?? [],
    }).map(({ kind, pct, baseCents, taxCents }) => ({ kind, pct, baseCents, taxCents }));
    return {
      invoiceId: r.id,
      document: "",
      dateIso: r.paidAt.toISOString(),
      taxKind: tax.kind,
      taxPct: tax.pct,
      baseCents: tax.baseCents,
      taxCents: tax.taxCents,
      ...(freeLineSlices.length > 0 ? { freeLineSlices } : {}),
      customer: null,
    };
  });
}
