import { db } from "./db";

// PostgreSQL-backed invalidations shared by every application process.

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

type Channel = { listeners: Set<Listener>; stop: () => void };
const channels = new Map<string, Channel>();

export function subscribeTenant(tenantId: string, fn: Listener) {
  let channel = channels.get(tenantId);
  if (!channel) {
    const listeners = new Set<Listener>();
    const seen = new Map<string, number>();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Overlap covers events allocated inside transactions that commit out of order.
    const began = Date.now() - 60_000;
    const subscribedAt = Date.now();
    const poll = async () => {
      try {
        const since = Math.max(began, Date.now() - 120_000);
        let cursor: bigint | undefined;
        for (;;) {
          const rows = await db.platformEvent.findMany({
            where: { restaurantId: tenantId, createdAt: { gte: new Date(since) }, ...(cursor ? { id: { gt: cursor } } : {}) },
            orderBy: { id: "asc" }, take: 500,
          });
          if (stopped) return;
          for (const row of rows) {
            const key = row.id.toString();
            if (!seen.has(key)) {
              seen.set(key, row.createdAt.getTime());
              for (const listener of listeners) {
                try {
                  const event = row.payload as OrderEvent;
                  // Historical print signals must never trigger a second physical ticket.
                  if (event.type === "ticket.printable" && row.createdAt.getTime() < subscribedAt) continue;
                  listener(event);
                } catch (error) { console.error("event_listener_failed", error); }
              }
            }
          }
          if (rows.length < 500) break;
          cursor = rows[rows.length - 1].id;
        }
        for (const [id, createdAt] of seen) if (createdAt < since) seen.delete(id);
      } catch (error) { console.error("event_poll_failed", error); }
      finally { if (!stopped) timer = setTimeout(poll, 1000); }
    };
    channel = { listeners, stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
    channels.set(tenantId, channel);
    timer = setTimeout(poll, 0);
  }
  channel.listeners.add(fn);
  return () => {
    channel!.listeners.delete(fn);
    if (!channel!.listeners.size) { channel!.stop(); channels.delete(tenantId); }
  };
}

/** Specific UI events augment the transactionally recorded order invalidations. */
export function publishOrderEvent(tenantId: string, event: OrderEvent) {
  void db.platformEvent.create({ data: { restaurantId: tenantId, orderId: "orderId" in event ? event.orderId : null, payload: event } }).catch(error => console.error("event_publish_failed", error));
  // The paid order itself is the durable inventory work item; the cron retries it.
  if (event.type === "order.paid") {
    void import("./erp/consumption").then(m => m.consumeOrderStock(event.orderId)).catch(error => console.error("stock_pending", error));
  }
}
