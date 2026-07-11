import { db } from "@/lib/db";

// Timestamp (epoch ms) del último ítem que "entró" a cada tablero. 0 = nada.
// Alimenta el punto rojo de la nav (ver BoardDot).
export type BoardActivity = { kitchen: number; bar: number; floor: number };

/**
 * Última actividad por tablero de un comercio:
 *  - kitchen/bar: último ítem VIVO (no cancelado, no servido, ronda no
 *    cancelada) ruteado a esa estación → "entró un pedido".
 *  - floor (Salón/servir): última ronda que quedó LISTA para entregar.
 *
 * Se llama desde el layout (server) en cada render; como el layout se
 * refresca en cada evento SSE (LiveRefresh), el valor queda casi en vivo.
 * Nunca debe tumbar la nav: ante error, devuelve ceros.
 */
export async function computeBoardActivity(
  restaurantId: string,
  hasBar: boolean,
): Promise<BoardActivity> {
  // Última ronda (placedAt = envío a cocina) NO cancelada con ≥1 ítem vivo
  // ruteado a esa estación.
  const stationLatest = (station: "kitchen" | "bar") =>
    db.round.findFirst({
      where: {
        status: { not: "cancelled" },
        order: { restaurantId },
        items: { some: { station, cancelledAt: null, servedAt: null } },
      },
      orderBy: { placedAt: "desc" },
      select: { placedAt: true },
    });

  try {
    const [kitchen, bar, floor] = await Promise.all([
      stationLatest("kitchen"),
      hasBar ? stationLatest("bar") : Promise.resolve(null),
      db.round.findFirst({
        where: { status: "ready", order: { restaurantId } },
        orderBy: { readyAt: "desc" },
        select: { readyAt: true },
      }),
    ]);
    return {
      kitchen: kitchen?.placedAt?.getTime() ?? 0,
      bar: bar?.placedAt?.getTime() ?? 0,
      floor: floor?.readyAt?.getTime() ?? 0,
    };
  } catch {
    return { kitchen: 0, bar: 0, floor: 0 };
  }
}
