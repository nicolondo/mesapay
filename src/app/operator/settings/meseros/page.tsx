import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { MeserosClient } from "./MeserosClient";

export const dynamic = "force-dynamic";

export default async function MeserosSettingsPage() {
  const tr = await getTranslations("opSettings");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{tr("noRestaurant")}</div>;

  const [tables, meseros] = await Promise.all([
    db.table.findMany({
      where: { restaurantId, number: { gte: 0 } },
      select: { number: true, label: true },
      orderBy: { number: "asc" },
    }),
    db.user.findMany({
      where: { restaurantId, role: "mesero" },
      select: {
        id: true,
        email: true,
        name: true,
        assignedTableNumbers: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <Link
        href="/operator/settings"
        className="font-mono text-[11px] tracking-[0.14em] uppercase text-op-muted hover:text-ink"
      >
        {tr("backToSettings")}
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">
        {tr("meserosTitle")}
      </div>
      <p className="text-sm text-op-muted mb-6">{tr("meserosIntro")}</p>

      {meseros.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface p-8 text-center text-sm text-op-muted">
          {tr.rich("meserosEmptyNoMeseros", {
            em: (chunks) => <em>{chunks}</em>,
          })}
        </div>
      ) : tables.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface p-8 text-center text-sm text-op-muted">
          {tr("meserosNoTablesPrefix")}
          <Link
            href="/operator/tables"
            className="text-terracotta hover:underline"
          >
            {tr("meserosTablesLink")}
          </Link>
          .
        </div>
      ) : (
        <MeserosClient
          tables={tables.map((t) => ({ number: t.number, label: t.label }))}
          meseros={meseros.map((m) => ({
            id: m.id,
            email: m.email,
            name: m.name,
            assignedTableNumbers: m.assignedTableNumbers,
          }))}
        />
      )}
    </div>
  );
}
