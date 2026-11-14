/**
 * Ventas a crédito vistas desde Órdenes, el detalle de la orden y Cobros.
 *
 * Una cuenta cobrada «a crédito» (`Payment.method = customer_credit`,
 * aprobado) queda PAGADA para la mesa, la cocina y la factura, pero no entró
 * plata: es deuda del cliente de facturación (Cartera). Sin un distintivo, en
 * la lista se ve igual que una cuenta cobrada en efectivo. Acá se decide qué
 * distintivo lleva:
 *
 *   · `on_credit`   «A crédito»: se cobró (toda o una parte) a crédito y el
 *                   cliente todavía debe algo de ese cargo — o no se puede
 *                   saber (un cargo sin cliente) o el cargo quedó en cero por
 *                   devoluciones / notas crédito (se cobró a crédito, nada
 *                   más; el detalle muestra la nota).
 *   · `credit_paid` «Crédito pagado»: el cliente ya pagó en Cartera todo lo
 *                   que se le cargó en esta cuenta.
 *
 * «Ya pagó» sale de la MISMA regla que Cartera y el estado de cuenta del
 * cliente: sus abonos no se ligan a un cobro, se aplican FIFO al cargo más
 * viejo (`allocateFifo` de `customerCredit.ts`). Por eso hacen falta TODOS
 * los cargos y abonos del cliente, no sólo los de la cuenta: un abono de hoy
 * cancela primero la deuda más vieja. La consulta (`creditSaleQuery.ts`) los
 * pide sólo para los clientes de las cuentas a la vista: es barato.
 *
 * Un abono DIRIGIDO (`chargeId`: el link de pago de una factura manual
 * emitida por cobrar, o «Registrar pago recibido» en su ficha) va primero a
 * su cargo; lo que sobre sigue el FIFO (también lo resuelve `allocateFifo`).
 * En Órdenes, esa factura muestra su propia píldora (Por cobrar / Vencida /
 * Cobrada) en lugar de este distintivo.
 *
 * Sólo los cargos `approved` marcan la cuenta. Uno devuelto por completo
 * (`refunded`) ya no es una venta a crédito, pero sí entra en el FIFO del
 * cliente (pesa 0), igual que en Cartera.
 *
 * Lógica pura (sin DB): la prueban los tests.
 */
import { allocateFifo, chargeDebtCents, type CreditAbono, type CreditCharge } from "@/lib/customerCredit";

/** Método de pago de las ventas a crédito. */
export const CREDIT_SALE_METHOD = "customer_credit" as const;

export type CreditSaleStatus = "on_credit" | "credit_paid";

/** Un cobro a crédito, con su cuenta y su cliente. */
export type CreditSaleCharge = CreditCharge & {
  orderId: string;
  billingCustomerId: string | null;
  /** `approved` o `refunded` (el devuelto entero pesa 0). */
  status: string;
};

/** Un abono de un cliente a su deuda. */
export type CreditSaleAbono = CreditAbono & { billingCustomerId: string };

export type CreditSale = {
  status: CreditSaleStatus;
  /** Lo cargado a crédito en la cuenta (con propina), neto de devoluciones y notas crédito. */
  creditCents: number;
  /** Lo que el cliente todavía debe de esos cargos. */
  outstandingCents: number;
  /** A quién se le cargó (el primero, si hubiera varios). */
  billingCustomerId: string | null;
};

/**
 * Ventas a crédito de las cuentas `orderIds`, a partir de los cargos y
 * abonos de SUS clientes (todos, para que el FIFO sea el de Cartera). Una
 * cuenta sin cargo a crédito aprobado no aparece en el resultado.
 */
export function creditSalesByOrder(
  orderIds: Iterable<string>,
  charges: readonly CreditSaleCharge[],
  abonos: readonly CreditSaleAbono[],
): Map<string, CreditSale> {
  const wanted = new Set(orderIds);

  // Saldo de cada cargo según los abonos de su cliente (FIFO).
  const outstanding = new Map<string, { total: number; paid: number; left: number }>();
  const byCustomer = new Map<string, CreditSaleCharge[]>();
  for (const c of charges) {
    if (!c.billingCustomerId) {
      // Sin cliente no hay abonos que aplicarle: debe todo.
      const total = chargeDebtCents(c);
      outstanding.set(c.id, { total, paid: 0, left: total });
      continue;
    }
    const list = byCustomer.get(c.billingCustomerId) ?? [];
    list.push(c);
    byCustomer.set(c.billingCustomerId, list);
  }
  const abonosByCustomer = new Map<string, CreditSaleAbono[]>();
  for (const a of abonos) {
    const list = abonosByCustomer.get(a.billingCustomerId) ?? [];
    list.push(a);
    abonosByCustomer.set(a.billingCustomerId, list);
  }
  for (const [customerId, list] of byCustomer) {
    const fifo = allocateFifo(list, abonosByCustomer.get(customerId) ?? []);
    for (const c of fifo.charges) {
      outstanding.set(c.chargeId, { total: c.totalCents, paid: c.paidCents, left: c.outstandingCents });
    }
  }

  // Por cuenta: sólo los cargos aprobados de las cuentas pedidas.
  const acc = new Map<string, { credit: number; paid: number; left: number; customer: string | null }>();
  for (const c of charges) {
    if (c.status !== "approved" || !wanted.has(c.orderId)) continue;
    const s = outstanding.get(c.id) ?? { total: 0, paid: 0, left: 0 };
    const row = acc.get(c.orderId) ?? { credit: 0, paid: 0, left: 0, customer: c.billingCustomerId };
    row.credit += s.total;
    row.paid += s.paid;
    row.left += s.left;
    acc.set(c.orderId, row);
  }

  const out = new Map<string, CreditSale>();
  for (const [orderId, row] of acc) {
    out.set(orderId, {
      status: creditSaleStatus(row),
      creditCents: row.credit,
      outstandingCents: row.left,
      billingCustomerId: row.customer,
    });
  }
  return out;
}

/**
 * «Crédito pagado» sólo si no queda nada por cobrar Y el cliente abonó algo
 * de esa cuenta. Un cargo que quedó en cero sin abonos (devuelto o anulado
 * con nota crédito) sigue siendo «A crédito»: no se pagó, se anuló.
 */
export function creditSaleStatus(s: { paid: number; left: number }): CreditSaleStatus {
  return s.left <= 0 && s.paid > 0 ? "credit_paid" : "on_credit";
}

/** ¿La cuenta tiene algún cobro a crédito aprobado? (lista de Mesas) */
export function hasCreditSale(payments: readonly { method: string; status?: string | null }[]): boolean {
  return payments.some(
    (p) => p.method === CREDIT_SALE_METHOD && (p.status == null || p.status === "approved"),
  );
}
