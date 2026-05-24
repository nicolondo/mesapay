import { redirect } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { flattenSelections } from "@/lib/modifiers";
import { KitchenBoard } from "../kitchen/KitchenBoard";

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
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const tenant = await db.restaurant.findUnique({ where: { id: restaurantId } });
  if (!tenant?.hasBar) {
    redirect("/operator/kitchen");
  }

  const { sub } = await searchParams;
  // The "sub" param accepts "_all" (default — no sub filter) and any
  // configured sub-station label. Unknown values fall back to all.
  const activeSub =
    sub && tenant.barSubStations.includes(sub) ? sub : null;

  const itemsWhere: {
    station: "bar";
    barSubStation?: string | null;
  } = { station: "bar" };
  if (activeSub) {
    itemsWhere.barSubStation = activeSub;
  }

  const rounds = await db.round.findMany({
    where: {
      order: { restaurantId },
      status: { in: ["placed", "in_kitchen", "ready"] },
      items: { some: itemsWhere },
    },
    include: {
      order: { include: { table: true } },
      items: { where: itemsWhere },
    },
    orderBy: { placedAt: "asc" },
  });

  const hasSubStations = tenant.barSubStations.length > 0;

  return (
    <>
      {hasSubStations && (
        <div className="px-6 pt-4 pb-0 flex gap-2 overflow-x-auto scroll-hide">
          <BarTab
            href="/operator/bar"
            label="Todo el bar"
            active={!activeSub}
          />
          {tenant.barSubStations.map((s) => (
            <BarTab
              key={s}
              href={`/operator/bar?sub=${encodeURIComponent(s)}`}
              label={s}
              active={activeSub === s}
            />
          ))}
        </div>
      )}
      <KitchenBoard
        mode="bar"
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
          modifiers: flattenSelections(i.modifierSelections),
          notes: i.notes ?? null,
          guestName: i.guestName ?? null,
          kitchenStatus: i.kitchenStatus,
          categoryKind: i.categoryKind,
          prepMinutesSnapshot: i.prepMinutesSnapshot,
          preparationStartedAt: i.preparationStartedAt
            ? i.preparationStartedAt.toISOString()
            : null,
          servedAt: i.servedAt ? i.servedAt.toISOString() : null,
        })),
      }))}
      />
    </>
  );
}

function BarTab({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={
        "shrink-0 px-4 h-9 inline-flex items-center rounded-full text-sm font-medium border transition-colors " +
        (active
          ? "bg-ink text-bone border-ink"
          : "bg-op-surface text-op-text border-op-border hover:bg-op-bg")
      }
    >
      {label}
    </Link>
  );
}
