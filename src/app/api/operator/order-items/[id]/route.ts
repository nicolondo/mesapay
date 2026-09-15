import { lockOrder } from "@/lib/orderLock";
import { requireMutableOrderInTx, recomputeOrderLinesInTx } from "@/lib/orders";
import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { publishOrderEvent } from "@/lib/events";
import { sendPushToMeserosForTable } from "@/lib/push";
import { recordAuditEvent } from "@/lib/auditLog";
import { notifyAcceptedRoundTicketSafe } from "@/lib/print/enqueue";
import { itemKitchenStatusData } from "@/lib/kds/roundStatus";
import { recomputeRoundStatusInTx } from "@/lib/kds/transition";

const schema = z
  .object({
    served: z.boolean().optional(),
    kitchenStatus: z.enum(["placed", "in_kitchen", "ready"]).optional(),
    // "Apurar" — el mesero le dice a cocina que este plato es urgente
    // porque el cliente está preguntando. true = setea timestamp now.
    // No hay forma de "des-apurar" — una vez marcado queda hasta que
    // el item se mueve a ready (el badge desaparece naturalmente).
    expedite: z.literal(true).optional(),
    // Cancelar / no cobrar este item específico (distinto a
    // cancelar la ronda). Cuando el cliente pide "saca el lomito
    // pero deja los demás" o "este lomito llegó frío, no me lo
    // cobres", el mesero usa esto desde el detail sheet. Recompute
    // del subtotal corre en la misma transacción.
    //
    // `kind` distingue:
    //   "cancel" (default) — sólo si el item NO ha sido servido.
    //   "comp"             — permitido en cualquier estado, incluso
    //                        servido (caso queja / cortesía /
    //                        walkout — la comida ya se entregó).
    cancel: z
      .object({
        reason: z.string().trim().min(3).max(240),
        kind: z.enum(["cancel", "comp"]).optional().default("cancel"),
        // Además de cancelar este plato, marcarlo "no disponible" en la
        // carta (86 del plato: se acabó el insumo). Mismo intent que el
        // cancel de ronda; acá aplica solo al menuItem de ESTE item.
        markUnavailable: z.boolean().optional(),
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

async function PATCHHandler(
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
      session.user.role !== "platform_admin" && session.user.role !== "group_admin" &&
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

  try {
    await db.$transaction(async (tx) => {
    await lockOrder(tx, item.orderId);
    const currentItem = await tx.orderItem.findUniqueOrThrow({
      where: { id: item.id },
      include: { order: { include: { table: { select: { kind: true } } } } },
    });
    const now = new Date();

    if (parsed.data.cancel) {
      await requireMutableOrderInTx(tx, currentItem.orderId);
      const kind = parsed.data.cancel.kind ?? "cancel";
      // Gate: kind="cancel" sólo si NO ha sido servido. Para items
      // ya servidos hay que usar kind="comp" (semánticamente
      // distinto — la comida se entregó). El frontend rotúla el
      // botón distinto según estado.
      // Excepción: las LÍNEAS LIBRES (servicios, cargos sueltos) nacen con
      // servedAt puesto para no aparecer en la comanda de cocina. Ese sello
      // es una marca técnica, no significa que se haya entregado comida, así
      // que el gate de "ya servido" no les aplica: se cancelan y punto. Sin
      // esto un cargo escrito a mano quedaba imposible de quitar de la
      // cuenta — la UI ofrecía "Cancelar" y el servidor lo rechazaba.
      // Lo mismo vale para los platos de una FACTURA MANUAL (mesa `manual`):
      // nacen servidos porque nadie los prepara, no porque alguien los
      // haya entregado.
      const technicalServe =
        currentItem.menuItemId === null ||
        currentItem.order.table.kind === "manual";
      if (kind === "cancel" && currentItem.servedAt && !technicalServe) {
        throw new Error("CANCEL_AFTER_SERVED");
      }
      // Cancelación / comp del currentItem. Idempotente: si ya estaba
      // cancelado no re-pisamos timestamps ni recalculamos. Si no,
      // marcamos y re-derivamos el subtotal de la orden a partir
      // de los items vivos restantes (excluye este recién cancelado
      // por el WHERE).
      if (!currentItem.cancelledAt) {
        await tx.orderItem.update({
          where: { id: currentItem.id },
          data: {
            cancelledAt: now,
            cancellationReason: parsed.data.cancel.reason,
            cancelledByEmail: session.user.email,
            cancellationKind: kind,
          },
        });
        // El subtotal se re-deriva DESPUÉS del tx con la función canónica
        // (ver abajo). El cálculo inline que vivía acá sumaba sólo
        // precio × cantidad e ignoraba `Order.taxCents`: al cancelar una
        // línea libre, su impuesto sumado encima quedaba cobrándose igual, y
        // al cancelar un plato de una cuenta con líneas libres el total
        // perdía el impuesto de las que seguían vivas.
      }
      // 86 del plato: marcar el menuItem como no disponible en la carta.
      // Una línea libre no está en la carta, así que no hay qué agotar.
      if (parsed.data.cancel.markUnavailable && currentItem.menuItemId) {
        await tx.menuItem.update({
          where: { id: currentItem.menuItemId },
          data: { available: false },
        });
      }
      // Si la cancelación era el único item activo del round,
      // mover el round a "cancelled" para que el kitchen board lo
      // saque del flujo. UX coherente: si la última cosa del round
      // se canceló, la ronda entera está cancelada.
      if (currentItem.roundId) {
        const remaining = await tx.orderItem.count({
          where: { roundId: currentItem.roundId, cancelledAt: null },
        });
        if (remaining === 0) {
          await tx.round.update({
            where: { id: currentItem.roundId },
            data: {
              status: "cancelled",
              cancelledAt: now,
              cancelledByEmail: session.user.email,
              cancellationReason: parsed.data.cancel.reason,
            },
          });
        }
      }
      await recomputeOrderLinesInTx(tx, currentItem.orderId);
      // Skip todas las otras ramas — cancelar es exclusivo.
      return;
    }

    if (parsed.data.expedite === true && !currentItem.expediteRequestedAt) {
      // Solo registramos el primer apurón — clicks repetidos no
      // re-pisan el timestamp ni cambian el email. El badge en el
      // kitchen board se mantiene hasta que el item pasa a ready.
      await tx.orderItem.update({
        where: { id: currentItem.id },
        data: {
          expediteRequestedAt: now,
          expediteRequestedByEmail: session.user.email,
        },
      });
    }

    if (parsed.data.kitchenStatus !== undefined) {
      // Misma transición que el marchado automático (src/lib/kds): la
      // primera entrada a "in_kitchen" arranca el cronómetro del plato,
      // volver a "placed" lo borra. Es lo que alimenta la cuenta
      // regresiva del bar.
      await tx.orderItem.update({
        where: { id: currentItem.id },
        data: itemKitchenStatusData(
          currentItem,
          parsed.data.kitchenStatus,
          now,
        ),
      });
    }

    if (parsed.data.served !== undefined) {
      await tx.orderItem.update({
        where: { id: currentItem.id },
        data: {
          servedAt: parsed.data.served ? now : null,
          // Serving implies the kitchen finished this one.
          kitchenStatus: parsed.data.served ? "ready" : currentItem.kitchenStatus,
        },
      });
    }

    if (currentItem.roundId) {
      // Re-derivar Round.status desde sus ítems vivos (el eslabón más
      // débil: placed > in_kitchen > ready, cancelados excluidos) y sellar
      // kitchenStartedAt / readyAt. La regla vive en src/lib/kds y es la
      // MISMA que usa el marchado automático. Se lee DESPUÉS de escribir
      // el ítem: dentro de la tx la lectura ya ve el estado nuevo.
      const recomputed = await recomputeRoundStatusInTx(
        tx,
        currentItem.roundId,
        now,
      );
      if (recomputed?.becameReady) becameRoundReady = true;
    }

    // Roll-up de round/order.status se mueve AFUERA del tx (abajo).
    // Adentro del tx, la query de siblings ve un snapshot anterior;
    // si dos PATCH paralelas corren para items distintos del mismo
    // round, ambas leen al otro todavía con servedAt=null y dejan
    // el round en 'ready' aunque las dos commit los items como
    // servidos. Hacer el roll-up con fresh DB state al final
    // elimina esa race.
    });
  } catch (err) {
    if (err instanceof Error && err.message === "CANCEL_AFTER_SERVED") {
      return NextResponse.json(
        {
          error: "cancel_after_served",
          message:
            "Este plato ya fue entregado. Para no cobrarlo (queja / cortesía / cliente se fue), usá 'No cobrar plato'.",
        },
        { status: 409 },
      );
    }
    throw err;
  }

  // Audit event para el cancel/comp — sólo si efectivamente
  // cancelamos (parsed.data.cancel && el item no estaba ya cancelado
  // antes del tx).
  if (parsed.data.cancel && !item.cancelledAt) {
    const kind = parsed.data.cancel.kind ?? "cancel";
    await recordAuditEvent({
      kind: kind === "comp" ? "order_item.comp" : "order_item.cancel",
      restaurantId: item.order.restaurantId,
      target: { type: "order_item", id: item.id },
      summary:
        kind === "comp"
          ? `No cobró ${item.qty}× ${item.nameSnapshot} — ${parsed.data.cancel.reason}`
          : `Canceló ${item.qty}× ${item.nameSnapshot} — ${parsed.data.cancel.reason}`,
      diff: {
        before: {
          kitchenStatus: item.kitchenStatus,
          servedAt: item.servedAt,
          priceCents: item.priceCentsSnapshot * item.qty,
        },
        after: { cancelledAt: new Date().toISOString(), kind },
      },
    });
  }

  // Recompute roll-ups DESPUÉS de que el item-update commiteó. Lee
  // estado fresh (no snapshot transaccional), así dos batches
  // paralelos terminan ambos calculando bien la transición.
  if (parsed.data.served !== undefined && item.roundId) {
    const freshSiblings = await db.orderItem.findMany({
      where: { roundId: item.roundId, cancelledAt: null },
      select: { id: true, servedAt: true },
    });
    const allServed =
      freshSiblings.length > 0 &&
      freshSiblings.every((i) => !!i.servedAt);
    if (allServed) {
      await db.round.update({
        where: { id: item.roundId },
        data: { status: "served" },
      });
      // Order entera servida si TODOS los rounds (no cancelados)
      // están servidos.
      const freshRounds = await db.round.findMany({
        where: { orderId: item.order.id },
        select: { id: true, status: true },
      });
      const allRoundsServed = freshRounds.every(
        (r) => r.status === "served" || r.status === "cancelled",
      );
      if (allRoundsServed && item.order.status !== "paid") {
        await db.order.updateMany({
          where: { id: item.order.id, status: { notIn: ["paid", "paying", "cancelled"] } },
          data: { status: "served", servedAt: new Date() },
        });
      }
    } else if (!parsed.data.served && item.order.status === "served") {
      // Re-servido a false en un item que estaba marcando la order
      // como served → rollback de la order a "ready".
      await db.order.updateMany({
        where: { id: item.order.id, status: "served" },
        data: { status: "ready", servedAt: null },
      });
    }
  }

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

  // Accepting or rejecting the last pending dish can settle this station.
  // Both print paths wait for that decision and exclude rejected dishes.
  if (
    item.kitchenStatus === "placed" &&
    !item.cancelledAt &&
    (parsed.data.kitchenStatus === "in_kitchen" || parsed.data.cancel) &&
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
      await notifyAcceptedRoundTicketSafe({
        restaurantId: item.order.restaurantId,
        orderId: item.orderId,
        roundId: item.roundId,
        station: item.station,
        barSubStation: item.barSubStation ?? null,
      });
    }
  }

  return NextResponse.json({ ok: true });
}

export const PATCH = secureApi(PATCHHandler);
