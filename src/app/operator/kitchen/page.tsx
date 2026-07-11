import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { formatItemSelections } from "@/lib/modifiers";
import { KitchenBoard } from "./KitchenBoard";

export const dynamic = "force-dynamic";

export default async function KitchenPage() {
  const t = await getTranslations("kitchen");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const tenant = await db.restaurant.findUnique({ where: { id: restaurantId } });
  // Kitchen board only shows items routed to the kitchen station. A
  // round with a mix of bebidas + comida appears here too — the bebidas
  // just don't render. Empty rounds (all items routed elsewhere) are
  // filtered out below so the board doesn't show ghost tickets.
  const rounds = await db.round.findMany({
    where: {
      order: { restaurantId },
      status: { in: ["placed", "in_kitchen", "ready"] },
      // El round se cae del board cuando TODOS sus items de cocina están
      // servidos — sin depender de que Round.status pase a "served" (ese
      // roll-up post-tx puede rezagarse y deja tarjetas fantasma). El
      // include de abajo sigue mostrando los servidos tachados mientras
      // quede algún item pendiente. Mismo patrón que el board de "serve".
      items: { some: { station: "kitchen", cancelledAt: null, servedAt: null } },
    },
    include: {
      order: { include: { table: true } },
      items: {
        where: { station: "kitchen", cancelledAt: null },
        // Pull the menu item's modifier definitions so the kitchen
        // ticket renders "Adición: Carne, Pollo" instead of a flat
        // "Carne · Pollo" list with no context.
        include: { menuItem: { select: { modifiers: true } } },
      },
    },
    orderBy: { placedAt: "asc" },
  });

  // Hora del servidor al renderizar — el tablero la usa para corregir el
  // reloj del dispositivo (server component, captura intencional del tiempo).
  // eslint-disable-next-line react-hooks/purity
  const serverNowMs = Date.now();

  return (
    <KitchenBoard
      tenantSlug={tenant!.slug}
      serverNow={serverNowMs}
      serviceMode={tenant!.serviceMode}
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
          // Marca de "apurar" del mesero — el board la pinta como
          // badge urgente. Stringificada para serializarla al cliente.
          expediteRequestedAt: i.expediteRequestedAt
            ? i.expediteRequestedAt.toISOString()
            : null,
        })),
      }))}
    />
  );
}
