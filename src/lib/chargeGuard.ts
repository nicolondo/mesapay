import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  CHARGE_ADMIN_ONLY_ERROR,
  isChargeBlockedForRole,
} from "@/lib/chargeControl";

/**
 * Guardarraíl SERVER-SIDE de "solo el administrador inicia el cobro".
 *
 * Esconder el botón no alcanza: la PWA del mesero corre en su celular y
 * cualquiera con la sesión abierta puede hacer POST a la API. Por eso
 * TODOS los caminos por los que nace o se cierra un cobro llaman a este
 * guard:
 *
 *   1. POST /api/tenant/[slug]/pay                          (efectivo, demo card/nequi)
 *   2. POST /api/tenant/[slug]/pay/terminal-request         (datáfono Kushki)
 *   3. POST /api/tenant/[slug]/pay/external-terminal-request(datáfono propio)
 *   4. POST /api/tenant/[slug]/pay/kushki-charge            (tarjeta / Apple Pay)
 *   5. POST /api/tenant/[slug]/pay/kushki-pse-init          (PSE)
 *   6. POST /api/tenant/[slug]/terminal/charge              (push al datáfono físico)
 *   7. POST /api/operator/payments/[id]/settle-cash         (confirmar efectivo)
 *   8. POST /api/operator/payments/[id]/settle-external-terminal
 *   9. POST /api/tenant/[slug]/orders/[orderId]/comp        (cerrar en $0 como cortesía)
 *
 * (El refund ya era operator/platform_admin only, así que el mesero
 * nunca lo tuvo.)
 *
 * Optimización: sólo tocamos la base cuando el que pega es un mesero.
 * Para comensales y administradores el guard cuesta cero queries.
 */
export async function isChargeBlocked(
  role: string | null | undefined,
  restaurantId: string,
): Promise<boolean> {
  // `isChargeBlockedForRole(role, true)` es el filtro barato: si con la
  // política encendida este rol no se bloquearía, no hace falta leerla.
  if (!isChargeBlockedForRole(role, true)) return false;
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { adminOnlyCharge: true },
  });
  return tenant?.adminOnlyCharge === true;
}

/**
 * Respuesta única para el bloqueo. Devolvemos un CÓDIGO, no copy: el
 * cliente lo traduce con next-intl (MESAPAY es trilingüe y las APIs no
 * mandan español hardcodeado).
 *
 * 403 y no 401: la sesión es válida, lo que falta es el permiso.
 */
export function chargeBlockedResponse() {
  return NextResponse.json(
    { error: CHARGE_ADMIN_ONLY_ERROR },
    { status: 403 },
  );
}
