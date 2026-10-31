import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { secureApi } from "@/lib/secureApi";
import { lockOrder } from "@/lib/orderLock";
import { publishOrderEvent } from "@/lib/events";
import { recordAuditEvent } from "@/lib/auditLog";
import { preparationHistoryData } from "@/lib/orders/cancellationPolicy";
import { recomputeRoundStatusInTx } from "@/lib/kds/transition";
import {
  SERVE_ALL_MAX_ITEMS,
  canServeAll,
  isServeAllCandidate,
  type ServeAllScope,
} from "@/lib/kds/serveAll";

/**
 * «Servir todo» del tablero de cocina / bar: marca como servido, en UNA
 * transacción, todo lo pendiente que el tablero tenía a la vista.
 *
 * El tablero manda la lista EXACTA de ids que mostraba al abrir la
 * confirmación. El servidor no busca "todo lo pendiente" por su cuenta: así
 * nada que haya entrado después de abrir la confirmación sale servido sin
 * que nadie lo haya visto. Cada id se valida contra el comercio activo, la
 * estación (y la sub-estación del bar), y que siga sin servir ni cancelar;
 * lo que no pasa se ignora y se cuenta como `skipped`.
 *
 * Por ítem hace lo mismo que el `PATCH /api/operator/order-items/[id]` con
 * `{ served: true }`: `servedAt`, `kitchenStatus = "ready"`, la historia de
 * preparación que protege la cancelación de platos ya preparados, el
 * re-cálculo del estado de la ronda y el roll-up a "served" de la ronda y del
 * pedido. Al final publica UN solo evento (no uno por ítem) y deja auditoría.
 */

const schema = z.object({
  station: z.enum(["kitchen", "bar"]),
  barSubStation: z.string().trim().min(1).max(120).nullable().optional(),
  itemIds: z.array(z.string().min(1).max(64)).min(1).max(SERVE_ALL_MAX_ITEMS),
});

const candidateSelect = {
  id: true,
  orderId: true,
  roundId: true,
  station: true,
  servedAt: true,
  cancelledAt: true,
  menuItemId: true,
  kitchenStatus: true,
  preparationStartedAt: true,
  preparationFirstStartedAt: true,
  order: { select: { restaurantId: true, table: { select: { kind: true } } } },
  round: { select: { status: true } },
  menuItem: { select: { category: { select: { barSubStation: true } } } },
} satisfies Prisma.OrderItemSelect;

function stationLabel(scope: ServeAllScope): string {
  if (scope.station === "kitchen") return "cocina";
  return scope.barSubStation ? `bar · ${scope.barSubStation}` : "bar";
}

