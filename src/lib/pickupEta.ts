import { db } from "./db";

// Minimum promise so we never say "listo en 0 minutos" even on an empty
// kitchen. The moment a customer hits pay the order still has to be printed,
// acknowledged, and plated — five minutes is a safe floor.
const MIN_ETA_MINUTES = 5;

// Cap what we display. If the queue is genuinely longer than this the
// restaurant has a capacity problem we can't paper over with a fake ETA.
const MAX_ETA_MINUTES = 90;

export type EtaItemInput = { menuItemId: string; qty: number };

export async function computeQueueMinutes(restaurantId: string): Promise<number> {
  // Count any prep work already owed to other customers: items on orders that
  // are placed or actively cooking but not yet ready. This assumes a single
  // kitchen line and sums serially — conservative by design, because
  // underpromising and delivering late is worse than overpromising.
  const rows = await db.orderItem.findMany({
    where: {
      order: {
        restaurantId,
        status: { in: ["placed", "in_kitchen"] },
      },
      kitchenStatus: { in: ["placed", "in_kitchen"] },
      roundId: { not: null },
    },
    select: { qty: true, menuItem: { select: { prepMinutes: true } } },
  });
  const total = rows.reduce(
    (sum, r) => sum + r.qty * r.menuItem.prepMinutes,
    0,
  );
  return total;
}

export async function computeOrderMinutes(
  restaurantId: string,
  items: EtaItemInput[],
): Promise<number> {
  if (items.length === 0) return 0;
  const ids = Array.from(new Set(items.map((i) => i.menuItemId)));
  const rows = await db.menuItem.findMany({
    where: { id: { in: ids }, restaurantId },
    select: { id: true, prepMinutes: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r.prepMinutes]));
  return items.reduce((sum, it) => {
    const prep = byId.get(it.menuItemId) ?? 10;
    return sum + prep * it.qty;
  }, 0);
}

export async function computeEtaMinutes(
  restaurantId: string,
  items: EtaItemInput[],
): Promise<number> {
  const [queue, order] = await Promise.all([
    computeQueueMinutes(restaurantId),
    computeOrderMinutes(restaurantId, items),
  ]);
  const raw = queue + order;
  return Math.min(MAX_ETA_MINUTES, Math.max(MIN_ETA_MINUTES, raw));
}
