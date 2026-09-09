import type { Role } from "@prisma/client";
import { getActiveContext } from "./activeRestaurant";

export const OPERATOR_ROLES: Role[] = ["operator", "platform_admin", "group_admin"];
export const COLLECTOR_ROLES: Role[] = [...OPERATOR_ROLES, "mesero", "terminal"];
export const STAFF_ROLES: Role[] = [...COLLECTOR_ROLES, "kitchen", "bar"];

export async function staffForRestaurant(restaurantId: string, roles = STAFF_ROLES) {
  const ctx = await getActiveContext();
  if (!ctx || ctx.restaurantId !== restaurantId || !roles.includes(ctx.session.user.role)) return null;
  return ctx.session;
}
