import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { PickupClient } from "./PickupClient";

export const dynamic = "force-dynamic";

export default async function PickupPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const { slug } = await params;
  const { t: tableToken } = await searchParams;

  const tenant = await db.restaurant.findUnique({
    where: { slug },
    include: {
      categories: { orderBy: { sortOrder: "asc" } },
      menuItems: {
        where: { available: true },
        orderBy: { sortOrder: "asc" },
      },
    },
  });
  if (!tenant) return notFound();

  if (!tenant.pickupEnabled) {
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-20 bg-bone">
        <div className="text-center max-w-sm">
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted mb-3">
            {tenant.name}
          </div>
          <h1 className="font-display text-3xl mb-3">
            Pedido anticipado no disponible
          </h1>
          <p className="text-muted">
            Este restaurante aún no activó el pedido para recoger.
          </p>
        </div>
      </main>
    );
  }

  const pickupTable = await db.table.findFirst({
    where: { restaurantId: tenant.id, number: -1 },
  });
  if (!pickupTable) return notFound();

  // Token check: if provided, must match the pickup table so stray scans fail
  // cleanly. If omitted, we still allow browsing (link sharing).
  if (tableToken && tableToken !== pickupTable.qrToken) {
    return notFound();
  }

  const session = await auth();
  const customer = session?.user?.id
    ? await db.user.findUnique({
        where: { id: session.user.id },
        select: { name: true, phone: true },
      })
    : null;

  return (
    <PickupClient
      tenant={{
        slug: tenant.slug,
        name: tenant.name,
        tagline: tenant.tagline,
      }}
      tableId={pickupTable.id}
      defaults={{
        name: customer?.name ?? "",
        phone: customer?.phone ?? "",
      }}
      categories={tenant.categories.map((c) => ({
        id: c.id,
        slug: c.slug,
        label: c.label,
      }))}
      items={tenant.menuItems.map((m) => ({
        id: m.id,
        categoryId: m.categoryId,
        name: m.name,
        description: m.description ?? "",
        priceCents: m.priceCents,
        photoUrl: m.photoUrl ?? null,
        prepMinutes: m.prepMinutes,
      }))}
    />
  );
}
