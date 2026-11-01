import { db } from "@/lib/db";
import { lockOrder } from "@/lib/orderLock";
import { publishOrderEvent } from "@/lib/events";
import { recordAuditEvent } from "@/lib/auditLog";
import { REPLACEABLE_PENDING_METHODS } from "@/lib/payments/methods";
import { releasePaymentRequests } from "@/lib/payments/staffCharge";
import { getSubscriptionProvider } from "@/lib/payments/subscription";
import { isSubscriptionNotFound } from "@/lib/billing/subscriptionErrors";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
import { cancellablePaymentLinksWhere, pendingPaymentRequestsWhere } from "./checks";
import type { DeletionActor } from "./service";

/**
 * Resolver bloqueos del borrado desde el diálogo (sólo platform_admin; la
 * ruta lo verifica). Cada acción reusa una transición que YA existe en el
 * sistema y no relaja ninguna guarda: el borrado vuelve a calcular todos los
 * bloqueos dentro de su transacción, bajo lock (service.ts).
 *
 *   decline_pending_payments → `releasePaymentRequests`, lo mismo que hace
 *     el staff al cobrar una cuenta con una solicitud del comensal pendiente.
 *     Sólo efectivo / datáfono propio: lo que tiene plata en vuelo en un
 *     proveedor NO se toca (ver REPLACEABLE_PENDING_METHODS).
 *   cancel_payment_links     → pending → cancelled, como `cancelVoucherBatch`,
 *     sólo para links sin un PSE iniciado.
 *   cancel_subscription      → `provider.cancelSubscription` (Kushki), la
 *     misma llamada que /api/operator/subscription/cancel. A diferencia de
 *     esa ruta, si Kushki falla NO se marca cancelada: el débito podría
 *     seguir cobrando y el bloqueo tiene que quedar con el error.
 *     ÚNICA excepción: Kushki responde que la suscripción NO EXISTE (K012
 *     "ID de suscripción no válida" o HTTP 404). Pasa con suscripciones
 *     creadas cuando la cuenta de cobro estaba en sandbox y hoy se cancelan
 *     con las credenciales de producción. Ahí sí se marca cancelada en
 *     MESAPAY: Kushki no puede cobrar con un id que no reconoce con estas
 *     credenciales, así que no queda ningún débito vivo huérfano. Se
 *     distingue en el resultado (`providerUnknown`), queda en la auditoría y
 *     en el log. Cualquier OTRO error (credenciales, 4xx distinto, 5xx, red)
 *     sigue siendo fallo y deja la suscripción como está.
 *
 * Todas dejan auditoría con el admin como actor.
 */

type Actor = DeletionActor;

const auditActor = (actor: Actor) => ({ userId: actor.id, email: actor.email, role: actor.role });

export async function declinePendingPaymentRequests(restaurantId: string, actor: Actor): Promise<{ declined: number }> {
  const rows = await db.payment.findMany({
    where: pendingPaymentRequestsWhere(restaurantId),
    select: { orderId: true },
    distinct: ["orderId"],
  });
  // Orden estable de los locks (y una cuenta por transacción, como el cobro del staff).
  const orderIds = [...new Set(rows.map((r) => r.orderId))].sort();
  const declinedIds: string[] = [];
  for (const orderId of orderIds) {
    const ids = await db.$transaction(async (tx) => {
      await lockOrder(tx, orderId);
      // Bajo el lock: la cuenta es de ESTE comercio y éstas son las solicitudes vigentes.
      const order = await tx.order.findFirst({ where: { id: orderId, restaurantId }, select: { id: true } });
      if (!order) return [];
      const pending = await tx.payment.findMany({
        where: { orderId, status: "pending", method: { in: [...REPLACEABLE_PENDING_METHODS] } },
        select: { id: true },
      });
      if (pending.length === 0) return [];
      await releasePaymentRequests(tx, orderId);
      return pending.map((p) => p.id);
    });
    if (ids.length > 0) {
      declinedIds.push(...ids);
      publishOrderEvent(restaurantId, { type: "order.updated", orderId });
    }
  }
  if (declinedIds.length > 0) {
    await recordAuditEvent({
      kind: "restaurant.delete_blocker.payments_declined",
      restaurantId,
      target: { type: "restaurant", id: restaurantId },
      summary: `Anuló ${declinedIds.length} cobro(s) pendiente(s) (solicitudes del comensal) para poder eliminar el comercio`,
      diff: { after: { status: "declined", paymentIds: declinedIds } },
      actor: auditActor(actor),
    });
  }
  return { declined: declinedIds.length };
}

