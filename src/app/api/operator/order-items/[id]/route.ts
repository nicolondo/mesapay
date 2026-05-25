import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { publishOrderEvent } from "@/lib/events";
import { sendPushToMeserosForTable } from "@/lib/push";

const schema = z
  .object({
    served: z.boolean().optional(),
    kitchenStatus: z.enum(["placed", "in_kitchen", "ready"]).optional(),
    // "Apurar" — el mesero le dice a cocina que este plato es urgente
    // porque el cliente está preguntando. true = setea timestamp now.
    // No hay forma de "des-apurar" — una vez marcado queda hasta que
    // el item se mueve a ready (el badge desaparece naturalmente).
    expedite: z.literal(true).optional(),
    // Cancelar este item específico (distinto a cancelar la ronda).
    // Cuando el cliente pide "saca el lomito pero deja los demás",
    // el mesero usa esto desde el detail sheet. Recompute del
    // subtotal corre en la misma transacción.
    cancel: z
      .object({
        reason: z.string().trim().min(3).max(240),
      })
      .optional(),
  })
  .refine(
    (d) =>
      d.served !== undefined ||
      d.kitchenStatus !== undefined ||
      d.expedite !== undefined ||
      d.cancel !== undefined,
    { message: "served, kitchenStatus, expedite or cancel required" },
  );

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  // Quién toca esta API:
  // - operator/platform_admin: gestión general.
  // - kitchen/bar: marcan items como listos (kitchenStatus=ready).
  // - mesero: marca items como entregados (served=true) desde Salón.
  // Sin mesero acá el "Entregar" del PWA mesero caía a 401 y el
  // frontend lo borraba optimistamente — el item quedaba zombie en
  // DB, sin entregar.
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin" &&
      session.user.role !== "kitchen" &&
      session.user.role !== "bar" &&
      session.user.role !== "mesero")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const item = await db.orderItem.findUnique({
    where: { id },
    include: { order: true },
  });
  if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });
  const activeId = await getActiveRestaurantId();
  if (item.order.restaurantId !== activeId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let becameRoundReady = false;

  await db.$transaction(async (tx) => {
    const now = new Date();

    if (parsed.data.cancel) {
      // Cancelación del item. Idempotente: si ya estaba cancelado no
      // re-pisamos timestamps ni recalculamos. Si no, marcamos y
      // re-derivamos el subtotal de la orden a partir de los items
      // vivos restantes (excluye este recién cancelado por el WHERE).
      if (!item.cancelledAt) {
        await tx.orderItem.update({
          where: { id: item.id },
          data: {
            cancelledAt: now,
            cancellationReason: parsed.data.cancel.reason,
            cancelledByEmail: session.user.email,
          },
        });
        // Re-derivar subtotal — el item recién cancelado ya tiene
        // cancelledAt != null, así que el WHERE de items vivos lo
        // saca.
        const liveItems = await tx.orderItem.findMany({
          where: {
            orderId: item.order.id,
            cancelledAt: null,
            OR: [
              { roundId: null },
              { round: { status: { not: "cancelled" } } },
            ],
          },
          select: { qty: true, priceCentsSnapshot: true },
        });
        const liveSubtotal = liveItems.reduce(
          (s, i) => s + i.priceCentsSnapshot * i.qty,
          0,
        );
        // No tocamos el subtotal si la orden ya está paga — sería
        // una orden cerrada y mover el subtotal implicaría refund
        // que no modelamos acá.
        if (item.order.status !== "paid" && item.order.status !== "paying") {
          await tx.order.update({
            where: { id: item.order.id },
            data: {
              subtotalCents: liveSubtotal,
              totalCents: liveSubtotal + item.order.tipCents,
            },
          });
        }
      }
      // Si la cancelación era el único item activo del round,
      // mover el round a "cancelled" para que el kitchen board lo
      // saque del flujo. UX coherente: si la última cosa del round
      // se canceló, la ronda entera está cancelada.
      if (item.roundId) {
        const remaining = await tx.orderItem.count({
          where: { roundId: item.roundId, cancelledAt: null },
        });
        if (remaining === 0) {
          await tx.round.update({
            where: { id: item.roundId },
            data: {
              status: "cancelled",
              cancelledAt: now,
              cancelledByEmail: session.user.email,
              cancellationReason: parsed.data.cancel.reason,
            },
          });
        }
      }
      // Skip todas las otras ramas — cancelar es exclusivo.
      return;
    }

    if (parsed.data.expedite === true && !item.expediteRequestedAt) {
      // Solo registramos el primer apurón — clicks repetidos no
      // re-pisan el timestamp ni cambian el email. El badge en el
      // kitchen board se mantiene hasta que el item pasa a ready.
      await tx.orderItem.update({
        where: { id: item.id },
        data: {
          expediteRequestedAt: now,
          expediteRequestedByEmail: session.user.email,
        },
      });
    }

    if (parsed.data.kitchenStatus !== undefined) {
      const updates: {
        kitchenStatus: typeof parsed.data.kitchenStatus;
        preparationStartedAt?: Date | null;
      } = { kitchenStatus: parsed.data.kitchenStatus };
      // First time entering "in_kitchen" → start the prep timer. Going
      // back to placed wipes the timer; subsequent "in_kitchen" hits
      // restart it. This is what feeds the bar countdown.
      if (
        parsed.data.kitchenStatus === "in_kitchen" &&
        item.preparationStartedAt == null
      ) {
        updates.preparationStartedAt = now;
      }
      if (parsed.data.kitchenStatus === "placed") {
        updates.preparationStartedAt = null;
      }
      await tx.orderItem.update({
        where: { id: item.id },
        data: updates,
      });
    }

    if (parsed.data.served !== undefined) {
      await tx.orderItem.update({
        where: { id: item.id },
        data: {
          servedAt: parsed.data.served ? now : null,
          // Serving implies the kitchen finished this one.
          kitchenStatus: parsed.data.served ? "ready" : item.kitchenStatus,
        },
      });
    }

    if (item.roundId) {
      // Derive round.status from the weakest link of its items:
      //  - any placed → placed
      //  - any in_kitchen (none placed) → in_kitchen
      //  - all ready → ready
      const siblings = await tx.orderItem.findMany({
        where: { roundId: item.roundId },
        select: { id: true, kitchenStatus: true, servedAt: true },
      });
      const effective = siblings.map((s) => {
        if (s.id !== item.id) return s.kitchenStatus;
        if (parsed.data.kitchenStatus !== undefined) return parsed.data.kitchenStatus;
        if (parsed.data.served === true) return "ready" as const;
        return s.kitchenStatus;
      });
      let roundStatus: "placed" | "in_kitchen" | "ready" = "ready";
      if (effective.some((s) => s === "placed")) roundStatus = "placed";
      else if (effective.some((s) => s === "in_kitchen")) roundStatus = "in_kitchen";

      const round = await tx.round.findUnique({ where: { id: item.roundId } });
      const roundData: {
        status: typeof roundStatus;
        kitchenStartedAt?: Date;
        readyAt?: Date | null;
      } = { status: roundStatus };
      if (roundStatus === "in_kitchen" && round && !round.kitchenStartedAt) {
        roundData.kitchenStartedAt = now;
      }
      if (roundStatus === "ready" && round && !round.readyAt) {
        roundData.readyAt = now;
        becameRoundReady = true;
      }
      if (roundStatus !== "ready" && round?.readyAt) {
        // Someone pulled an item back from ready — round is no longer done.
        roundData.readyAt = null;
      }
      await tx.round.update({ where: { id: item.roundId }, data: roundData });
    }

    if (parsed.data.served !== undefined && item.roundId) {
      // Bubble served-state up to order (unchanged from earlier behaviour).
      const siblings = await tx.orderItem.findMany({
        where: { roundId: item.roundId },
        select: { id: true, servedAt: true },
      });
      const allServed = siblings.every((i) =>
        i.id === item.id ? parsed.data.served : !!i.servedAt,
      );
      await tx.round.update({
        where: { id: item.roundId },
        data: { status: allServed ? "served" : undefined },
      });

      if (allServed) {
        const rounds = await tx.round.findMany({
          where: { orderId: item.order.id },
          select: { id: true, status: true },
        });
        const allRoundsServed = rounds.every((r) =>
          r.id === item.roundId ? true : r.status === "served",
        );
        if (allRoundsServed && item.order.status !== "paid") {
          await tx.order.update({
            where: { id: item.order.id },
            data: { status: "served", servedAt: now },
          });
        }
      } else if (!parsed.data.served && item.order.status === "served") {
        await tx.order.update({
          where: { id: item.order.id },
          data: { status: "ready", servedAt: null },
        });
      }
    }
  });

  publishOrderEvent(item.order.restaurantId, {
    type: becameRoundReady ? "order.ready" : "order.updated",
    orderId: item.orderId,
  });

  // Push al mesero cuando este item-bump cierra el round (todos los
  // platos del round quedan ready). Replicamos el patrón del
  // /operator/rounds/[id] PATCH para que el aviso llegue sin importar
  // si la cocina pulsó "Marcar todo listo" o cerró item por item.
  if (becameRoundReady && item.order.tableId) {
    void (async () => {
      const table = await db.table.findUnique({
        where: { id: item.order.tableId! },
        select: { number: true, label: true },
      });
      if (!table || table.number < 0) return;
      const where = table.label ?? `Mesa ${table.number}`;
      await sendPushToMeserosForTable(item.order.restaurantId, table.number, {
        title: `${where}: listo para entregar`,
        body: "Pasa por cocina a recoger",
        tag: `ready-${item.orderId}-${item.roundId}`,
        url: "/mesero/salon",
      });
    })().catch((err) => console.error("[push:item_ready]", err));
  }

  // Auto-print on placed → in_kitchen, for whichever station the item
  // belongs to. We fire one event per (round, station, sub) so the
  // matching listener prints — the page itself dedupes by roundId so
  // five items in the same round only generate one physical ticket.
  if (
    parsed.data.kitchenStatus === "in_kitchen" &&
    item.kitchenStatus === "placed" &&
    item.roundId &&
    (item.station === "kitchen" || item.station === "bar")
  ) {
    const tenant = await db.restaurant.findUnique({
      where: { id: item.order.restaurantId },
      select: { kitchenPrintEnabled: true, barPrintEnabled: true },
    });
    const printEnabled =
      item.station === "kitchen"
        ? tenant?.kitchenPrintEnabled
        : tenant?.barPrintEnabled;
    if (printEnabled) {
      publishOrderEvent(item.order.restaurantId, {
        type: "ticket.printable",
        roundId: item.roundId,
        orderId: item.orderId,
        station: item.station,
        barSubStation: item.barSubStation ?? null,
      });
    }
  }

  return NextResponse.json({ ok: true });
}
