import { getDiner } from "./dinerSession";
import { cookies } from "next/headers";
import { db } from "./db";
import { staffForRestaurant } from "./staffAccess";
import { signGuestScope, verifyGuestScope, type GuestScope } from "./guestToken";

export async function guestScopes(restaurantId: string) {
  return (await cookies()).getAll().filter(c => c.name.startsWith("mesapay_guest_")).map(c => verifyGuestScope(c.value)).filter((s): s is GuestScope => s !== null && s.restaurantId === restaurantId);
}
export async function grantGuestAccess(scope: Omit<GuestScope, "expires">) {
  (await cookies()).set(`mesapay_guest_${scope.orderId ?? scope.tableId}`, signGuestScope({ ...scope, expires: Date.now() + 12 * 3600_000 }), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 12 * 3600 });
}
export async function canAccessTable(restaurantId: string, tableId: string) {
  if (!await db.table.findFirst({ where: { id: tableId, restaurantId }, select: { id: true } })) return false;
  if (await staffForRestaurant(restaurantId)) return true;
  return (await guestScopes(restaurantId)).some(s => s.tableId === tableId);
}
export async function canAccessOrder(restaurantId: string, orderId: string) {
  const order = await db.order.findFirst({ where: { id: orderId, restaurantId }, select: { tableId: true, orderType: true, dinerId: true } });
  if (!order) return false;
  if (await staffForRestaurant(restaurantId)) return true;
  if (order.dinerId && (await getDiner(restaurantId))?.id === order.dinerId) return true;
  const scopes = await guestScopes(restaurantId);
  return scopes.some(s => s.orderId === orderId || order.orderType !== "pickup" && s.tableId === order.tableId);
}
