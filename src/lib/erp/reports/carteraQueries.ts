/**
 * Capa de DATOS de la cartera: la única que toca Prisma. Devuelve
 * `CarteraDoc` / `CarteraPayment` listos para `cartera.ts`; no agrupa ni
 * envejece nada.
 *
 * ── Corte «a una fecha» (`hasta`) ────────────────────────────────────────
 * La cartera se RECONSTRUYE a la fecha de corte: sólo cuentan documentos
 * fechados hasta `hasta` y abonos con `paidAt` hasta `hasta`. El saldo
 * NO sale del cache `paidCents` (que es «hoy»), sino de la suma de los
 * abonos anteriores al corte. Para no leer toda la historia, el filtro
 * SQL descarta lo que seguro estaba saldado al corte: un documento con
 * `paidAt` fijado (saldo hoy = 0) y sin ningún abono fechado después del
 * corte tenía saldo 0 también en el corte (Σ abonos ≤ corte = Σ abonos =
 * total). Todo lo demás se trae y se recalcula en JS.
 *
 * Límite exclusivo: `to` = 00:00Z del día siguiente a `hasta`, el mismo
 * convenio UTC del resto del ERP (`period.ts`, `monthRange`). Las fechas
 * elegidas por el operador (`paidAt`, `date`, `dueAt`, `invoiceDueAt`) se
 * guardan al mediodía local, así que su día UTC es el que digitó; sólo
 * `receivedAt`/`createdAt` son instantes reales y pueden correrse un día
 * si la recepción fue de noche (aceptado: el libro contable usa el mismo
 * convenio).
 *
 * ── Fecha de una OC ──────────────────────────────────────────────────────
 * `receivedAt` sólo existe con recepción COMPLETA. Para una OC
 * parcialmente recibida se usa la fecha de su primer movimiento de
 * recepción (`StockMovement.purchase_in`, que ES el registro de recepción)
 * y, si no hubiera, `createdAt`.
 */
import { db } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules";
import { poTotals } from "@/lib/erp/purchaseTax";
import {
  allocateFifo,
  chargeDebtCents,
  type CreditAbono,
  type CreditCharge,
} from "@/lib/customerCredit";
import {
  addDays,
  NO_SUPPLIER_ID,
  type CarteraDoc,
  type CarteraKind,
  type CarteraPayment,
} from "./cartera";
import { isoDateUtc, periodToUtcRange } from "./period";

/** Límite EXCLUSIVO del corte: 00:00Z del día siguiente a `hasta`. */
export function cutoffEnd(hasta: string): Date {
  return periodToUtcRange({ desde: hasta, hasta }).to;
}

function sum(payments: readonly { amountCents: number }[]): number {
  return payments.reduce((s, p) => s + p.amountCents, 0);
}

function padNumber(n: number): string {
  return String(n).padStart(4, "0");
}

// ─── Por pagar ───────────────────────────────────────────────────────────

const PO_SELECT = {
  id: true,
  number: true,
  createdAt: true,
  receivedAt: true,
  invoiceDueAt: true,
  supplierInvoiceNumber: true,
  supplier: { select: { id: true, name: true, taxId: true, paymentTermsDays: true } },
  items: { select: { receivedCostCents: true, taxPct: true } },
  movements: {
    where: { kind: "purchase_in" as const },
    select: { createdAt: true },
    orderBy: { createdAt: "asc" as const },
    take: 1,
  },
} as const;

type PoRow = {
  id: string;
  number: number;
  createdAt: Date;
  receivedAt: Date | null;
  invoiceDueAt: Date | null;
  supplierInvoiceNumber: string | null;
  supplier: { id: string; name: string; taxId: string | null; paymentTermsDays: number | null };
  items: { receivedCostCents: number; taxPct: number }[];
  movements: { createdAt: Date }[];
  payments: { id: string; amountCents: number; paidAt: Date; method: string | null; note: string | null }[];
};

