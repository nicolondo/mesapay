import type { Prisma } from "@prisma/client";
import {
  orderReviewFlags,
  type ReviewFlag,
  type ReviewFlagKind,
} from "./orderReviewFlags";

/**
 * Lo que las pantallas del personal necesitan para avisar «Revisar» sobre
 * una cuenta (src/lib/orderReviewFlags.ts) y decir de dónde viene su
 * descuento. Serializable: viaja del servidor a los componentes cliente.
 */
export type OrderReviewView = {
  flags: ReviewFlagKind[];
  /** Cliente de facturación cuyo descuento tiene la cuenta (señal 1). */
  customerName: string | null;
  discountPct: number | null;
  /** ISO: cuándo se aplicó el descuento del cliente. */
  discountAppliedAt: string | null;
  /** ISO: desde cuándo está abierta la cuenta. */
  openedAt: string;
};

/**
 * Origen del descuento de la cuenta, para la línea «Descuento del cliente X
 * 20 %» / «Descuento del comensal Y 20 %». null = sin origen conocido
 * (cuentas anteriores a la columna): texto genérico.
 */
export type DiscountOriginView =
  | { kind: "customer"; name: string }
  | { kind: "diner"; name: string }
  | null;

/** Lo que hay que leer de una cuenta para evaluarla. */
export const ORDER_REVIEW_SELECT = {
  status: true,
  createdAt: true,
  discountCents: true,
  discountPct: true,
  discountBillingCustomerId: true,
  discountAppliedAt: true,
  reviewAckAt: true,
  table: { select: { number: true, kind: true } },
  discountBillingCustomer: { select: { customerName: true } },
  rounds: { select: { placedAt: true, status: true } },
  payments: { select: { status: true, createdAt: true } },
} satisfies Prisma.OrderSelect;

type SelectedRow = Prisma.OrderGetPayload<{ select: typeof ORDER_REVIEW_SELECT }>;
/** La fila leída con ORDER_REVIEW_SELECT (o cualquier cosa con esa forma). */
export type OrderReviewRow = Omit<SelectedRow, "status" | "rounds" | "payments" | "table"> & {
  status: string;
  table: { number: number; kind: string };
  rounds: ReadonlyArray<{ placedAt: Date; status: string }>;
  payments: ReadonlyArray<{ status: string; createdAt: Date }>;
};

export function reviewFlagsOf(row: OrderReviewRow, opts: { newRoundAt?: Date } = {}): ReviewFlag[] {
  return orderReviewFlags(
    {
      status: row.status,
      tableNumber: row.table.number,
      tableKind: row.table.kind,
      discountCents: row.discountCents,
      discountPct: row.discountPct,
      discountBillingCustomerId: row.discountBillingCustomerId,
      discountAppliedAt: row.discountAppliedAt,
      reviewAckAt: row.reviewAckAt,
      rounds: row.rounds,
      payments: row.payments,
    },
    opts,
  );
}

export function orderReviewViewOf(
  row: OrderReviewRow,
  opts: { newRoundAt?: Date } = {},
): OrderReviewView | null {
  const flags = reviewFlagsOf(row, opts);
  if (!flags.length) return null;
  return {
    flags: flags.map((f) => f.kind),
    customerName: row.discountBillingCustomer?.customerName ?? null,
    discountPct: row.discountPct,
    discountAppliedAt: row.discountAppliedAt?.toISOString() ?? null,
    openedAt: row.createdAt.toISOString(),
  };
}

export function discountOriginOf(order: {
  discountCents: number;
  discountBillingCustomer: { customerName: string } | null;
  diner: { name: string | null; email: string } | null;
}): DiscountOriginView {
  if (order.discountCents <= 0) return null;
  if (order.discountBillingCustomer) {
    return { kind: "customer", name: order.discountBillingCustomer.customerName };
  }
  if (order.diner) return { kind: "diner", name: order.diner.name ?? order.diner.email };
  return null;
}

/** Lee la cuenta y arma el aviso; null si no hay nada que revisar. */
export async function loadOrderReview(
  client: Pick<Prisma.TransactionClient, "order">,
  orderId: string,
  opts: { newRoundAt?: Date } = {},
): Promise<OrderReviewView | null> {
  const row = await client.order.findUnique({ where: { id: orderId }, select: ORDER_REVIEW_SELECT });
  return row ? orderReviewViewOf(row, opts) : null;
}
