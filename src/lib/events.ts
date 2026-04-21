// Simple in-process event bus for Server-Sent Events.
// Good for a single Node instance. For multi-instance we'd swap this for
// Postgres LISTEN/NOTIFY or a message broker.

type Listener = (e: OrderEvent) => void;

export type OrderEvent =
  | { type: "order.updated"; orderId: string }
  | { type: "order.ready"; orderId: string }
  | { type: "order.paid"; orderId: string }
  | { type: "order.cash_requested"; orderId: string; paymentId: string };

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
  const set = bus.get(tenantId);
  if (!set) return;
  for (const fn of set) fn(e);
}
