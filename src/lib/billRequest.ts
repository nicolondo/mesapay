// "PIDIERON LA CUENTA" — un solo lugar donde nace el aviso del
// administrador.
//
// `order.bill_requested` es el ÚNICO evento que escucha el aviso de
// pantalla completa (src/app/operator/BillRequestAlert.tsx), y hoy lo
// emiten dos caminos:
//
//   1. POST /orders/[orderId]/request-bill — el MESERO le avisa a caja
//      desde Salón / Mesas (con "solo el administrador cobra" activo él
//      ya no puede cobrar, así que avisa).
//   2. El COMENSAL eligiendo forma de pago en /t/[slug]/pay/[orderId]:
//      efectivo, datáfono Kushki o datáfono del comercio. Elegir cómo va
//      a pagar ES pedir la cuenta — antes había además un botón "Pedir
//      la cuenta" aparte, que era un segundo camino para lo mismo y no
//      decía cómo iba a pagar la mesa.
//
// Sólo las rieles PRESENCIALES disparan el aviso. Tarjeta Kushki, Apple
// Pay y PSE las paga el comensal desde su celular: la plata entra sin
// que nadie tenga que ir a la mesa, así que no hay cuenta que pedir.

import { db } from "@/lib/db";
import { publishOrderEvent, type BillRequestMethod } from "@/lib/events";

export type BillRequestSource = "diner" | "staff";

/** Roles que cuentan como staff a la hora de atribuir el pedido de cuenta. */
const STAFF_ROLES = new Set(["mesero", "operator", "platform_admin"]);

/**
 * ¿Quién pidió la cuenta? El comensal llega sin sesión (o con la sesión
 * de su cuenta de comensal, que no tiene rol de staff); el mesero y el
 * administrador llegan con rol.
 *
 * No es un permiso: cualquiera sentado en la mesa puede pedir su cuenta.
 * Sirve sólo para el copy del aviso.
 */
export function billRequestSourceForRole(
  role: string | null | undefined,
): BillRequestSource {
  return role && STAFF_ROLES.has(role) ? "staff" : "diner";
}

export type BillAlertContext = {
  adminOnlyCharge: boolean;
  source: BillRequestSource;
  serviceMode: string;
};

/**
 * Parte BARATA del guard — la que se puede evaluar sin tocar la base.
 *
 * Avisamos sólo cuando: el comercio activó "solo el administrador inicia
 * el cobro" (sin la política el aviso ni siquiera se monta), lo pide un
 * comensal (si cobra el propio administrador no hace falta avisarle de
 * su propia acción) y hay servicio a la mesa (en mostrador el comensal
 * ya está parado frente a la caja).
 */
export function billAlertAppliesToPay({
  adminOnlyCharge,
  source,
  serviceMode,
}: BillAlertContext): boolean {
  if (!adminOnlyCharge) return false;
  if (source !== "diner") return false;
  if (serviceMode === "counter") return false;
  return true;
}

/**
 * Guard completo: lo anterior + la mesa tiene que ser real. Las
 * pseudo-mesas de pickup usan número negativo y no tienen a nadie a
 * quien llevarle la cuenta.
 */
export function shouldAnnounceBillOnPay(
  ctx: BillAlertContext & { tableNumber: number | null },
): boolean {
  if (!billAlertAppliesToPay(ctx)) return false;
  return ctx.tableNumber != null && ctx.tableNumber >= 0;
}

export type BillRequestOrder = {
  id: string;
  shortCode: string;
  needsWaiter: boolean;
  table: { number: number; label: string | null };
};

/**
 * Marca la mesa como "atención pendiente" y publica el evento.
 *
 * `needsWaiter` es idempotente: si la mesa ya tenía una llamada viva no
 * le pisamos `waiterCalledAt` (el reloj de espera del Salón tiene que
 * seguir corriendo desde el primer pedido, no reiniciarse con cada tap).
 * El EVENTO en cambio se re-emite siempre: si el administrador cerró el
 * aviso y la mesa insiste, tiene que volver a sonar.
 *
 * NO manda push: cada llamador tiene su propio texto (la ruta de
 * request-bill dice "pidió la cuenta", las de pago dicen con qué método)
 * y duplicarlo acá le llegaría dos veces al mesero.
 */
export async function publishBillRequested({
  tenantId,
  order,
  source,
  method = null,
}: {
  tenantId: string;
  order: BillRequestOrder;
  source: BillRequestSource;
  method?: BillRequestMethod | null;
}): Promise<void> {
  if (!order.needsWaiter) {
    await db.order.update({
      where: { id: order.id },
      data: { needsWaiter: true, waiterCalledAt: new Date() },
    });
  }

  publishOrderEvent(tenantId, {
    type: "order.bill_requested",
    orderId: order.id,
    shortCode: order.shortCode,
    tableNumber: order.table.number,
    tableLabel: order.table.label,
    source,
    method,
  });
}

/**
 * Atajo para las tres rutas de pago presencial: resuelve el guard, carga
 * la mesa y publica. Si no corresponde avisar, no toca la base.
 *
 * Nunca lanza: el pago ya está registrado cuando esto corre y un fallo
 * del aviso no puede tumbar la respuesta al comensal.
 */
export async function announceBillRequestedOnPay({
  tenant,
  order,
  role,
  method,
}: {
  tenant: { id: string; adminOnlyCharge: boolean; serviceMode: string };
  order: {
    id: string;
    shortCode: string;
    needsWaiter: boolean;
    tableId: string | null;
  };
  role: string | null | undefined;
  method: BillRequestMethod;
}): Promise<void> {
  const source = billRequestSourceForRole(role);
  const ctx = {
    adminOnlyCharge: tenant.adminOnlyCharge,
    source,
    serviceMode: tenant.serviceMode,
  };
  // Filtro barato antes de tocar la base: sin política, o si cobra el
  // propio administrador, ni siquiera hace falta saber en qué mesa está.
  if (!billAlertAppliesToPay(ctx)) return;
  try {
    const table = order.tableId
      ? await db.table.findUnique({
          where: { id: order.tableId },
          select: { number: true, label: true },
        })
      : null;
    if (
      !table ||
      !shouldAnnounceBillOnPay({ ...ctx, tableNumber: table.number })
    ) {
      return;
    }
    await publishBillRequested({
      tenantId: tenant.id,
      order: {
        id: order.id,
        shortCode: order.shortCode,
        needsWaiter: order.needsWaiter,
        table,
      },
      source,
      method,
    });
  } catch (err) {
    console.error("[billRequest] no se pudo avisar al administrador", err);
  }
}
