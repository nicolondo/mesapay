import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { toSoldOutItems } from "@/lib/menuSoldOut";

// Platos que hoy no se ofrecen (`available = false`) del comercio activo,
// con su categoría y ordenados como la carta. Lo consume la pantalla Cierre:
// al abrir el turno muestra la lista para que el operador vuelva a poner
// disponibles los que sí haya, y mientras el turno está abierto deja un
// recordatorio. Es una lectura aparte del POST /shifts/open para servir
// también al turno abierto automáticamente por un mesero (autoOpened).
// Volverlos a ofrecer usa el PATCH /menu-items/[id] del editor de carta.

export const dynamic = "force-dynamic";

async function GETHandler() {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin" && session.user.role !== "group_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no restaurant" }, { status: 400 });
  }

  const rows = await db.menuItem.findMany({
    where: { restaurantId, available: false },
    select: {
      id: true,
      name: true,
      sortOrder: true,
      updatedAt: true,
      category: {
        select: {
          label: true,
          sortOrder: true,
          parent: { select: { label: true, sortOrder: true } },
        },
      },
    },
  });

  return NextResponse.json({ items: toSoldOutItems(rows) });
}

export const GET = secureApi(GETHandler);
