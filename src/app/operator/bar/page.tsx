import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { formatItemSelections } from "@/lib/modifiers";
import { KitchenBoard } from "../kitchen/KitchenBoard";
import { BarSubTabs } from "./BarSubTabs";

export const dynamic = "force-dynamic";

/**
 * Bar board. Same UX as the kitchen board (minus the "in_kitchen"
 * column — bar items go straight placed → ready), scoped to items
 * routed to `station="bar"`. Only reachable when the restaurant has
 * hasBar=true; a passing operator without the flag is bounced to
 * /operator/kitchen.
 *
 * Sub-stations: if the restaurant defined `barSubStations` (e.g.
 * Cocteles, Cafetería, Cervezas), this page surfaces tabs to filter.
 * Each sub-station is intended to run on its own screen, so different
 * bartenders see only their own queue.
 *
 * A round with mixed station items still shows up in both boards, each
 * scoped to its own. Round "ready" is computed across all items.
 */
export default async function BarPage({
  searchParams,
}: {
  searchParams: Promise<{ sub?: string }>;
}) {
  const t = await getTranslations("kitchen");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const tenant = await db.restaurant.findUnique({ where: { id: restaurantId } });
  if (!tenant?.hasBar) {
    redirect("/operator/kitchen");
  }

  const { sub } = await searchParams;
  // The "sub" param accepts "_all" (default — no sub filter) and any
  // configured sub-station label. Unknown values fall back to all.
  const activeSub =
    sub && tenant.barSubStations.includes(sub) ? sub : null;

  const itemsWhere: Prisma.OrderItemWhereInput = {
    station: "bar",
    cancelledAt: null,
  };
  if (activeSub) {
    // Filtramos por la sub-estación ACTUAL de la categoría del producto (vía
    // la relación menuItem → category), NO por el snapshot OrderItem.barSub-
    // Station. Así reasignar categorías re-agrupa al instante y los pedidos
    // enviados antes de asignar la sub-estación también se filtran bien.
    itemsWhere.menuItem = { category: { barSubStation: activeSub } };
  }

  const rounds = await db.round.findMany({
    where: {
      order: { restaurantId },
      status: { in: ["placed", "in_kitchen", "ready"] },
      // El round se cae del board cuando TODOS sus items de esta estación
      // están servidos — sin depender de que Round.status pase a "served"
      // (ese roll-up post-tx puede rezagarse y deja tarjetas fantasma). El
      // include de abajo sigue mostrando los servidos tachados mientras
      // quede algún item pendiente. Mismo patrón que el board de "serve".
      items: { some: { ...itemsWhere, servedAt: null } },
    },
    include: {
      order: { include: { table: true } },
      items: {
        where: itemsWhere,
        include: { menuItem: { select: { modifiers: true } } },
      },
    },
    orderBy: { placedAt: "asc" },
  });

  const hasSubStations = tenant.barSubStations.length > 0;
  // Hora del servidor al renderizar — el bar la usa para corregir el reloj
  // del dispositivo (server component, captura intencional del tiempo actual).
  // eslint-disable-next-line react-hooks/purity
  const serverNowMs = Date.now();

  return (
    <>
      {hasSubStations && (
        <BarSubTabs
          subStations={tenant.barSubStations}
          activeSub={activeSub}
          allLabel={t("barTabAll")}
        />
      )}
      <KitchenBoard
        mode="bar"
        serverNow={serverNowMs}
        tenantSlug={tenant.slug}
        serviceMode={tenant.serviceMode}
        rounds={rounds.map((r) => ({
        id: r.id,
        seq: r.seq,
        status: r.status as "placed" | "in_kitchen" | "ready",
        placedAt: r.placedAt.toISOString(),
        readyAt: r.readyAt ? r.readyAt.toISOString() : null,
        order: {
          id: r.order.id,
          shortCode: r.order.shortCode,
          tableNumber: r.order.table.number,
          servingMode: r.order.servingMode,
          orderType: r.order.orderType as "dineIn" | "pickup",
          pickupName: r.order.pickupName,
          etaMinutes: r.order.etaMinutes,
          readyEta: r.order.readyEta ? r.order.readyEta.toISOString() : null,
        },
        items: r.items.map((i) => ({
          id: i.id,
          qty: i.qty,
          name: i.nameSnapshot,
          modifiers: formatItemSelections(
            i.modifierSelections,
            i.menuItem?.modifiers,
          ),
          notes: i.notes ?? null,
          guestName: i.guestName ?? null,
          kitchenStatus: i.kitchenStatus,
          categoryKind: i.categoryKind,
          prepMinutesSnapshot: i.prepMinutesSnapshot,
          preparationStartedAt: i.preparationStartedAt
            ? i.preparationStartedAt.toISOString()
            : null,
          servedAt: i.servedAt ? i.servedAt.toISOString() : null,
          expediteRequestedAt: i.expediteRequestedAt
            ? i.expediteRequestedAt.toISOString()
            : null,
        })),
      }))}
      />
    </>
  );
}