/** OC recibida → documento de cartera (null si su fecha es posterior al corte). */
function poToDoc(po: PoRow, to: Date): CarteraDoc | null {
  const dateAt = po.receivedAt ?? po.movements[0]?.createdAt ?? po.createdAt;
  if (dateAt >= to) return null;
  const date = isoDateUtc(dateAt);
  const totalCents = poTotals(
    po.items.map((i) => ({ costCents: i.receivedCostCents, taxPct: i.taxPct })),
  ).totalCents;
  return {
    id: po.id,
    source: "purchase_order",
    partnerId: po.supplier.id,
    partnerName: po.supplier.name,
    partnerTaxId: po.supplier.taxId,
    number: po.supplierInvoiceNumber ?? padNumber(po.number),
    date,
    dueDate: po.invoiceDueAt
      ? isoDateUtc(po.invoiceDueAt)
      : addDays(date, po.supplier.paymentTermsDays ?? 0),
    totalCents,
    outstandingCents: totalCents - sum(po.payments),
  };
}

type ExpenseRow = {
  id: string;
  category: string;
  description: string | null;
  amountCents: number;
  date: Date;
  dueAt: Date | null;
  supplier: { id: string; name: string; taxId: string | null } | null;
  payments: { id: string; amountCents: number; paidAt: Date; note: string | null }[];
};

function expenseToDoc(e: ExpenseRow): CarteraDoc {
  const date = isoDateUtc(e.date);
  return {
    id: e.id,
    source: "expense",
    partnerId: e.supplier?.id ?? NO_SUPPLIER_ID,
    partnerName: e.supplier?.name ?? "",
    partnerTaxId: e.supplier?.taxId ?? null,
    number: e.description || e.category,
    date,
    dueDate: e.dueAt ? isoDateUtc(e.dueAt) : date,
    totalCents: e.amountCents,
    outstandingCents: e.amountCents - sum(e.payments),
  };
}

function paymentsOf(
  docId: string,
  rows: readonly { id: string; amountCents: number; paidAt: Date; note: string | null; method?: string | null }[],
): CarteraPayment[] {
  return rows.map((p) => ({
    id: p.id,
    docId,
    date: isoDateUtc(p.paidAt),
    amountCents: p.amountCents,
    note: p.note ?? p.method ?? null,
  }));
}

/**
 * Documentos por pagar con saldo al corte: OC recibidas (total bruto de lo
 * recibido, como la ruta de pagos) y gastos no recurrentes.
 */
export async function loadPayablesDocs(restaurantId: string, hasta: string): Promise<CarteraDoc[]> {
  const to = cutoffEnd(hasta);
  const paidBefore = { where: { paidAt: { lt: to } }, select: { id: true, amountCents: true, paidAt: true, note: true } };
  const [orders, expenses] = await Promise.all([
    db.purchaseOrder.findMany({
      where: {
        restaurantId,
        status: { in: ["received", "partially_received"] },
        createdAt: { lt: to },
        OR: [{ paidAt: null }, { payments: { some: { paidAt: { gte: to } } } }],
      },
      select: {
        ...PO_SELECT,
        payments: { ...paidBefore, select: { ...paidBefore.select, method: true } },
      },
      orderBy: { number: "asc" },
    }),
    db.expense.findMany({
      where: {
        restaurantId,
        recurring: false,
        date: { lt: to },
        OR: [{ paidAt: null }, { payments: { some: { paidAt: { gte: to } } } }],
      },
      select: {
        id: true,
        category: true,
        description: true,
        amountCents: true,
        date: true,
        dueAt: true,
        supplier: { select: { id: true, name: true, taxId: true } },
        payments: paidBefore,
      },
      orderBy: { date: "asc" },
    }),
  ]);
  const docs: CarteraDoc[] = [];
  for (const po of orders) {
    const d = poToDoc(po, to);
    if (d && d.outstandingCents > 0) docs.push(d);
  }
  for (const e of expenses) {
    const d = expenseToDoc(e);
    if (d.outstandingCents > 0) docs.push(d);
  }
  return docs;
}

