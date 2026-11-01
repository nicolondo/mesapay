/**
 * ÚNICA capa con base de datos de la información exógena. Carga las filas
 * planas del año gravable (01-01 → 31-12, límites UTC como el resto de
 * los reportes) y se las pasa a `buildExogenaReport` (puro).
 *
 * Fuentes por formato:
 *  · 1001 / 1005 / 1009: órdenes de compra (`PurchaseOrder` + items +
 *    abonos) y gastos manuales con proveedor (`Expense` + abonos). Las
 *    plantillas recurrentes (`recurring = true`) no son gastos reales.
 *  · 1006 / 1007: tirillas emitidas (`SimpleInvoice`, snapshot congelado
 *    del impuesto) de órdenes pagadas en el año; el adquiriente es la
 *    solicitud de factura de la orden (`InvoiceRequest`), si la hay.
 *  · 1005 / 1006 / 1007 (devoluciones): notas crédito ACEPTADAS por la
 *    DIAN con fecha fiscal en el año; el adquiriente es el de su factura
 *    original con la misma regla de arriba.
 *  · 1008: cortes de bonos a crédito (`VoucherStatement`) abiertos al 31/12
 *    y ventas a crédito a clientes de facturación (`Payment` con método
 *    `customer_credit`, abonos `CustomerCreditPayment` y notas crédito que
 *    bajaron cartera), con el saldo reconstruido al 31/12.
 *  · 1011: declaraciones registradas (`TaxFiling`) del año.
 *  · 2276: conceptos liquidados (`PayrollItem`) de las corridas del año.
 *    MESAPAY no "confirma" corridas (siempre `draft`): entran todas.
 *  · 1010 / 1012: tablas de captura manual.
 */

import { db } from "@/lib/db";
import { frozenSalesTax, type InvoiceSnapshot } from "@/lib/invoice";
import {
  acceptedCreditNoteWhere,
  creditNoteInstant,
  ensureCreditNoteStamps,
  inFiscalRange,
  issuedAtWindow,
  logInvalidCreditNote,
  storedNoteSlices,
} from "../creditNoteAccounting";
import { creditNoteFiscalDate } from "../creditNoteLedger";
import { centsToNumber } from "../ledgerCents";
import { PURCHASE_LINE_AMOUNTS_SELECT, purchaseOrderTotals, receivedPurchaseLineAmounts } from "../purchaseTax";
import { UVT_DEFAULT_CENTS } from "../retenciones";
import { uvtDelAno } from "./normativa";
import {
  billingCustomerTercero,
  buildExogenaReport,
  creditReceivablesAtCutoff,
  requestTercero,
  type CreditNoteExogenaInput,
  type ExogenaInputs,
  type ExogenaReport,
  type ReceivableInput,
  type SaleInput,
  type Tercero,
} from "./sources";

/** Límites UTC del año gravable: `from` inclusivo, `to` EXCLUSIVO. */
export function yearRange(year: number): { from: Date; to: Date } {
  return { from: new Date(Date.UTC(year, 0, 1)), to: new Date(Date.UTC(year + 1, 0, 1)) };
}

const supplierSelect = { id: true, name: true, taxId: true, address: true } as const;

/**
 * Impuesto y base de una tirilla desde su snapshot congelado: el embebido
 * de los platos (según `salesTaxKind`) + el de las líneas libres
 * (`taxByKind`). Base = subtotal − descuento − impuesto embebido (la
 * propina no es ingreso).
 */
export function saleFromSnapshot(snap: InvoiceSnapshot, customer: Tercero | null): SaleInput {
  const frozen = frozenSalesTax(snap);
  const embedded = frozen.kind === "none" ? 0 : (snap.embeddedTaxCents ?? 0);
  const free = snap.taxByKind ?? {
    inc: frozen.kind === "inc" ? (snap.taxCents ?? 0) : 0,
    iva: frozen.kind === "inc" ? 0 : (snap.taxCents ?? 0),
  };
  return {
    customer,
    baseCents: Math.max(0, snap.subtotalCents - (snap.discountCents ?? 0) - embedded),
    ivaCents: (frozen.kind === "iva" ? embedded : 0) + (free.iva ?? 0),
    incCents: (frozen.kind === "inc" ? embedded : 0) + (free.inc ?? 0),
  };
}

