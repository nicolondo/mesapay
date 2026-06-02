import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveGroupShellContext } from "@/lib/activeRestaurant";
import { LegalEntitiesClient } from "./LegalEntitiesClient";

export const dynamic = "force-dynamic";

export default async function LegalEntitiesPage() {
  const t = await getTranslations("opGroup");
  const ctx = await getActiveGroupShellContext();
  if (!ctx) redirect("/group");
  const items = await db.legalEntity.findMany({
    where: { groupId: ctx.groupId },
    orderBy: { name: "asc" },
    include: { _count: { select: { restaurants: true } } },
  });

  return (
    <div className="flex-1 p-4 md:p-6 max-w-4xl mx-auto w-full">
      <Link
        href="/group"
        className="font-mono text-[10px] tracking-wider uppercase text-op-muted hover:text-op-text"
      >
        {t("legalBackToGroup")}
      </Link>
      <div className="font-display text-3xl tracking-[-0.015em] mt-2 mb-1">
        {t("legalTitle")}
      </div>
      <p className="text-sm text-op-muted mb-5">
        {t("legalIntro")}
      </p>
      <LegalEntitiesClient
        initial={items.map((e) => ({
          id: e.id,
          name: e.name,
          taxId: e.taxId,
          address: e.address,
          city: e.city,
          phone: e.phone,
          dianResolution: e.dianResolution,
          dianResolutionFrom: e.dianResolutionFrom,
          dianResolutionTo: e.dianResolutionTo,
          dianResolutionDate: e.dianResolutionDate
            ? e.dianResolutionDate.toISOString().slice(0, 10)
            : null,
          invoicePrefix: e.invoicePrefix,
          invoiceNextNumber: e.invoiceNextNumber,
          restaurantCount: e._count.restaurants,
        }))}
      />
    </div>
  );
}