// ─── Por cobrar ──────────────────────────────────────────────────────────

type CustomerRow = {
  id: string;
  customerName: string;
  docType: string;
  docNumber: string;
  verificationDigit: string | null;
};

function customerTaxId(c: CustomerRow): string {
  return c.docType === "NIT" && c.verificationDigit
    ? `${c.docNumber}-${c.verificationDigit}`
    : c.docNumber;
}

type StatementRow = {
  id: string;
  createdAt: Date;
  periodFrom: Date;
  periodTo: Date;
  creditCents: number;
  status: "open" | "paid";
  paidAt: Date | null;
  billingCustomer: CustomerRow;
};

/**
 * Corte de bonos → documento. La deuda es `creditCents` (lo redimido de
 * lotes a crédito, lo que cobra el link); lo prepagado ya estaba pagado.
 * Un corte se paga de una sola vez (`status = paid`, `paidAt`): al corte
 * está pendiente si sigue abierto o si se pagó DESPUÉS de `hasta`. No
 * hay plazo pactado: vence el día que se emite.
 */
function statementToDoc(s: StatementRow, to: Date): CarteraDoc {
  const date = isoDateUtc(s.createdAt);
  const pending = s.status === "open" || (s.paidAt != null && s.paidAt >= to);
  return {
    id: s.id,
    source: "voucher_statement",
    partnerId: s.billingCustomer.id,
    partnerName: s.billingCustomer.customerName,
    partnerTaxId: customerTaxId(s.billingCustomer),
    number: `${isoDateUtc(s.periodFrom)} – ${isoDateUtc(s.periodTo)}`,
    date,
    dueDate: date,
    totalCents: s.creditCents,
    outstandingCents: pending ? s.creditCents : 0,
  };
}

const STATEMENT_SELECT = {
  id: true,
  createdAt: true,
  periodFrom: true,
  periodTo: true,
  creditCents: true,
  status: true,
  paidAt: true,
  billingCustomer: {
    select: { id: true, customerName: true, docType: true, docNumber: true, verificationDigit: true },
  },
} as const;

// ── Ventas a crédito (Payment.method = customer_credit) ──────────────────

type CreditCustomerRow = CustomerRow & { creditTermsDays: number };

type CreditChargeRow = {
  id: string;
  settledAt: Date | null;
  createdAt: Date;
  amountCents: number;
  tipCents: number;
  refundedCents: number;
  order: { shortCode: string };
  billingCustomer: CreditCustomerRow | null;
};

type CreditAbonoRow = {
  id: string;
  billingCustomerId: string;
  paidAt: Date;
  amountCents: number;
  accountCode: string;
  note: string | null;
};

const CREDIT_CHARGE_SELECT = {
  id: true,
  settledAt: true,
  createdAt: true,
  amountCents: true,
  tipCents: true,
  refundedCents: true,
  order: { select: { shortCode: true } },
  billingCustomer: {
    select: {
      id: true,
      customerName: true,
      docType: true,
      docNumber: true,
      verificationDigit: true,
      creditTermsDays: true,
    },
  },
} as const;

const CREDIT_ABONO_SELECT = {
  id: true,
  billingCustomerId: true,
  paidAt: true,
  amountCents: true,
  accountCode: true,
  note: true,
} as const;

/** Estados que siguen pesando en la deuda (un cargo devuelto pesa 0 y no sale). */
const CREDIT_CHARGE_STATUSES = ["approved", "refunded"] as const;

/**
 * Cargos a crédito y abonos de UN cliente (ya filtrados al corte) →
 * documentos con saldo FIFO y abonos. Cada cargo es una cuenta cobrada a
 * crédito: vence a la fecha del cobro + el plazo del cliente. El saldo por
 * cargo sale de `allocateFifo`; cada abono se muestra bajo el primer cargo
 * que cubrió (o el último cargo, si pagó de más). Lo devuelto (refunds) se
 * descuenta con el valor de hoy, no al corte: aceptado.
 */