export async function cancelOpenPaymentLinks(
  restaurantId: string,
  actor: Actor,
  now: Date = new Date(),
): Promise<{ cancelled: number }> {
  const where = cancellablePaymentLinksWhere(restaurantId, now);
  const links = await db.paymentLink.findMany({ where, select: { id: true } });
  if (links.length === 0) return { cancelled: 0 };
  const ids = links.map((l) => l.id);
  // Condicionado: si entre la lectura y acá alguien pagó el link o inició un
  // PSE, ese ya no cumple el filtro y no se toca.
  const { count } = await db.paymentLink.updateMany({
    where: { ...where, id: { in: ids } },
    data: { status: "cancelled" },
  });
  if (count > 0) {
    await recordAuditEvent({
      kind: "restaurant.delete_blocker.payment_links_cancelled",
      restaurantId,
      target: { type: "restaurant", id: restaurantId },
      summary: `Anuló ${count} link(s) de pago sin pagar para poder eliminar el comercio`,
      diff: { after: { status: "cancelled", paymentLinkIds: ids } },
      actor: auditActor(actor),
    });
  }
  return { cancelled: count };
}

/** Por qué Kushki no canceló el débito. El cliente lo traduce por código. */
export type SubscriptionCancelError = "billing_not_configured" | "provider_rejected" | "provider_unavailable";

export type SubscriptionCancelResult =
  | {
      ok: true;
      alreadyCanceled: boolean;
      /** Kushki no conocía la suscripción (K012 / 404): se marcó cancelada sólo en MESAPAY. */
      providerUnknown: boolean;
    }
  | { ok: false; error: SubscriptionCancelError; detail?: string };

/**
 * Lo que se le puede mostrar al admin de un fallo de Kushki: el código HTTP y
 * el código/mensaje que devolvió el proveedor (datos del proveedor, no texto
 * nuestro). Nunca la URL ni nuestros mensajes internos.
 */
export function describeSubscriptionCancelError(err: unknown): { error: SubscriptionCancelError; detail?: string } {
  const message = err instanceof Error ? err.message : "";
  if (message.startsWith("billing_not_configured")) return { error: "billing_not_configured" };
  const http = err as { status?: unknown; body?: unknown } | null;
  if (http && typeof http === "object" && typeof http.status === "number" && typeof http.body === "string") {
    let code = "";
    let text = "";
    try {
      const parsed = JSON.parse(http.body) as { code?: unknown; message?: unknown };
      if (typeof parsed.code === "string" || typeof parsed.code === "number") code = String(parsed.code);
      if (typeof parsed.message === "string") text = parsed.message;
    } catch {
      // Body que no es JSON: alcanza con el código HTTP.
    }
    const detail = [`HTTP ${http.status}`, code, text].filter(Boolean).join(" · ").slice(0, 200);
    return { error: "provider_rejected", detail };
  }
  return { error: "provider_unavailable" };
}

export async function cancelSubscriptionDebit(restaurantId: string, actor: Actor): Promise<SubscriptionCancelResult> {
  const sub = await db.billingSubscription.findUnique({
    where: { restaurantId },
    include: { restaurant: { select: { kushkiMode: true } } },
  });
  if (!sub || sub.status === "canceled") return { ok: true, alreadyCanceled: true, providerUnknown: false };

  let providerUnknown = false;
  let providerDetail: string | undefined;
  if (sub.kushkiSubscriptionId) {
    try {
      const provider = await getSubscriptionProvider(await getRestaurantKushkiMode(sub.restaurant));
      await provider.cancelSubscription({ subscriptionId: sub.kushkiSubscriptionId });
    } catch (err) {
      if (!isSubscriptionNotFound(err)) {
        console.error("[restaurantDeletion] cancelar débito: Kushki falló", { restaurantId, err });
        return { ok: false, ...describeSubscriptionCancelError(err) };
      }
      // Kushki no conoce ese id con estas credenciales (K012 / 404): no hay
      // débito que pueda cobrar, así que no es un fallo (ver cabecera).
      providerUnknown = true;
      providerDetail = describeSubscriptionCancelError(err).detail;
      console.warn(
        "[restaurantDeletion] cancelar débito: Kushki no reconoce la suscripción; se marca cancelada sólo en MESAPAY",
        { restaurantId, subscriptionId: sub.kushkiSubscriptionId, detail: providerDetail },
      );
    }
  }

  await db.billingSubscription.update({
    where: { restaurantId },
    data: { status: "canceled", canceledAt: new Date() },
  });
  await recordAuditEvent({
    kind: "subscription.cancel",
    restaurantId,
    target: { type: "billing_subscription", id: sub.kushkiSubscriptionId ?? sub.id },
    summary: providerUnknown
      ? `Kushki no reconocía la suscripción (${providerDetail ?? "K012 / 404"}): se marcó cancelada en MESAPAY desde Eliminar comercio (subscriptionId=${sub.kushkiSubscriptionId})`
      : `Canceló débito automático desde Eliminar comercio (subscriptionId=${sub.kushkiSubscriptionId})`,
    actor: auditActor(actor),
  });
  return { ok: true, alreadyCanceled: false, providerUnknown };
}
