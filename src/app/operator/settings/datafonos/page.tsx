import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { DatafonosClient } from "./DatafonosClient";

export const dynamic = "force-dynamic";

export default async function DatafonosSettingsPage() {
  const t = await getTranslations("opSettings");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const [devices, users] = await Promise.all([
    db.terminalDevice.findMany({
      where: { restaurantId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        label: true,
        kushkiDeviceId: true,
        active: true,
        assignedUserId: true,
        lastSeenAt: true,
      },
    }),
    db.user.findMany({
      where: {
        restaurantId,
        // Only users that make sense as Smart POS owners.
        role: { in: ["mesero", "operator", "terminal"] },
      },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <Link
        href="/operator/settings"
        className="font-mono text-[11px] tracking-[0.14em] uppercase text-op-muted hover:text-ink"
      >
        {t("backToSettings")}
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">
        {t("datafonosTitle")}
      </div>
      <p className="text-sm text-op-muted mb-6">{t("datafonosIntro")}</p>

      {devices.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface p-8 text-center text-sm text-op-muted">
          {t("datafonosEmpty")}
        </div>
      ) : (
        <DatafonosClient
          initial={devices.map((d) => ({
            id: d.id,
            label: d.label,
            kushkiDeviceId: d.kushkiDeviceId,
            active: d.active,
            assignedUserId: d.assignedUserId,
            lastSeenAt: d.lastSeenAt
              ? d.lastSeenAt.toISOString()
              : null,
          }))}
          users={users.map((u) => ({
            id: u.id,
            label: u.name?.trim() || u.email,
            email: u.email,
            role: u.role,
          }))}
        />
      )}
    </div>
  );
}
