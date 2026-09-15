import type { Prisma } from "@prisma/client";
import { itemKitchenStatusData } from "./roundStatus";
import { recomputeRoundStatusInTx } from "./transition";

/**
 * MARCHADO AUTOMÁTICO ("marchar" = empezar a preparar / mandar a la
 * estación).
 *
 * Hoy un ítem nace "placed" ("Por preparar") y alguien tiene que tocarlo en
 * el tablero para pasarlo a "in_kitchen" ("Preparando") — y la comanda se
 * imprime SÓLO en esa transición. En un bar eso no tiene sentido: el
 * bartender no mira un tablero, quiere que el papel salga solo cuando llega
 * el pedido. Con `Restaurant.barAutoFire` (o `kitchenAutoFire`) activo, la
 * ronda recién creada marcha sola los ítems de esa estación.
 */

/** Las dos estaciones que preparan (y que imprimen comanda). "counter" nace listo. */
export type AutoFireStation = "kitchen" | "bar";

export type AutoFireFlags = { kitchenAutoFire: boolean; barAutoFire: boolean };

/**
 * Un grupo (estación, sub-estación de barra) marchado. Es la unidad que
 * imprime una comanda: la misma con la que el tablero llama a
 * `notifyAcceptedRoundTicketSafe`.
 */
export type FiredGroup = {
  station: AutoFireStation;
  barSubStation: string | null;
};

export type AutoFiredRound = { roundId: string; groups: FiredGroup[] };

/** Estaciones con marchado automático activo, en orden estable. */
export function autoFireStations(flags: AutoFireFlags): AutoFireStation[] {
  const out: AutoFireStation[] = [];
  if (flags.kitchenAutoFire) out.push("kitchen");
  if (flags.barAutoFire) out.push("bar");
  return out;
}

/**
 * Marcha los ítems "placed" de la ronda cuyas estaciones tienen auto-fire:
 * exactamente la transición que hace el tablero al tocar "Empezar"
 * (`in_kitchen` + cronómetro del plato) y el mismo recálculo de la ronda
 * (`Round.status` + `kitchenStartedAt`), vía las funciones compartidas de
 * ./roundStatus.ts y ./transition.ts.
 *
 * Devuelve los grupos (estación, sub-estación) que quedaron marchados para
 * que quien llama imprima DESPUÉS de commitear (ver ./autoFireTickets.ts);
 * acá adentro no se imprime nada.
 *
 *   - Sin flags no lee ni escribe nada: el camino queda igual que antes.
 *   - Sólo toca lo que está "placed". Lo que nació "ready" (refri, bar sin
 *     bartender), lo que ya estaba en preparación y lo cancelado quedan
 *     como están — por eso también es seguro llamarla sobre una ronda que
 *     ya se marchó: sale vacía.
 */
export async function autoFireRoundInTx(
  tx: Prisma.TransactionClient,
  args: { roundId: string; flags: AutoFireFlags; now: Date },
): Promise<FiredGroup[]> {
  const stations = autoFireStations(args.flags);
  if (stations.length === 0) return [];

  const items = await tx.orderItem.findMany({
    where: {
      roundId: args.roundId,
      cancelledAt: null,
      kitchenStatus: "placed",
      station: { in: stations },
    },
    select: {
      id: true,
      station: true,
      barSubStation: true,
      preparationStartedAt: true,
    },
  });
  if (items.length === 0) return [];

  for (const item of items) {
    await tx.orderItem.update({
      where: { id: item.id },
      data: itemKitchenStatusData(item, "in_kitchen", args.now),
    });
  }
  await recomputeRoundStatusInTx(tx, args.roundId, args.now);

  const groups: FiredGroup[] = [];
  for (const item of items) {
    const station = item.station as AutoFireStation;
    const barSubStation = item.barSubStation ?? null;
    const seen = groups.some(
      (g) => g.station === station && g.barSubStation === barSubStation,
    );
    if (!seen) groups.push({ station, barSubStation });
  }
  return groups;
}
