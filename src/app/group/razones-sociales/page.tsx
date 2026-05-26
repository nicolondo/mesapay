import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { LegalEntitiesClient } from "./LegalEntitiesClient";

export const dynamic = "force-dynamic";

export default async function LegalEntitiesPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "group_admin" || !session.user.groupId) {
    redirect("/group");
  }
  const items = await db.legalEntity.findMany({
    where: { groupId: session.user.groupId },
    orderBy: { name: "asc" },
    include: { _count: { select: { restaurants: true } } },
  });

  return (
    <div className="flex-1 p-4 md:p-6 max-w-4xl mx-auto w-full">
      <Link
        href="/group"
        className="font-mono text-[10px] tracking-wider uppercase text-op-muted hover:text-op-text"
      >
        ← Grupo
      </Link>
      <div className="font-display text-3xl tracking-[-0.015em] mt-2 mb-1">
        Razones sociales
      </div>
      <p className="text-sm text-op-muted mb-5">
        Datos legales y numeración DIAN del grupo. Cada restaurante
        puede asignarse a una de estas razones sociales — locales que
        comparten razón social también comparten la numeración de
        facturas.
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
