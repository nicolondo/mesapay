// Simple in-process event bus for Server-Sent Events.
// Good for a single Node instance. For multi-instance we'd swap this for
// Postgres LISTEN/NOTIFY or a message broker.

type Listener = (e: OrderEvent) => void;

export type OrderEvent =
  | { type: "order.updated"; orderId: string }
  | { type: "order.ready"; orderId: string }
  | { type: "order.paid"; orderId: string }
  | { type: "order.cash_requested"; orderId: string; paymentId: string }
  | { type: "order.waiter_called"; orderId: string }
  | { type: "order.waiter_ack"; orderId: string }
  // Datáfono / Kushki Smart POS flow. terminal_requested fires when a
  // diner taps "Tarjeta con datáfono" and a Payment lands in pending state.
  // The terminal grid surfaces it; the diner sees the result via the
  // payment_* events.
  | { type: "order.terminal_requested"; orderId: string; paymentId: string; amountCents: number }
  | { type: "payment.approved"; orderId: string; paymentId: string }
  | { type: "payment.declined"; orderId: string; paymentId: string; reason?: string }
  // A specific round (a batch of items, usually a single dish) was
  // cancelled in the kitchen. Subscribers: customer order view (show
  // "tu plato fue cancelado" banner), waiter Salón (queue an ack).
  | { type: "order.round_cancelled"; orderId: string; roundId: string; reason: string }
  // A ticket is ready to be physically printed at a specific station.
  // Emitted on placed→in_kitchen for kitchen tickets, and on arrival
  // for bar tickets (the bar has no "start preparing" intermediate
  // beat). The print listener page at /operator/print/{station}
  // subscribes, fetches the ticket payload via API, and pushes it to
  // window.print(). barSubStation is set when the restaurant defined
  // sub-stations and the items belong to one — listeners filter on it
  // so a "Cocteles" printer only fires for cocteles.
  | {
      type: "ticket.printable";
      roundId: string;
      orderId: string;
      station: "kitchen" | "bar";
      barSubStation: string | null;
    }
  // La caja del comercio cambió: egreso/ingreso registrado, o un turno
  // (general o de mesero) se abrió/cerró. Lo consumen las vistas de caja
  // en tiempo real (operator Cierre, admin) para re-fetchear el snapshot.
  | { type: "cash.updated" };

const bus = new Map<string, Set<Listener>>(); // tenantId -> listeners

export function subscribeTenant(tenantId: string, fn: Listener) {
  let set = bus.get(tenantId);
  if (!set) {
    set = new Set();
    bus.set(tenantId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) bus.delete(tenantId);
  };
}

export function publishOrderEvent(tenantId: string, e: OrderEvent) {
  // ERP A4: una orden pagada dispara el consumo automático de inventario
  // fuera del request (el pago nunca espera ni falla por inventario; el
  // cron stock-consumption es el respaldo). Import perezoso para que las
  // rutas ligeras que publican eventos no carguen el ERP, y para evitar
  // ciclos de import.
  if (e.type === "order.paid") {
    setImmediate(() => {
      import("./erp/consumption")
        .then((m) => m.consumeOrderStock(e.orderId))
        .catch((err) =>
          console.error("[consumption] hook order.paid falló", err),
        );
    });
  }
  const set = bus.get(tenantId);
  if (!set) return;
  for (const fn of set) fn(e);
}
