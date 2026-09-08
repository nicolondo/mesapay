import "server-only";
import { db } from "./db";
import { getDiner, type DinerViewer } from "./dinerSession";

/**
 * De dónde sale el COMERCIO en los caminos del comensal.
 *
 * Desde que el registro es por comercio, ninguna pantalla ni endpoint del
 * comensal tiene sentido sin restaurante. El contexto sale del `slug` de la
 * URL — el mismo que ya resuelve toda la zona `/t/[slug]/*`, al que el
 * comensal llega escaneando el QR de la mesa o por el flujo de pago, y que
 * en producción es además el subdominio (`restaurante.mesapay.co/cuenta/…`
 * lo reescribe el middleware a `/t/restaurante/cuenta/…`).
 *
 * Nunca sale de una cookie, de un campo del formulario ni de un id que
 * mande el cliente: si el restaurante lo eligiera el navegador, cualquiera
 * podría pedir un enlace de acceso "por" otro local.
 */
export async function resolveTenantId(slug: string): Promise<string | null> {
  const tenant = await db.restaurant.findUnique({
    where: { slug },
    select: { id: true },
  });
  return tenant?.id ?? null;
}

export type TenantDiner = { restaurantId: string; diner: DinerViewer };

/**
 * Resuelve tenant + comensal autenticado EN ESE tenant. Devuelve null si el
 * slug no existe o si no hay sesión de comensal para ese comercio.
 */
export async function requireTenantDiner(
  slug: string,
): Promise<TenantDiner | null> {
  const restaurantId = await resolveTenantId(slug);
  if (!restaurantId) return null;
  const diner = await getDiner(restaurantId);
  if (!diner) return null;
  return { restaurantId, diner };
}
