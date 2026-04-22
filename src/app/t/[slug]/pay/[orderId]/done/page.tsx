import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import { CounterStatusLive } from "./CounterStatusLive";

export const dynamic = "force-dynamic";

export default async function PayDone({
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
      rounds: { orderBy: { seq: "asc" } },
      items: { orderBy: { id: "asc" } },
    },
  });
  if (!order || order.restaurantId !== tenant.id) return notFound();

  // Table-mode (and pickup that somehow lands here): keep the simple
  // thank-you screen. Counter-mode needs the live tracker so the diner can
  // watch their order until it's ready at the counter.
  if (tenant.serviceMode !== "counter") {
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-16 bg-bone">
        <div className="text-center max-w-sm">
          <div className="w-14 h-14 rounded-full bg-ok/20 text-ok mx-auto flex items-center justify-center font-display text-3xl check-pop">
            ✓
          </div>
          <h1 className="font-display text-4xl tracking-[-0.015em] mt-5">
            ¡Pago recibido!
          </h1>
          <p className="text-muted mt-3">
            Gracias por visitarnos. Esperamos verte pronto.
          </p>
          <Link
            href={`/t/${slug}`}
            className="mt-8 inline-flex h-11 px-5 rounded-full bg-ink text-bone font-medium items-center"
          >
            Volver al inicio
          </Link>
        </div>
      </main>
    );
  }

  // Counter-mode status derived from the single round. Food-truck orders
  // always have exactly one round (no round 2+ in prepay).
  const round = order.rounds[0] ?? null;
  const roundStatus = round?.status ?? "placed";
  const isReady = roundStatus === "ready" || roundStatus === "served";
  const isServed = roundStatus === "served";

  return (
    <main className="flex-1 bg-bone">
      <div className="max-w-md mx-auto px-5 py-10">
        <CounterStatusLive orderId={order.id} tenantSlug={tenant.slug} />

        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-terracotta">
          Pedido pagado
        </div>
        <div className="font-display text-3xl tracking-[-0.015em] mt-1">
          {tenant.name}
        </div>

        <div className="mt-6 rounded-2xl border border-hairline bg-paper p-6 text-center">
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted">
            Tu código
          </div>
          <div className="font-display text-6xl leading-none mt-2 tabular">
            {order.shortCode}
          </div>
          <div className="text-sm text-muted mt-3">
            Muéstralo al cajero cuando te avisen.
          </div>
        </div>

        {isServed ? (
          <div className="mt-6 rounded-2xl bg-ink text-bone p-6 text-center">
            <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-bone/70">
              Entregado
            </div>
            <div className="font-display text-3xl mt-2">
              Gracias por comer con nosotros
            </div>
          </div>
        ) : isReady ? (
          <div className="mt-6 rounded-2xl bg-ok text-bone p-8 text-center">
            <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-bone/80">
              ¡Tu pedido está listo!
            </div>
            <div className="font-display text-4xl mt-2 leading-[1.05]">
              Pasa por el mostrador
            </div>
          </div>
        ) : (
          <div className="mt-6 rounded-2xl bg-paper border border-hairline p-6 text-center">
            <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted">
              En preparación
            </div>
            <div className="font-display text-3xl mt-2">Estamos cocinando</div>
            <div className="text-sm text-muted mt-3">
              Te avisamos aquí cuando esté listo.
            </div>
          </div>
        )}

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
      </div>
    </main>
  );
}