export function creditMovementsFor(
  customer: CreditCustomerRow,
  charges: readonly CreditChargeRow[],
  abonos: readonly CreditAbonoRow[],
): { docs: CarteraDoc[]; payments: CarteraPayment[] } {
  const creditCharges: CreditCharge[] = charges.map((c) => ({
    id: c.id,
    date: c.settledAt ?? c.createdAt,
    amountCents: c.amountCents,
    tipCents: c.tipCents,
    refundedCents: c.refundedCents,
  }));
  const creditAbonos: CreditAbono[] = abonos.map((a) => ({
    id: a.id,
    date: a.paidAt,
    amountCents: a.amountCents,
  }));
  const fifo = allocateFifo(creditCharges, creditAbonos);
  const outstanding = new Map(fifo.charges.map((c) => [c.chargeId, c.outstandingCents]));
  const docs: CarteraDoc[] = [];
  for (const c of charges) {
    const totalCents = chargeDebtCents(c);
    if (totalCents <= 0) continue;
    const date = isoDateUtc(c.settledAt ?? c.createdAt);
    docs.push({
      id: c.id,
      source: "customer_credit",
      partnerId: customer.id,
      partnerName: customer.customerName,
      partnerTaxId: customerTaxId(customer),
      number: c.order.shortCode,
      date,
      dueDate: addDays(date, customer.creditTermsDays),
      totalCents,
      outstandingCents: outstanding.get(c.id) ?? 0,
    });
  }
  const firstDoc = new Map<string, string>();
  for (const a of fifo.allocations) {
    if (!firstDoc.has(a.paymentId)) firstDoc.set(a.paymentId, a.chargeId);
  }
  const lastDocId = docs.length > 0 ? docs[docs.length - 1].id : null;
  const payments: CarteraPayment[] = [];
  for (const a of abonos) {
    const docId = firstDoc.get(a.id) ?? lastDocId;
    if (!docId) continue;
    payments.push({
      id: a.id,
      docId,
      date: isoDateUtc(a.paidAt),
      amountCents: a.amountCents,
      note: a.note ?? a.accountCode,
    });
  }
  return { docs, payments };
}

/** ¿Tiene el comercio el módulo de bonos? */
async function loadVouchersEnabled(restaurantId: string): Promise<boolean> {
  const r = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { enabledModules: true },
  });
  return r != null && isModuleEnabled(r.enabledModules, "vouchers");
}

/**
 * ¿Tiene el comercio alguna fuente de cuentas por cobrar? Bonos (módulo
 * activo) o crédito a clientes (algún cliente con crédito habilitado o
 * alguna cuenta ya cobrada a crédito).
 */
export async function loadReceivablesEnabled(restaurantId: string): Promise<boolean> {
  if (await loadVouchersEnabled(restaurantId)) return true;
  const [customers, charges] = await Promise.all([
    db.billingCustomer.count({ where: { restaurantId, creditEnabled: true } }),
    db.payment.count({
      where: { method: "customer_credit", billingCustomerId: { not: null }, order: { restaurantId } },
    }),
  ]);
  return customers > 0 || charges > 0;
}

/**
 * Documentos por cobrar con saldo al corte: cortes de bonos a crédito
 * (con el módulo `vouchers`) y cuentas cobradas a crédito a clientes de
 * facturación. `enabled: false` sólo cuando el comercio no tiene ninguna
 * de las dos fuentes (la UI explica que MESAPAY cobra al momento).
 */
