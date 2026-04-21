import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import { PickupStatusLive } from "./PickupStatusLive";

export const dynamic = "force-dynamic";

export default async function PickupStatusPage({
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
      rounds: true,
      items: { orderBy: { id: "asc" } },
    },
  });
  if (!order || order.restaurantId !== tenant.id || order.orderType !== "pickup") {
    return notFound();
  }

  const round = order.rounds[0] ?? null;
  const roundStatus = round?.status ?? "placed";
  const isReady = roundStatus === "ready" || roundStatus === "served";
  const isServed = roundStatus === "served";

  return (
    <main className="flex-1 bg-bone">
      <div className="max-w-md mx-auto px-5 py-10">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-terracotta">
          Pedido para recoger
        </div>
        <div className="font-display text-3xl tracking-[-0.015em] mt-1">
          {tenant.name}
        </div>
        <div className="font-mono text-[11px] text-muted mt-1">
          Código {order.shortCode} · {order.pickupName ?? "—"}
        </div>

        <PickupStatusLive
          orderId={order.id}
          tenantSlug={tenant.slug}
          readyEtaIso={order.readyEta ? order.readyEta.toISOString() : null}
          etaMinutes={order.etaMinutes ?? 0}
          isReady={isReady}
          isServed={isServed}
        />

        <div className="mt-8 rounded-2xl border border-hairline bg-paper p-5">
          <div className="font-mono text-[10px] tracking-wider uppercase text-muted mb-3">
            Tu pedido
          </div>
          <ul className="divide-y divide-hairline">
            {order.items.map((i) => (
              <li
                key={i.id}
                className="py-2 flex items-center justify-between text-sm"
              >
                <span>
                  {i.qty}× {i.nameSnapshot}
                </span>
                <span className="font-mono tabular">
                  {fmtCOP(i.priceCentsSnapshot * i.qty)}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3 pt-3 border-t border-hairline flex items-baseline justify-between">
            <span className="font-mono text-[10px] tracking-wider uppercase text-muted">
              Pagado
            </span>
            <span className="font-display text-2xl tabular">
              {fmtCOP(order.totalCents)}
            </span>
          </div>
        </div>

        <div className="mt-8 text-center">
          <Link
            href="/me"
            className="font-mono text-[11px] tracking-wider uppercase text-muted hover:text-terracotta"
          >
            Ver mis órdenes →
          </Link>
        </div>
      </div>
    </main>
  );
}