/** Solicitud de factura de la orden que define al adquiriente (ventas y notas). */
const SALE_REQUEST_SELECT = {
  where: { status: { not: "rejected" as const } },
  orderBy: { createdAt: "asc" as const },
  take: 1,
  select: {
    customerName: true,
    docType: true,
    docNumber: true,
    address: true,
    city: true,
    department: true,
  },
};

/**
 * Notas crédito aceptadas con fecha fiscal en el año, con el adquiriente de
 * su factura original. Las que no cuadran al centavo se excluyen (log).
 */
export async function loadCreditNoteExogenaInputs(
  restaurantId: string,
  year: number,
): Promise<CreditNoteExogenaInput[]> {
  const desde = `${year}-01-01`;
  const hasta = `${year}-12-31`;
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
      originalInvoice: { select: { order: { select: { invoiceRequests: SALE_REQUEST_SELECT } } } },
    },
  });
  const out: CreditNoteExogenaInput[] = [];
  for (const r of rows) {
    if (!inFiscalRange(creditNoteInstant(r), desde, hasta)) continue;
    const slices = storedNoteSlices(r);
    if (!slices.ok) {
      logInvalidCreditNote(r.id, r.documentNumber, slices.reason);
      continue;
    }
    const req = r.originalInvoice.order.invoiceRequests[0];
    const sum = (kind: string) =>
      slices.slices.filter((sl) => sl.kind === kind).reduce((acc, sl) => acc + sl.taxCents, 0);
    out.push({
      customer: req ? requestTercero(req) : null,
      baseCents: slices.slices.reduce((acc, sl) => acc + sl.baseCents, 0),
      ivaCents: sum("iva"),
      incCents: sum("inc"),
    });
  }
  return out;
}

const BILLING_CUSTOMER_TERCERO_SELECT = {
  id: true,
  customerName: true,
  docType: true,
  docNumber: true,
  verificationDigit: true,
  address: true,
  municipalityCode: true,
  country: true,
} as const;

/**
 * 1008 — ventas a crédito a clientes de facturación con saldo al 31/12:
 * cargos cobrados hasta el corte, abonos hasta el corte y notas crédito
 * (con fecha fiscal hasta el corte) que bajaron cartera. Mismas fuentes que
 * la cartera (`reports/carteraQueries.loadReceivableDocs`) y que la cuenta
 * Clientes del motor (130505).
 */
export async function loadCreditReceivables(
  restaurantId: string,
  year: number,
): Promise<ReceivableInput[]> {
  const { to } = yearRange(year);
  const hasta = `${year}-12-31`;
  // Sin fijar, una nota aceptada todavía no bajó el cargo: se fija antes de
  // leer (idempotente y normalmente sin nada que hacer), como los reportes
  // de impuestos.
  await ensureCreditNoteStamps(restaurantId);
  const [charges, abonos] = await Promise.all([
    db.payment.findMany({
      where: {
        method: "customer_credit",
        status: { in: ["approved", "refunded"] },
        billingCustomerId: { not: null },
        settledAt: { lt: to },
        order: { restaurantId },
      },
      select: {
        id: true,
        orderId: true,
        settledAt: true,
        createdAt: true,
        amountCents: true,
        refundedCents: true,
        creditNoteCents: true,
        billingCustomer: { select: BILLING_CUSTOMER_TERCERO_SELECT },
      },
    }),
    db.customerCreditPayment.findMany({
      where: { restaurantId, paidAt: { lt: to } },
      select: { billingCustomerId: true, amountCents: true },
    }),
  ]);
  if (charges.length === 0) return [];
  const orderIds = [...new Set(charges.map((c) => c.orderId))];
  const notes = await db.creditNote.findMany({
    where: {
      ...acceptedCreditNoteWhere(restaurantId),
      accountingStampedAt: { not: null },
      receivableCents: { gt: 0 },
      originalInvoice: { orderId: { in: orderIds } },
    },
    select: {
      receivableCents: true,
      createdAt: true,
      dianDocument: { select: { issuedAt: true } },
      originalInvoice: { select: { orderId: true } },
    },
  });
  const customers = new Map<string, NonNullable<(typeof charges)[number]["billingCustomer"]>>();
  for (const c of charges) if (c.billingCustomer) customers.set(c.billingCustomer.id, c.billingCustomer);
  const saldos = creditReceivablesAtCutoff(
    charges
      .filter((c) => c.billingCustomer)
      .map((c) => ({
        id: c.id,
        customerId: c.billingCustomer!.id,
        orderId: c.orderId,
        date: c.settledAt ?? c.createdAt,
        amountCents: c.amountCents,
        refundedCents: c.refundedCents,
        creditNoteCents: c.creditNoteCents,
      })),
    abonos.map((a) => ({ customerId: a.billingCustomerId, amountCents: a.amountCents })),
    notes.map((n) => ({
      orderId: n.originalInvoice.orderId,
      receivableCents: n.receivableCents ?? 0,
      fiscalDate: creditNoteFiscalDate(creditNoteInstant(n)),
    })),
    hasta,
  );
  const out: ReceivableInput[] = [];
  for (const [customerId, saldoCents] of saldos) {
    const customer = customers.get(customerId);
    if (customer && saldoCents > 0) out.push({ customer: billingCustomerTercero(customer), saldoCents });
  }
  return out;
}

