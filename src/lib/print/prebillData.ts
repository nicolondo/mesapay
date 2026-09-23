/**
 * De la CUENTA VIVA a los datos de la PRECUENTA.
 *
 * Es la única lectura que existe para este papel: la consume el encolado
 * hacia la impresora de facturas (ESC/POS) y también la vista imprimible
 * del navegador. Los dos caminos tienen que mostrar exactamente lo mismo,
 * y eso sólo se garantiza si leen del mismo lado — el mismo criterio que
 * `ticketData.ts` para la comanda.
 *
 * Lo que se lee es la orden tal como está AHORA (ítems vivos, descuento,
 * pagos aprobados), no un snapshot: la precuenta se pide varias veces por
 * mesa y cada vez tiene que reflejar lo último que se pidió.
 */

import "server-only";
import { db } from "@/lib/db";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { buildPrebillData, type PrebillData } from "@/lib/prebill";
import { resolveOrderWaiter } from "@/lib/waiterCommissionsSeal";

export type LoadPrebillResult =
  | {
      ok: true;
      data: PrebillData;
      /** `Order.locale`: el idioma del comensal, el mismo de su factura. */
      locale: string | null;
      currency: string;
      /** `Restaurant.printPaperWidthMm`: el ancho por defecto del local. */
      paperWidthMm: number;
    }
  | {
      ok: false;
      /**
       * `not_found`: no existe o es de otro comercio (no se distingue a
       * propósito). `order_closed`: ya pagada o cancelada — la precuenta ya
       * no tiene sentido, lo que corresponde es la factura. `no_items`: no
       * hay nada vivo que mostrar.
       */
      reason: "not_found" | "order_closed" | "no_items";
    };

/**
 * Carga la cuenta y arma la precuenta. `restaurantId` no es opcional: la
 * orden tiene que pertenecer a ese comercio o no existe.
 */
export async function loadPrebill(args: {
  restaurantId: string;
  orderId: string;
  now?: Date;
}): Promise<LoadPrebillResult> {
  const now = args.now ?? new Date();
  const order = await db.order.findUnique({
    where: { id: args.orderId },
    select: {
      id: true,
      restaurantId: true,
      status: true,
      shortCode: true,
      orderType: true,
      pickupName: true,
      locale: true,
      discountPct: true,
      discountCents: true,
      table: { select: { number: true, label: true, kind: true } },
      // Mismo criterio de "ítem vivo" que el subtotal y la factura: sin
      // cancelar Y sin ronda cancelada. `buildPrebillData` lo vuelve a
      // filtrar (cinturón y tirantes), pero no hace falta traer lo demás.
      items: {
        where: {
          cancelledAt: null,
          OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }],
        },
        orderBy: { id: "asc" },
        select: {
          qty: true,
          nameSnapshot: true,
          priceCentsSnapshot: true,
          taxKind: true,
          taxPct: true,
          modifierSelections: true,
          notes: true,
          guestName: true,
          cancelledAt: true,
          round: { select: { status: true } },
          menuItem: { select: { modifiers: true } },
        },
      },
      // Sólo lo aprobado: es lo que baja lo pendiente. Y quién lo cobró,
      // para nombrar al mesero.
      payments: {
        where: { status: "approved" },
        orderBy: { createdAt: "asc" },
        select: {
          status: true,
          amountCents: true,
          tipCents: true,
          collectedByUserId: true,
        },
      },
    },
  });
  if (!order || order.restaurantId !== args.restaurantId) {
    return { ok: false, reason: "not_found" };
  }
  if (order.status === "paid" || order.status === "cancelled") {
    return { ok: false, reason: "order_closed" };
  }

  const restaurant = await db.restaurant.findUnique({
    where: { id: args.restaurantId },
    select: {
      name: true,
      legalName: true,
      taxId: true,
      legalAddress: true,
      legalCity: true,
      legalPhone: true,
      salesTaxKind: true,
      salesTaxPct: true,
      country: true,
      printPaperWidthMm: true,
    },
  });
  if (!restaurant) return { ok: false, reason: "not_found" };

  // El mesero se resuelve con la misma regla que la comisión: quien cobró
  // (si ya hubo un cobro parcial) y, si no, el asignado a la mesa. Que no
  // haya uno claro no es un error: la fila simplemente no se imprime.
  const waiter = await resolveOrderWaiter(db, order);
  const waiterName = waiter
    ? (
        await db.user.findUnique({
          where: { id: waiter.id },
          select: { name: true },
        })
      )?.name ?? null
    : null;

  const data = buildPrebillData(order, restaurant, { now, waiterName });
  if (data.lines.length === 0) return { ok: false, reason: "no_items" };

  return {
    ok: true,
    data,
    locale: order.locale,
    currency: await getCurrencyForCountry(restaurant.country),
    paperWidthMm: restaurant.printPaperWidthMm,
  };
}