export async function loadReceivableDocs(
  restaurantId: string,
  hasta: string,
): Promise<{ enabled: boolean; docs: CarteraDoc[] }> {
  const to = cutoffEnd(hasta);
  const [vouchersEnabled, creditCustomers, charges, abonos] = await Promise.all([
    loadVouchersEnabled(restaurantId),
    db.billingCustomer.count({ where: { restaurantId, creditEnabled: true } }),
    db.payment.findMany({
      where: {
        method: "customer_credit",
        status: { in: [...CREDIT_CHARGE_STATUSES] },
        billingCustomerId: { not: null },
        settledAt: { lt: to },
        order: { restaurantId },
      },
      select: CREDIT_CHARGE_SELECT,
      orderBy: [{ settledAt: "asc" }, { createdAt: "asc" }],
    }),
    db.customerCreditPayment.findMany({
      where: { restaurantId, paidAt: { lt: to } },
      select: CREDIT_ABONO_SELECT,
      orderBy: [{ paidAt: "asc" }, { createdAt: "asc" }],
    }),
  ]);
  const enabled = vouchersEnabled || creditCustomers > 0 || charges.length > 0;
  if (!enabled) return { enabled: false, docs: [] };

  const docs: CarteraDoc[] = [];
  if (vouchersEnabled) {
    const rows = await db.voucherStatement.findMany({
      where: {
        restaurantId,
        createdAt: { lt: to },
        creditCents: { gt: 0 },
        OR: [{ status: "open" }, { paidAt: { gte: to } }],
      },
      select: STATEMENT_SELECT,
      orderBy: { createdAt: "asc" },
    });
    for (const s of rows) {
      const d = statementToDoc(s, to);
      if (d.outstandingCents > 0) docs.push(d);
    }
  }
  // Crédito: se agrupa por cliente y se aplica FIFO por cliente.
  const byCustomer = new Map<string, { customer: CreditCustomerRow; charges: CreditChargeRow[]; abonos: CreditAbonoRow[] }>();
  for (const c of charges) {
    if (!c.billingCustomer) continue;
    const g = byCustomer.get(c.billingCustomer.id) ?? { customer: c.billingCustomer, charges: [], abonos: [] };
    g.charges.push(c);
    byCustomer.set(c.billingCustomer.id, g);
  }
  for (const a of abonos) byCustomer.get(a.billingCustomerId)?.abonos.push(a);
  for (const g of byCustomer.values()) {
    for (const d of creditMovementsFor(g.customer, g.charges, g.abonos).docs) {
      if (d.outstandingCents > 0) docs.push(d);
    }
  }
  return { enabled: true, docs };
}

// ─── Extracto por tercero ────────────────────────────────────────────────

export type CarteraPartner = {
  id: string;
  kind: CarteraKind;
  name: string;
  taxId: string | null;
  phone: string | null;
  email: string | null;
};

export type PartnerMovements = {
  partner: CarteraPartner;
  /** TODOS los documentos del tercero hasta el corte, saldados incluidos. */
  docs: CarteraDoc[];
  payments: CarteraPayment[];
};

/**
 * Historia completa de un tercero hasta el corte: documentos (con o sin
 * saldo) y abonos. `null` si el tercero no existe en el comercio. Para un
 * proveedor entran sus OC recibidas y sus gastos; el tercero sintético
 * `NO_SUPPLIER_ID` agrupa los gastos sin proveedor. Para un cliente, sus
 * cortes de bonos (el pago del corte es su abono) y sus cuentas cobradas a
 * crédito con los abonos que las cancelan.
 */
