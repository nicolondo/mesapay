/**
 * CUENTA FACTURADA: qué se puede hacer con una cuenta que ya tiene factura
 * y todavía no se cobró (la "factura antes de cobrar", `preInvoice.ts`).
 *
 * ── La regla ────────────────────────────────────────────────────────────
 * Una factura numerada (y quizá ya aceptada por la DIAN e impresa en la
 * mano del cliente) no cambia en silencio. Por eso, desde que la cuenta
 * tiene factura y hasta que se cobra:
 *
 *   · NO se agregan platos ni líneas libres, NO se quitan (cancelar / no
 *     cobrar / mover a otra mesa), NO cambia el descuento. El servidor lo
 *     rechaza con `409 order_invoiced` (`OrderInvoicedError`), venga de la
 *     carta del comensal, de la app del mesero o del panel.
 *   · SÍ se cobra, con cualquier medio y en las partes que sea (dividida
 *     por persona, combinando medios, a crédito): UNA factura, varios
 *     pagos. Mover la cuenta entera a otra mesa también (no cambia lo
 *     facturado).
 *   · Si hay que corregirla, la factura se anula con una NOTA CRÉDITO
 *     (pantalla de Notas crédito). Con la factura anulada del todo la
 *     cuenta se puede cerrar sin cobrar (cortesía / el cliente se fue).
 *   · Si el cliente pide algo más después de la factura: se cobra esta
 *     cuenta y lo nuevo va en una cuenta nueva, que tiene su propia
 *     factura.
 *
 * Por qué no "una segunda factura por la diferencia": `SimpleInvoice` es
 * 1:1 con la orden (`orderId @unique`) y así lo leen la emisión a la DIAN,
 * las notas crédito, la reimpresión, los reportes de impuestos, la exógena
 * y la contabilidad (~60 accesos a `order.simpleInvoice`). Partir eso es
 * un cambio de modelo aparte; mientras tanto la cuenta facturada queda
 * CERRADA, que es lo seguro.
 */
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { formatInvoiceNumber, type InvoiceSnapshot } from "@/lib/invoice";
import { OrderInvoicedError } from "./orderInvoicedError";

type Client = Prisma.TransactionClient | typeof db;

/**
 * Dentro de la transacción que va a cambiar la cuenta (con la orden ya
 * bloqueada): si la cuenta tiene factura, lanza `OrderInvoicedError` y la
 * transacción entera se revierte.
 */
export async function assertOrderNotInvoicedInTx(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<void> {
  const inv = await tx.simpleInvoice.findUnique({
    where: { orderId },
    select: { id: true, invoiceNumber: true, snapshot: true },
  });
  if (!inv) return;
  throw new OrderInvoicedError({
    invoiceId: inv.id,
    documentNumber: formatInvoiceNumber(
      inv.snapshot as unknown as InvoiceSnapshot,
      inv.invoiceNumber,
    ),
  });
}

/**
 * ¿Notas crédito ACEPTADAS (no descartadas) cubren la factura entera? Es
 * la anulación: la factura deja de valer y la cuenta se puede cerrar sin
 * cobrar. Una nota parcial no alcanza.
 */
export async function isInvoiceAnnulled(
  client: Client,
  invoice: { id: string; totalCents: number },
): Promise<boolean> {
  const agg = await client.creditNote.aggregate({
    where: {
      originalInvoiceId: invoice.id,
      abandonedAt: null,
      dianDocument: { is: { state: "accepted" } },
    },
    _sum: { totalCents: true },
  });
  const credited = agg._sum.totalCents ?? 0;
  return credited > 0 && credited >= invoice.totalCents;
}

/** Estado de la factura de una cuenta, para las pantallas del staff. */
export type OrderInvoiceView = {
  invoiceId: string;
  documentNumber: string;
  /** Se emitió antes de cobrar (`snapshot.issuedBeforePayment`). */
  issuedBeforePayment: boolean;
  /**
   * Estado del documento DIAN, si el comercio factura electrónicamente:
   * `to_send | sent | pending | accepted | rejected | error`. null = sin
   * documento (comercio sin `einvoicing`).
   */
  dianState: string | null;
  /** Por qué no salió (bloqueo de configuración, error de la DIAN). */
  dianLastError: string | null;
  /** Notas crédito aceptadas cubren la factura entera. */
  annulled: boolean;
};

/** La vista de arriba, a partir de la fila (con su documento DIAN). */
export async function orderInvoiceViewOf(
  client: Client,
  inv: {
    id: string;
    invoiceNumber: number;
    snapshot: unknown;
    totalCents: number;
    dianDocument: { state: string; lastError: string | null } | null;
  } | null,
): Promise<OrderInvoiceView | null> {
  if (!inv) return null;
  const snap = inv.snapshot as InvoiceSnapshot;
  return {
    invoiceId: inv.id,
    documentNumber: formatInvoiceNumber(snap, inv.invoiceNumber),
    issuedBeforePayment: snap.issuedBeforePayment === true,
    dianState: inv.dianDocument?.state ?? null,
    dianLastError: inv.dianDocument?.lastError ?? null,
    annulled: await isInvoiceAnnulled(client, inv),
  };
}

/** El `select` que necesita `orderInvoiceViewOf`. */
export const ORDER_INVOICE_VIEW_SELECT = {
  id: true,
  invoiceNumber: true,
  snapshot: true,
  totalCents: true,
  dianDocument: { select: { state: true, lastError: true } },
} as const;

/** Carga la vista de la factura de una cuenta (null si no tiene). */
export async function loadOrderInvoiceView(
  orderId: string,
): Promise<OrderInvoiceView | null> {
  const inv = await db.simpleInvoice.findUnique({
    where: { orderId },
    select: ORDER_INVOICE_VIEW_SELECT,
  });
  return orderInvoiceViewOf(db, inv);
}
