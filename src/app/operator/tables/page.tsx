import { auth } from "@/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function TablesPage() {
  const session = await auth();
  const restaurantId = session!.user!.restaurantId;
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const tenant = await db.restaurant.findUnique({ where: { id: restaurantId } });
  const tables = await db.table.findMany({
    where: { restaurantId },
    orderBy: { number: "asc" },
    include: {
      orders: {
        where: { status: { not: "paid" } },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });

  const base =
    process.env.APP_PUBLIC_BASE_URL ?? "http://localhost:3300";

  return (
    <div className="p-6 max-w-5xl mx-auto w-full">
      <div className="font-display text-3xl mb-4">Mesas</div>
      <p className="text-sm text-op-muted mb-4">
        Cada mesa tiene un enlace QR único. Imprímelo y colócalo en la mesa.
      </p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {tables.map((t) => {
          const url = `${base}/t/${tenant!.slug}/menu?table=${t.qrToken}`;
          const active = t.orders.length > 0;
          return (
            <div
              key={t.id}
              className="bg-op-surface border border-op-border rounded-2xl p-4"
            >
              <div className="flex items-center justify-between">
                <div className="font-display text-2xl">Mesa {t.number}</div>
                <span
                  className={
                    "w-2 h-2 rounded-full " +
                    (active ? "bg-terracotta" : "bg-op-border-2")
                  }
                  title={active ? "Orden abierta" : "Libre"}
                />
              </div>
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="mt-2 block text-xs text-terracotta font-mono break-all hover:underline"
              >
                {url}
              </a>
            </div>
          );
        })}
      </div>
    </div>
  );
}
