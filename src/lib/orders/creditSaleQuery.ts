import "server-only";
import { db } from "@/lib/db";
import {
  CREDIT_SALE_METHOD,
  creditSalesByOrder,
  type CreditSale,
  type CreditSaleAbono,
  type CreditSaleCharge,
} from "./creditSale";

/** Cargos que pesan en la deuda (como en `customerCredit` y Cartera). */
const CHARGE_STATUSES = ["approved", "refunded"] as const;

const CHARGE_SELECT = {
  id: true,
  orderId: true,
  billingCustomerId: true,
  status: true,
  settledAt: true,
  createdAt: true,
  amountCents: true,
  tipCents: true,
  refundedCents: true,
  creditNoteCents: true,
} as const;

type ChargeRow = {
  id: string;
  orderId: string;
  billingCustomerId: string | null;
  status: string;
  settledAt: Date | null;
  createdAt: Date;
  amountCents: number;
  tipCents: number;
  refundedCents: number;
  creditNoteCents: number;
};

const toCharge = (p: ChargeRow): CreditSaleCharge => ({
  id: p.id,
  orderId: p.orderId,
  billingCustomerId: p.billingCustomerId,
  status: p.status,
  date: p.settledAt ?? p.createdAt,
  amountCents: p.amountCents,
  tipCents: p.tipCents,
  refundedCents: p.refundedCents,
  creditNoteCents: p.creditNoteCents,
});

export type CreditSaleView = CreditSale & { customerName: string | null };

/**
 * Venta a crédito de cada cuenta de `orderIds` (las de una página de
 * Órdenes o Cobros, o una sola en el detalle). Las cuentas sin cobro a
 * crédito no aparecen.
 *
 * 1. Los cobros a crédito aprobados de esas cuentas (por índice de orderId).
 *    Si no hay ninguno —lo normal—, termina acá: una sola consulta.
 * 2. Para sus clientes, TODOS sus cargos y abonos, porque el abono se aplica
 *    FIFO a la deuda más vieja (ver `creditSale.ts`). Por índice de
 *    `billingCustomerId`, y sólo de los clientes que aparecen en pantalla.
 */
export async function loadCreditSales(
  restaurantId: string,
  orderIds: readonly string[],
): Promise<Map<string, CreditSaleView>> {
  if (orderIds.length === 0) return new Map();
  const onScreen = await db.payment.findMany({
    where: {
      orderId: { in: [...orderIds] },
      method: CREDIT_SALE_METHOD,
      status: "approved",
      order: { restaurantId },
    },
    select: { ...CHARGE_SELECT, billingCustomer: { select: { customerName: true } } },
  });
  if (onScreen.length === 0) return new Map();

  const names = new Map<string, string>();
  for (const p of onScreen) {
    if (p.billingCustomerId && p.billingCustomer) names.set(p.billingCustomerId, p.billingCustomer.customerName);
  }
  const customerIds = [...new Set(onScreen.flatMap((p) => (p.billingCustomerId ? [p.billingCustomerId] : [])))];
  const [charges, abonos] = customerIds.length
    ? await Promise.all([
        db.payment.findMany({
          where: {
            billingCustomerId: { in: customerIds },
            method: CREDIT_SALE_METHOD,
            status: { in: [...CHARGE_STATUSES] },
            order: { restaurantId },
          },
          select: CHARGE_SELECT,
        }),
        db.customerCreditPayment.findMany({
          where: { restaurantId, billingCustomerId: { in: customerIds } },
          // creditChargeId: el abono DIRIGIDO a un cargo (link de pago de una
          // factura manual) va a ése antes que al FIFO, como en Cartera.
          select: { id: true, billingCustomerId: true, paidAt: true, amountCents: true, creditChargeId: true },
        }),
      ])
    : [[], []];

  // Los cargos sin cliente (no deberían existir) entran tal cual.
  const all: CreditSaleCharge[] = [
    ...charges.map(toCharge),
    ...onScreen.filter((p) => !p.billingCustomerId).map(toCharge),
  ];
  const credits: CreditSaleAbono[] = abonos.map((a) => ({
    id: a.id,
    billingCustomerId: a.billingCustomerId,
    date: a.paidAt,
    amountCents: a.amountCents,
    chargeId: a.creditChargeId,
  }));

  const sales = creditSalesByOrder(orderIds, all, credits);
  const out = new Map<string, CreditSaleView>();
  for (const [orderId, sale] of sales) {
    out.set(orderId, {
      ...sale,
      customerName: sale.billingCustomerId ? names.get(sale.billingCustomerId) ?? null : null,
    });
  }
  return out;
}