export async function loadPartnerMovements(
  restaurantId: string,
  kind: CarteraKind,
  partnerId: string,
  hasta: string,
): Promise<PartnerMovements | null> {
  const to = cutoffEnd(hasta);
  if (kind === "cxc") {
    const customer = await db.billingCustomer.findFirst({
      where: { id: partnerId, restaurantId },
      select: {
        id: true,
        customerName: true,
        docType: true,
        docNumber: true,
        verificationDigit: true,
        creditTermsDays: true,
        phone: true,
        email: true,
      },
    });
    if (!customer) return null;
    const vouchersEnabled = await loadVouchersEnabled(restaurantId);
    const [rows, charges, abonos] = await Promise.all([
      vouchersEnabled
        ? db.voucherStatement.findMany({
            where: { restaurantId, billingCustomerId: partnerId, createdAt: { lt: to }, creditCents: { gt: 0 } },
            select: STATEMENT_SELECT,
            orderBy: { createdAt: "asc" },
          })
        : Promise.resolve([] as StatementRow[]),
      db.payment.findMany({
        where: {
          billingCustomerId: partnerId,
          method: "customer_credit",
          status: { in: [...CREDIT_CHARGE_STATUSES] },
          settledAt: { lt: to },
          order: { restaurantId },
        },
        select: CREDIT_CHARGE_SELECT,
        orderBy: [{ settledAt: "asc" }, { createdAt: "asc" }],
      }),
      db.customerCreditPayment.findMany({
        where: { restaurantId, billingCustomerId: partnerId, paidAt: { lt: to } },
        select: CREDIT_ABONO_SELECT,
        orderBy: [{ paidAt: "asc" }, { createdAt: "asc" }],
      }),
    ]);
    const docs = rows.map((s) => statementToDoc(s, to));
    const payments: CarteraPayment[] = [];
    for (const s of rows) {
      if (s.status === "paid" && s.paidAt && s.paidAt < to) {
        payments.push({ id: `${s.id}:pago`, docId: s.id, date: isoDateUtc(s.paidAt), amountCents: s.creditCents, note: null });
      }
    }
    const credit = creditMovementsFor(customer, charges, abonos);
    docs.push(...credit.docs);
    payments.push(...credit.payments);
    return {
      partner: {
        id: customer.id,
        kind,
        name: customer.customerName,
        taxId: customerTaxId(customer),
        phone: customer.phone,
        email: customer.email,
      },
      docs,
      payments,
    };
  }

  const noSupplier = partnerId === NO_SUPPLIER_ID;
  const supplier = noSupplier
    ? null
    : await db.supplier.findFirst({
        where: { id: partnerId, restaurantId },
        select: { id: true, name: true, taxId: true, phone: true, email: true },
      });
  if (!noSupplier && !supplier) return null;

  const paidBefore = { where: { paidAt: { lt: to } }, select: { id: true, amountCents: true, paidAt: true, note: true }, orderBy: { paidAt: "asc" as const } };
  const [orders, expenses] = await Promise.all([
    noSupplier
      ? Promise.resolve([] as PoRow[])
      : db.purchaseOrder.findMany({
          where: {
            restaurantId,
            supplierId: partnerId,
            status: { in: ["received", "partially_received"] },
            createdAt: { lt: to },
          },
          select: {
            ...PO_SELECT,
            payments: { ...paidBefore, select: { ...paidBefore.select, method: true } },
          },
          orderBy: { number: "asc" },
        }),
    db.expense.findMany({
      where: {
        restaurantId,
        recurring: false,
        supplierId: noSupplier ? null : partnerId,
        date: { lt: to },
      },
      select: {
        id: true,
        category: true,
        description: true,
        amountCents: true,
        date: true,
        dueAt: true,
        supplier: { select: { id: true, name: true, taxId: true } },
        payments: paidBefore,
      },
      orderBy: { date: "asc" },
    }),
  ]);

  const docs: CarteraDoc[] = [];
  const payments: CarteraPayment[] = [];
  for (const po of orders) {
    const d = poToDoc(po, to);
    if (!d) continue;
    docs.push(d);
    payments.push(...paymentsOf(po.id, po.payments));
  }
  for (const e of expenses) {
    docs.push(expenseToDoc(e));
    payments.push(...paymentsOf(e.id, e.payments));
  }
  return {
    partner: {
      id: partnerId,
      kind,
      name: supplier?.name ?? "",
      taxId: supplier?.taxId ?? null,
      phone: supplier?.phone ?? null,
      email: supplier?.email ?? null,
    },
    docs,
    payments,
  };
}
