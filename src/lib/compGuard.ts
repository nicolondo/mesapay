import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { COMP_NOT_ALLOWED_ERROR, canCompOrders } from "@/lib/staffPolicies";

/**
 * Guardarraíl SERVER-SIDE de "sólo los roles elegidos pueden no cobrar".
 *
 * Esconder el botón no alcanza: la PWA del mesero corre en su celular y
 * cualquiera con la sesión abierta puede hacer PATCH/POST a la API. Por eso
 * los DOS caminos por los que se anula un cobro llaman a este guard:
 *
 *   1. PATCH /api/operator/order-items/[id]  con cancel.kind = "comp"
 *      (no cobrar UN plato entregado)
 *   2. POST  /api/tenant/[slug]/orders/[orderId]/comp
 *      (cerrar la cuenta COMPLETA como cortesía / gastos de representación)
 *
 * La cancelación normal (`kind = "cancel"`, plato que nunca salió) NO pasa
 * por acá: no es plata que entró, es un pedido que no se hizo.
 *
 * La regla en sí es pura y vive en `canCompOrders` (staffPolicies.ts); acá
 * sólo leemos la política del comercio. platform_admin / group_admin no
 * tocan la base: `canCompOrders` los deja pasar antes de mirar la lista.
 */
export async function isCompBlocked(
  role: string | null | undefined,
  restaurantId: string,
): Promise<boolean> {
  // Atajo barato: si el rol pasa con CUALQUIER lista (admins de plataforma
  // y grupo) no hace falta leerla.
  if (canCompOrders(role, [])) return false;
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { compAllowedRoles: true },
  });
  return !canCompOrders(role, tenant?.compAllowedRoles);
}

/**
 * Respuesta única para el bloqueo. Devolvemos un CÓDIGO, no copy: el
 * cliente lo traduce con next-intl (MESAPAY es trilingüe).
 *
 * 403 y no 401: la sesión es válida, lo que falta es el permiso.
 */
export function compBlockedResponse() {
  return NextResponse.json({ error: COMP_NOT_ALLOWED_ERROR }, { status: 403 });
}
