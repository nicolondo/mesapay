import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { loadOrderCancelledItems } from "@/lib/orders/cancelledItemsQuery";

// Mismo allow-list que `/detail`: quien ve la ficha de la mesa ve también lo
// que se canceló de ella.
const ALLOWED_ROLES = new Set([
  "operator",
  "platform_admin",
  "group_admin",
  "mesero",
  "kitchen",
  "bar",
]);

/**
 * Platos cancelados de una cuenta — el desplegable «Platos cancelados» de la
 * ficha de la mesa. La ficha lo pide al abrir y cada vez que su refresco trae
 * un cambio en los platos vivos. Sólo informativo: quién, cuándo y por qué.
 */
async function GETHandler(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || !ALLOWED_ROLES.has(session.user.role)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  // La consulta ya filtra por el comercio activo: una cuenta de otro comercio
  // responde igual que una que no existe.
  const result = await loadOrderCancelledItems(id, restaurantId);
  if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(result);
}

export const GET = secureApi(GETHandler);
