import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { MesasAttrsClient, type MesaRow } from "./MesasAttrsClient";

export const dynamic = "force-dynamic";

export default async function MesasSettingsPage() {
  const tr = await getTranslations("opSettings");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{tr("noRestaurant")}</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { reservationsEnabled: true },
  });

  const tables = await db.table.findMany({
    where: { restaurantId, number: { gte: 0 } },
    orderBy: { number: "asc" },
    select: {
      id: true,
      number: true,
      label: true,
      capacity: true,
      minConsumptionCents: true,
      reservationDepositCents: true,
      reservable: true,
      shape: true,
    },
  });

  const rows: MesaRow[] = tables.map((t) => ({
    id: t.id,
    number: t.number,
    label: t.label,
    capacity: t.capacity,
    minConsumptionCents: t.minConsumptionCents,
    reservationDepositCents: t.reservationDepositCents,
    reservable: t.reservable,
    shape: t.shape,
  }));

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <Link
        href="/operator/settings"
        className="text-sm text-op-muted hover:underline"
      >
        {tr("backToSettings")}
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">{tr("mesasTitle")}</div>
      <p className="text-sm text-op-muted mb-6">
        {tr("mesasIntroPart1")}
        <strong>{tr("mesasIntroDeposit")}</strong>
        {tr("mesasIntroPart2")}
        {!tenant?.reservationsEnabled && (
          <>
            {" "}
            <Link
              href="/operator/settings/reservas"
              className="text-terracotta hover:underline"
            >
              {tr("mesasIntroEnablePrefix")}
            </Link>
            {tr("mesasIntroEnableSuffix")}
          </>
        )}
      </p>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-op-border bg-op-surface px-4 py-10 text-center text-sm text-op-muted">
          {tr("mesasEmptyPrefix")}
          <Link href="/operator/tables" className="text-terracotta hover:underline">
            {tr("mesasTablesLink")}
          </Link>
          .
        </div>
      ) : (
        <MesasAttrsClient initialRows={rows} />
      )}
    </div>
  );
}