async function POSTHandler(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // SOLO la administración del comercio. Cocina, bar y mesero siguen
  // sirviendo plato por plato con el PATCH individual; esto vacía el tablero
  // de un toque y por eso se reserva. El botón ni se muestra a otros roles,
  // pero el guard vive acá porque cualquiera puede pegarle a la API directo.
  if (!canServeAll(session.user.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const scope: ServeAllScope = {
    restaurantId,
    station: parsed.data.station,
    // La sub-estación existe sólo en el bar.
    barSubStation: parsed.data.station === "bar" ? parsed.data.barSubStation ?? null : null,
  };
  const requestedIds = Array.from(new Set(parsed.data.itemIds));

  // Primera lectura, fuera de la transacción: sólo para saber qué pedidos
  // hay que bloquear. El filtro por comercio va en la consulta misma, así que
  // un id de otro comercio ni siquiera se lee.
  const firstRead = await db.orderItem.findMany({
    where: { id: { in: requestedIds }, order: { restaurantId } },
    select: candidateSelect,
  });
  const orderIds = Array.from(
    new Set(firstRead.filter((i) => isServeAllCandidate(i, scope)).map((i) => i.orderId)),
  ).sort(); // orden fijo: dos llamadas simultáneas no se bloquean en cruz.

  if (orderIds.length === 0) {
    return NextResponse.json({ ok: true, served: 0, skipped: requestedIds.length });
  }

  const now = new Date();
  const result = await db.$transaction(
    async (tx) => {
      for (const orderId of orderIds) await lockOrder(tx, orderId);

      // Relectura con los pedidos ya bloqueados: lo que alguien más sirvió,
      // canceló o trasladó a otra mesa mientras tanto queda afuera.
      const fresh = await tx.orderItem.findMany({
        where: { id: { in: requestedIds }, orderId: { in: orderIds }, order: { restaurantId } },
        select: candidateSelect,
      });
      const items = fresh.filter((i) => isServeAllCandidate(i, scope));
      if (items.length === 0) return { itemIds: [], roundIds: [], orderIds: [] };

      // Mismo dato por ítem que el PATCH individual. Se agrupa por el dato a
      // escribir (casi todos comparten el mismo) para no hacer un UPDATE por
      // plato con un tablero lleno.
      const groups = new Map<string, { ids: string[]; data: Prisma.OrderItemUpdateManyMutationInput }>();
      for (const item of items) {
        const history = preparationHistoryData(item, { servedAt: now }, now, item.order.table.kind);
        const key = history.preparationFirstStartedAt?.toISOString() ?? "";
        const group = groups.get(key);
        if (group) group.ids.push(item.id);
        else
          groups.set(key, {
            ids: [item.id],
            // Servir implica que la estación terminó el plato.
            data: { servedAt: now, kitchenStatus: "ready", ...history },
          });
      }
      for (const { ids, data } of groups.values()) {
        await tx.orderItem.updateMany({
          where: { id: { in: ids }, servedAt: null, cancelledAt: null },
          data,
        });
      }

      // Roll-up de rondas: re-derivar el estado desde los ítems (misma regla
      // que el PATCH y el marchado automático) y, si ya no queda nada vivo
      // sin servir, la ronda pasa a "served". Los pedidos están bloqueados,
      // así que esta lectura ve el estado fresco.
      const roundIds = Array.from(new Set(items.map((i) => i.roundId!)));
      for (const roundId of roundIds) {
        await recomputeRoundStatusInTx(tx, roundId, now);
        const siblings = await tx.orderItem.findMany({
          where: { roundId, cancelledAt: null },
          select: { servedAt: true },
        });
        if (siblings.length > 0 && siblings.every((s) => !!s.servedAt)) {
          await tx.round.update({ where: { id: roundId }, data: { status: "served" } });
        }
      }

      // Pedido entero servido si todas sus rondas (no canceladas) lo están.
      // Nunca pisa un pedido pagado, cobrándose o cancelado.
      const touchedOrderIds = Array.from(new Set(items.map((i) => i.orderId)));
      for (const orderId of touchedOrderIds) {
        const rounds = await tx.round.findMany({ where: { orderId }, select: { status: true } });
        if (rounds.every((r) => r.status === "served" || r.status === "cancelled")) {
          await tx.order.updateMany({
            where: { id: orderId, status: { notIn: ["paid", "paying", "cancelled"] } },
            data: { status: "served", servedAt: now },
          });
        }
      }

      return { itemIds: items.map((i) => i.id), roundIds, orderIds: touchedOrderIds };
    },
    { timeout: 20_000 },
  );

  const served = result.itemIds.length;
  if (served > 0) {
    // UN solo evento para todo el lote: los tableros (cocina, bar, salón)
    // refrescan con cualquier evento, y un evento por plato los haría
    // recargar decenas de veces seguidas. Los comensales igual se enteran:
    // cada pedido que cambió de estado ya emitió su propio aviso desde la
    // base (trigger de "Order").
    publishOrderEvent(restaurantId, { type: "order.updated", orderId: result.orderIds[0] });
    await recordAuditEvent({
      kind: "order_item.serve_all",
      restaurantId,
      // Quién: explícito desde la sesión que pasó el guard de arriba.
      actor: {
        userId: session.user.id ?? null,
        email: session.user.email ?? "",
        role: session.user.role,
      },
      target: { type: "station", id: scope.barSubStation ? `bar:${scope.barSubStation}` : scope.station },
      summary: `Sirvió todo en ${stationLabel(scope)}: ${served} ${served === 1 ? "plato" : "platos"} de ${result.orderIds.length} ${result.orderIds.length === 1 ? "pedido" : "pedidos"}`,
      diff: {
        after: {
          station: scope.station,
          barSubStation: scope.barSubStation,
          itemCount: served,
          orderCount: result.orderIds.length,
          roundCount: result.roundIds.length,
          skipped: requestedIds.length - served,
          itemIds: result.itemIds,
        },
      },
    });
  }

  return NextResponse.json({ ok: true, served, skipped: requestedIds.length - served });
}

export const POST = secureApi(POSTHandler);
