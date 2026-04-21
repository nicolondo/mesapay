import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { PayClient } from "./PayClient";

export default async function PayPage({
  params,
}: {
  params: Promise<{ slug: string; orderId: string }>;
}) {
  const { slug, orderId } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant) return notFound();

  const order = await db.order.findUnique({
    where: { id: orderId },
    include: {
      table: true,
      payments: true,
      items: { orderBy: { id: "asc" } },
    },
  });
  if (!order || order.restaurantId !== tenant.id) return notFound();

  const paidCents = order.payments
    .filter((p) => p.status === "approved")
    .reduce((s, p) => s + p.amountCents, 0);

  return (
    <PayClient
      tenantSlug={slug}
      tenantName={tenant.name}
      orderId={order.id}
      shortCode={order.shortCode}
      locationLabel={
        tenant.serviceMode === "counter"
          ? "Mostrador"
          : `Mesa ${order.table.number}`
      }
      subtotalCents={order.subtotalCents}
      paidCents={paidCents}
      alreadyPaid={order.status === "paid"}
      items={order.items.map((i) => ({
        id: i.id,
        name: i.nameSnapshot,
        qty: i.qty,
        priceCents: i.priceCentsSnapshot,
        guestName: i.guestName,
      }))}
    />
  );
}
