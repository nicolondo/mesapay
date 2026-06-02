import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { FacturasClient } from "./FacturasClient";

export const dynamic = "force-dynamic";

export default async function FacturasPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const t = await getTranslations("opFacturas");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const sp = await searchParams;
  const tab = sp.status === "generated" ? "generated" : "pending";

  const [pending, generated] = await Promise.all([
    db.invoiceRequest.findMany({
      where: { restaurantId, status: "pending" },
      orderBy: { createdAt: "desc" },
      include: { order: { select: { shortCode: true, totalCents: true, paidAt: true } } },
    }),
    db.invoiceRequest.findMany({
      where: { restaurantId, status: "generated" },
      orderBy: { generatedAt: "desc" },
      take: 100,
      include: { order: { select: { shortCode: true, totalCents: true, paidAt: true } } },
    }),
  ]);

  return (
    <FacturasClient
      tab={tab}
      pending={pending.map((r) => ({
        id: r.id,
        customerName: r.customerName,
        docType: r.docType,
        docNumber: r.docNumber,
        address: r.address,
        city: r.city,
        department: r.department,
        email: r.email,
        notes: r.notes,
        createdAt: r.createdAt.toISOString(),
        order: {
          shortCode: r.order.shortCode,
          totalCents: r.order.totalCents,
          paidAt: r.order.paidAt?.toISOString() ?? null,
        },
      }))}
      generated={generated.map((r) => ({
        id: r.id,
        customerName: r.customerName,
        docType: r.docType,
        docNumber: r.docNumber,
        address: r.address,
        city: r.city,
        department: r.department,
        email: r.email,
        notes: r.notes,
        createdAt: r.createdAt.toISOString(),
        generatedAt: r.generatedAt?.toISOString() ?? null,
        generatedByEmail: r.generatedByEmail,
        order: {
          shortCode: r.order.shortCode,
          totalCents: r.order.totalCents,
          paidAt: r.order.paidAt?.toISOString() ?? null,
        },
      }))}
    />
  );
}
