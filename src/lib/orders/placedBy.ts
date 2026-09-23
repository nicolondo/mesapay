/**
 * Quién MONTÓ una ronda.
 *
 * Cuando un mesero (o cualquier otro usuario del personal) toma el pedido
 * desde la carta con su propia sesión, la ronda queda estampada con él para
 * que en cocina sepan a quién preguntarle. Cuando pide el comensal desde su
 * celular no hay personal detrás y los tres campos quedan en null.
 *
 * La pertenencia al comercio se comprueba igual que en el resto de la app
 * (`staffForRestaurant` en src/lib/staffAccess.ts): contra el restaurante
 * ACTIVO del contexto, que para un platform_admin o group_admin es el que
 * está impersonando vía cookie. Por eso esta función recibe el
 * `ActiveContext` resuelto y no la sesión pelada: una sesión de admin no
 * dice a qué comercio está mirando.
 *
 * Este módulo es puro (sólo importa tipos) para poder usarse también desde
 * los componentes de cliente que pintan la etiqueta del rol.
 */

import type { Role } from "@prisma/client";
import type { ActiveContext } from "@/lib/activeRestaurant";

export type PlacedBy = {
  userId: string;
  /** Nombre a mostrar: `User.name` o, si está vacío, la parte local del correo. */
  name: string;
  role: Role;
};

/**
 * Roles que montan pedidos a nombre del comercio. Es la misma lista que
 * `STAFF_ROLES` en src/lib/staffAccess.ts (hay un test que lo verifica);
 * se repite acá porque ese módulo arrastra `next/headers` y este tiene que
 * poder importarse desde el cliente. `customer` (legado) y los roles
 * comerciales nunca montan rondas.
 */
export const PLACED_BY_ROLES: readonly Role[] = [
  "operator",
  "platform_admin",
  "group_admin",
  "mesero",
  "terminal",
  "kitchen",
  "bar",
];

export function isPlacedByRole(role: string | null | undefined): role is Role {
  return !!role && (PLACED_BY_ROLES as readonly string[]).includes(role);
}

/**
 * Nombre a mostrar en la comanda. Un usuario sin nombre (cuentas viejas,
 * altas rápidas) igual tiene que identificarse: cae a la parte local del
 * correo ("juan" de juan@…). Nunca devuelve vacío.
 */
export function displayNameFor(user: {
  name?: string | null;
  email?: string | null;
}): string {
  const name = user.name?.trim();
  if (name) return name;
  const local = (user.email ?? "").split("@")[0].trim();
  return local || "?";
}

/**
 * Resuelve quién monta la ronda: el usuario del contexto si es personal
 * (rol de la lista) del comercio `restaurantId`. Cualquier otro caso — sin
 * sesión, rol no operativo, personal de otro local, admin sin impersonar —
 * devuelve null y la ronda queda como pedida por el comensal.
 */
export function resolvePlacedBy(
  ctx: ActiveContext | null | undefined,
  restaurantId: string,
): PlacedBy | null {
  if (!ctx || ctx.restaurantId !== restaurantId) return null;
  const user = ctx.session.user;
  if (!user?.id || !isPlacedByRole(user.role)) return null;
  return { userId: user.id, name: displayNameFor(user), role: user.role };
}

/** Columnas de `Round` a estampar (null explícito cuando pide el comensal). */
export function roundPlacedByData(placedBy: PlacedBy | null): {
  placedByUserId: string | null;
  placedByName: string | null;
  placedByRole: string | null;
} {
  return {
    placedByUserId: placedBy?.userId ?? null,
    placedByName: placedBy?.name ?? null,
    placedByRole: placedBy?.role ?? null,
  };
}

/** Claves i18n (namespace `kitchen`) de la etiqueta de cada rol. */
export type RoleLabelKey =
  | "roleMesero"
  | "roleOperator"
  | "roleKitchen"
  | "roleBar"
  | "roleTerminal"
  | "roleGroupAdmin"
  | "rolePlatformAdmin";

const ROLE_LABEL_KEYS: Record<string, RoleLabelKey> = {
  mesero: "roleMesero",
  operator: "roleOperator",
  kitchen: "roleKitchen",
  bar: "roleBar",
  terminal: "roleTerminal",
  group_admin: "roleGroupAdmin",
  platform_admin: "rolePlatformAdmin",
};

/**
 * Clave de traducción para el rol guardado en `Round.placedByRole`. Las
 * etiquetas viven en el namespace `kitchen` (el que comparten el tablero de
 * cocina y el del bar); las demás pantallas y la comanda impresa las leen
 * de ahí. Null para un rol desconocido (snapshot viejo de un rol que ya no
 * existe): el que llama muestra sólo el nombre.
 */
export function roleLabelKey(role: string | null | undefined): RoleLabelKey | null {
  return role ? (ROLE_LABEL_KEYS[role] ?? null) : null;
}
