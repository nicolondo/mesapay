import { cookies } from "next/headers";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import type { Session } from "next-auth";

export const IMPERSONATE_COOKIE = "mesapay_act_as";

export type ActiveContext = {
  session: Session;
  restaurantId: string | null;
  impersonating: boolean;
  // Cuando un group_admin impersona, exponemos su grupo para que
  // los layouts/UIs puedan mostrar "Volver al grupo" y el switcher
  // entre locales. null para platform_admin u operator.
  groupId: string | null;
};

/**
 * Resolve which restaurant the current user is acting on.
 *
 *   - operator (y staff)  → su propio restaurantId. Ignora cookie.
 *   - platform_admin      → cookie value si existe, sin restricción.
 *   - group_admin         → cookie value SOLO si pertenece a su grupo.
 *                            Si la cookie apunta a un restaurante de
 *                            otro grupo (cookie manipulada o stale),
 *                            la ignoramos y devolvemos null.
 *
 * Para group_admin la validación del scope se hace acá — es la
 * única defensa server-side. Si esto se omitiera el group_admin
 * podría poner cualquier restaurantId en la cookie y acceder a
 * datos ajenos. NUNCA mover la validación al cliente.
 */
export async function getActiveContext(): Promise<ActiveContext | null> {
  const session = await auth();
  if (!session?.user) return null;

  if (session.user.role === "platform_admin") {
    const jar = await cookies();
    const impersonated = jar.get(IMPERSONATE_COOKIE)?.value ?? null;
    return {
      session,
      restaurantId: impersonated,
      impersonating: Boolean(impersonated),
      groupId: null,
    };
  }

  if (session.user.role === "group_admin") {
    const groupId = session.user.groupId ?? null;
    if (!groupId) {
      // Group admin sin grupo asignado — estado inválido. Devolvemos
      // null para que el layout de /group redirija o muestre error.
      return {
        session,
        restaurantId: null,
        impersonating: false,
        groupId: null,
      };
    }
    const jar = await cookies();
    const impersonated = jar.get(IMPERSONATE_COOKIE)?.value ?? null;
    if (!impersonated) {
      return {
        session,
        restaurantId: null,
        impersonating: false,
        groupId,
      };
    }
    // Validar que el restaurante de la cookie pertenece a este
    // grupo. Si no, ignorarla — no exponer el restaurante.
    const r = await db.restaurant.findUnique({
      where: { id: impersonated },
      select: { groupId: true },
    });
    if (!r || r.groupId !== groupId) {
      return {
        session,
        restaurantId: null,
        impersonating: false,
        groupId,
      };
    }
    return {
      session,
      restaurantId: impersonated,
      impersonating: true,
      groupId,
    };
  }

  return {
    session,
    restaurantId: session.user.restaurantId ?? null,
    impersonating: false,
    groupId: null,
  };
}

export async function getActiveRestaurantId(): Promise<string | null> {
  const ctx = await getActiveContext();
  return ctx?.restaurantId ?? null;
}

/**
 * Devuelve el grupo activo del usuario, si aplica:
 *   - group_admin → su user.groupId
 *   - platform_admin impersonando un restaurante con groupId → el grupo
 *   - cualquier otro → null
 *
 * Usado por el switcher cross-restaurant en el operator nav y por
 * el botón "Volver al grupo" del shell de operador cuando aplica.
 */
export async function getActiveGroupId(): Promise<string | null> {
  const ctx = await getActiveContext();
  if (!ctx) return null;
  if (ctx.groupId) return ctx.groupId;
  // platform_admin viendo un restaurante de un grupo → expose el grupo
  if (
    ctx.session.user.role === "platform_admin" &&
    ctx.restaurantId
  ) {
    const r = await db.restaurant.findUnique({
      where: { id: ctx.restaurantId },
      select: { groupId: true },
    });
    return r?.groupId ?? null;
  }
  return null;
}