/** UVT del año gravable en pesos (tabla, o el valor que mantiene el contador). */
export async function loadUvtPesos(restaurantId: string, year: number): Promise<number> {
  const cfg = await db.accountingConfig.findUnique({
    where: { restaurantId },
    select: { uvtCents: true },
  });
  return uvtDelAno(year, Math.round((cfg?.uvtCents ?? UVT_DEFAULT_CENTS) / 100));
}

/** Todas las filas planas del año gravable. */
export async function loadExogenaInputs(restaurantId: string, year: number): Promise<ExogenaInputs> {
  const { from, to } = yearRange(year);
  const yearPrefix = `${year}-`;

  const [orders, expenses, invoices, statements, payableOrders, payableExpenses, filings, payroll, shareholders, holdings, creditNotes, creditReceivables] =
    await Promise.all([
      // Compras recibidas en el año (recepción completa, como el libro de compras).
      db.purchaseOrder.findMany({
        where: { restaurantId, receivedAt: { gte: from, lt: to } },
        select: {
          retefuenteCents: true,
          reteIvaCents: true,
          supplier: { select: supplierSelect },
          items: {
            select: {
              ...PURCHASE_LINE_AMOUNTS_SELECT,
              nonInventoryReceivedNonDeductibleTaxCents: true,
            },
          },
        },
      }),
      // Gastos manuales del año con proveedor (sin plantillas).
      db.expense.findMany({
        where: {
          restaurantId,
          date: { gte: from, lt: to },
          supplierId: { not: null },
          recurring: false,
        },
        select: { category: true, amountCents: true, supplier: { select: supplierSelect } },
      }),
      // Tirillas de órdenes pagadas en el año + solicitud de factura de la orden.
      db.simpleInvoice.findMany({
        where: { restaurantId, order: { status: "paid", paidAt: { gte: from, lt: to } } },
        select: {
          snapshot: true,
          order: { select: { invoiceRequests: SALE_REQUEST_SELECT } },
        },
      }),
      // CxC: cortes a crédito emitidos hasta el 31/12 y aún abiertos a esa fecha.
      db.voucherStatement.findMany({
        where: {
          restaurantId,
          createdAt: { lt: to },
          OR: [{ status: "open" }, { paidAt: { gte: to } }],
        },
        select: {
          creditCents: true,
          billingCustomer: {
            select: {
              id: true,
              customerName: true,
              docType: true,
              docNumber: true,
              verificationDigit: true,
              address: true,
              municipalityCode: true,
              country: true,
            },
          },
        },
      }),
      // CxP de compras: OCs con mercancía recibida hasta el 31/12.
      db.purchaseOrder.findMany({
        where: {
          restaurantId,
          status: { in: ["received", "partially_received"] },
          OR: [{ receivedAt: { lt: to } }, { receivedAt: null, createdAt: { lt: to } }],
        },
        select: {
          supplier: { select: supplierSelect },
          incCents: true,
          retefuenteCents: true,
          reteIvaCents: true,
          reteIcaCents: true,
          items: { select: PURCHASE_LINE_AMOUNTS_SELECT },
          payments: { where: { paidAt: { lt: to } }, select: { amountCents: true } },
        },
      }),
      // CxP de gastos: gastos con proveedor fechados hasta el 31/12.
      db.expense.findMany({
        where: { restaurantId, date: { lt: to }, supplierId: { not: null }, recurring: false },
        select: {
          amountCents: true,
          supplier: { select: supplierSelect },
          payments: { where: { paidAt: { lt: to } }, select: { amountCents: true } },
        },
      }),
      db.taxFiling.findMany({
        where: { restaurantId, period: { startsWith: yearPrefix } },
        select: { form: true, declaredCents: true },
      }),
      db.payrollItem.findMany({
        where: { run: { restaurantId, month: { startsWith: yearPrefix } } },
        select: {
          employeeId: true,
          employeeName: true,
          conceptKey: true,
          kind: true,
          amountCents: true,
        },
      }),
      db.exogenaShareholder.findMany({
        where: { restaurantId, year },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          docType: true,
          docNumber: true,
          dv: true,
          sharePctBps: true,
          nominalCents: true,
          premiumCents: true,
        },
      }),
      db.exogenaHolding.findMany({
        where: { restaurantId, year },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          concept: true,
          entityName: true,
          entityDocType: true,
          entityDocNumber: true,
          valueCents: true,
        },
      }),
      loadCreditNoteExogenaInputs(restaurantId, year),
      loadCreditReceivables(restaurantId, year),
    ]);

  const sum = (ns: number[]) => ns.reduce((s, n) => s + n, 0);

  return {
    purchases: orders.map((o) => ({
      supplier: o.supplier,
      netCents: sum(o.items.map((it) => it.receivedCostCents)),
      ivaCents: sum(o.items.map((it) => receivedPurchaseLineAmounts(it).taxCents)),
      indedCents: sum(o.items.map((it) => it.nonInventoryReceivedNonDeductibleTaxCents)),
      retefuenteCents: o.retefuenteCents,
      reteIvaCents: o.reteIvaCents,
    })),
    expenses: expenses
      .filter((e) => e.supplier)
      .map((e) => ({ supplier: e.supplier!, category: e.category, amountCents: e.amountCents })),
    sales: invoices.map((inv) => {
      const req = inv.order.invoiceRequests[0];
      return saleFromSnapshot(
        inv.snapshot as unknown as InvoiceSnapshot,
        req ? requestTercero(req) : null,
      );
    }),
    creditNotes,
    receivables: [
      ...statements.map((s) => ({
        customer: billingCustomerTercero(s.billingCustomer),
        saldoCents: s.creditCents,
      })),
      ...creditReceivables,
    ],
    payables: [
      ...payableOrders.map((o) => ({
        supplier: o.supplier,
        totalCents: purchaseOrderTotals(o, "received").totalCents,
        paidCents: sum(o.payments.map((p) => p.amountCents)),
      })),
      ...payableExpenses
        .filter((e) => e.supplier)
        .map((e) => ({
          supplier: e.supplier!,
          totalCents: e.amountCents,
          paidCents: sum(e.payments.map((p) => p.amountCents)),
        })),
    ],
    filings: filings.map((f) => ({ ...f, declaredCents: centsToNumber(f.declaredCents) })),
    payroll,
    // BigInt (Postgres) → Number: los centavos de un comercio caben en 2^53.
    shareholders: shareholders.map((s) => ({
      ...s,
      nominalCents: Number(s.nominalCents),
      premiumCents: Number(s.premiumCents),
    })),
    holdings: holdings.map((h) => ({ ...h, valueCents: Number(h.valueCents) })),
  };
}

export type ExogenaLoaded = { uvtPesos: number; report: ExogenaReport };

/** Reporte completo del año gravable (lo que consumen la página y las rutas). */
export async function loadExogenaReport(restaurantId: string, year: number): Promise<ExogenaLoaded> {
  const [uvtPesos, inputs] = await Promise.all([
    loadUvtPesos(restaurantId, year),
    loadExogenaInputs(restaurantId, year),
  ]);
  return { uvtPesos, report: buildExogenaReport(inputs) };
}
