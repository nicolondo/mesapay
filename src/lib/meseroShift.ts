import { db } from "@/lib/db";
import { resolveShiftPolicy } from "@/lib/staffPolicies";

/**
 * Helpers compartidos para el turno personal del mesero — separado del
 * Shift global del restaurante. Coexisten: el operador puede tener un
 * turno general abierto mientras cada mesero tiene el suyo. Se
 * distinguen por `Shift.userId` (null = del local, populated = personal).
 *
 * Solo aplica cuando `Restaurant.shiftPolicy = "by_waiter"`. Cuando es
 * "global", el mesero NO abre turno propio — los reportes personales
 * cuentan por día calendario.
 */

/**
 * Devuelve el turno personal abierto del usuario, o null si no hay
 * ninguno. Usado por la vista "Yo" y por las APIs de stats para
 * scope-ar las queries al rango del turno actual.
 */
export async function getCurrentMeseroShift(userId: string) {
  return db.shift.findFirst({
    where: { userId, status: "open" },
    orderBy: { openedAt: "desc" },
  });
}

/**
 * ¿El mesero está intentando cobrar SIN turno personal abierto?
 * Solo aplica a rol `mesero` con `shiftPolicy="by_waiter"` — un operador/
 * admin no tiene turno personal. Cobrar sin turno descuadra el arqueo
 * (el cobro no queda dentro de ningún turno), así que las rutas de cobro
 * y la UI lo bloquean y ofrecen abrir el turno.
 */
export async function meseroNeedsShiftToCharge(
  userId: string | undefined,
  role: string | undefined,
  restaurantId: string,
): Promise<boolean> {
  if (role !== "mesero" || !userId) return false;
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { shiftPolicy: true },
  });
  if (resolveShiftPolicy(tenant?.shiftPolicy) !== "by_waiter") return false;
  return !(await getCurrentMeseroShift(userId));
}

/**
 * Inicio del rango "hoy" para el mesero:
 *   - si tiene turno personal abierto → el openedAt de ese shift
 *   - si no → medianoche local (00:00 del día actual)
 *
 * Convención: usamos UTC para la medianoche y dejamos que el cliente
 * formatee. En la práctica las cuentas de un día agrupan correctamente
 * porque el desfase Colombia/UTC (-5) es estable.
 */
export function startOfMeseroDay(openShiftAt: Date | null): Date {
  if (openShiftAt) return openShiftAt;
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}
