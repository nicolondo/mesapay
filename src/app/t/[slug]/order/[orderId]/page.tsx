import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import Link from "next/link";
import { fmtCOP } from "@/lib/format";
import { OrderLive } from "./OrderLive";
import { computeRoundEtas, type EtaRoundInput } from "@/lib/eta";
import { EtaBadge, OrderEta } from "./EtaBadge";
import { RatingInline } from "./RatingInline";
import { CancelItemButton } from "./CancelItemButton";
import { CallWaiterButton } from "./CallWaiterButton";

export default async function OrderView({
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
      items: {
        include: { menuItem: true, rating: true, round: true },
        orderBy: { id: "asc" },
      },
      rounds: { orderBy: { seq: "asc" } },
    },
  });
  if (!order || order.restaurantId !== tenant.id) return notFound();

  const cancelledRounds = order.rounds.filter((r) => r.status === "cancelled");
  // Recent cancellations get a prominent banner. We treat the most recent
  // ones as "new" so the customer sees the apology even if they were
  // already on the page when the kitchen pressed cancel.
  const cancelledLines = cancelledRounds.flatMap((r) => {
    const items = order.items.filter((i) => i.roundId === r.id);
    return items.map((i) => ({
      itemName: i.nameSnapshot,
      qty: i.qty,
      reason: r.cancellationReason ?? "",
      cancelledAt: r.cancelledAt,
    }));
  });

  // Build the restaurant-wide cooking queue so the ETA walks the actual FIFO
  // line, not just this order's rounds.
  const queueRounds = await db.round.findMany({
    where: {
      order: { restaurantId: tenant.id },
      status: { in: ["placed", "in_kitchen", "ready"] },
    },
    include: { items: { include: { menuItem: { select: { prepMinutes: true } } } } },
  });
  const etaInputs: EtaRoundInput[] = queueRounds.map((r) => ({
    id: r.id,
    status: r.status,
    placedAt: r.placedAt,
    kitchenStartedAt: r.kitchenStartedAt,
    readyAt: r.readyAt,
    itemPrepMinutes: r.items.map((i) => i.menuItem.prepMinutes),
  }));
  const etas = computeRoundEtas(etaInputs);

  return (
    <main className="flex flex-1 flex-col px-5 py-8 max-w-2xl mx-auto w-full">
      <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">
        {tenant.serviceMode === "counter"
          ? `Mostrador · ${tenant.name}`
          : `Mesa ${order.table.number} · ${tenant.name}`}
      </div>
      <h1 className="font-display text-4xl tracking-[-0.015em] mt-1">
        Tu pedido <span className="font-mono text-base text-muted">· {order.shortCode}</span>
      </h1>

      <OrderLive orderId={order.id} tenantSlug={slug} initialStatus={order.status} />

      {cancelledLines.length > 0 && (
        <div className="mt-5 rounded-2xl border border-danger/40 bg-danger/5 p-4">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-danger/15 text-danger flex items-center justify-center text-lg shrink-0">
              !
            </div>
            <div className="flex-1">
              <div className="font-display text-lg text-danger">
                {cancelledLines.length === 1
                  ? "Un plato de tu pedido fue cancelado"
                  : `${cancelledLines.length} platos de tu pedido fueron cancelados`}
              </div>
              <p className="text-sm text-ink-3 mt-1">
                El mesero pasará por tu mesa para avisarte. No se te va a
                cobrar lo cancelado.
              </p>
              <ul className="mt-3 space-y-1.5">
                {cancelledLines.map((c, i) => (
                  <li
                    key={i}
                    className="bg-paper border border-hairline rounded-lg px-3 py-2 text-sm"
                  >
                    <div className="font-medium">
                      <span className="line-through text-muted">
                        {c.qty}× {c.itemName}
                      </span>
                    </div>
                    {c.reason && (
                      <div className="text-[12px] text-ink-3 mt-0.5">
                        Motivo: <span className="italic">{c.reason}</span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {tenant.serviceMode !== "counter" &&
        order.status !== "paid" &&
        order.status !== "cancelled" && (
          <div className="mt-5">
            <CallWaiterButton
              tenantSlug={slug}
              orderId={order.id}
              initialNeedsWaiter={order.needsWaiter}
              initialCalledAtISO={
                order.waiterCalledAt ? order.waiterCalledAt.toISOString() : null
              }
            />
          </div>
        )}

      {(() => {
        const pendingEtas = order.rounds
          .filter((r) => r.status === "placed" || r.status === "in_kitchen")
          .map((r) => etas.get(r.id)?.etaAt)
          .filter((d): d is Date => !!d);
        if (pendingEtas.length === 0) return null;
        const latest = new Date(Math.max(...pendingEtas.map((d) => d.getTime())));
        return (
          <div className="mt-5">
            <OrderEta etaAtISO={latest.toISOString()} />
          </div>
        );
      })()}

      <div className="mt-8">
        <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted mb-2">
          Rondas
        </div>
        <ul className="space-y-2">
          {order.rounds.map((r) => {
            const lines = order.items.filter((i) => i.roundId === r.id);
            const tint = statusBadge(r.status);
            const eta = etas.get(r.id);
            const isPending = r.status === "placed" || r.status === "in_kitchen";
            const isCancelled = r.status === "cancelled";
            return (
              <li
                key={r.id}
                className={
                  "border rounded-xl p-4 " +
                  (isCancelled
                    ? "border-danger/30 bg-danger/5"
                    : "border-hairline bg-paper")
                }
              >
                <div className="flex items-center justify-between">
                  <div className="font-mono text-xs tracking-wider uppercase text-muted">
                    Ronda {r.seq}
                  </div>
                  <div className="flex items-center gap-2">
                    {isPending && eta && (
                      <EtaBadge etaAtISO={eta.etaAt.toISOString()} />
                    )}
                    <span
                      className={
                        "px-2 h-6 inline-flex items-center rounded-full text-[11px] font-medium " +
                        tint
                      }
                    >
                      {statusLabel(r.status)}
                    </span>
                  </div>
                </div>
                {isCancelled && r.cancellationReason && (
                  <div className="mt-2 text-xs text-danger">
                    Motivo de cancelación:{" "}
                    <span className="italic">{r.cancellationReason}</span>
                  </div>
                )}
                <ul className="mt-2 divide-y divide-hairline">
                  {lines.map((li) => (
                    <li key={li.id} className="py-2">
                      <div className="flex justify-between gap-3">
                        <div className="flex-1">
                          <div
                            className={
                              "text-sm " +
                              (isCancelled
                                ? "line-through text-muted"
                                : "")
                            }
                          >
                            {li.qty}× {li.nameSnapshot}
                          </div>
                          {li.guestName && (
                            <div className="text-[11px] text-terracotta mt-0.5">
                              de {li.guestName}
                            </div>
                          )}
                          {li.modifierSelections && typeof li.modifierSelections === "object" && (
                            <div className="text-xs text-muted mt-0.5">
                              {Object.values(li.modifierSelections as Record<string, string>).join(" · ")}
                            </div>
                          )}
                        </div>
                        <div className="font-mono text-sm tabular">
                          {fmtCOP(li.priceCentsSnapshot * li.qty)}
                        </div>
                      </div>
                      {li.kitchenStatus === "placed" && !li.servedAt && (
                        <div className="mt-1.5">
                          <CancelItemButton
                            orderItemId={li.id}
                            tenantSlug={slug}
                            itemName={li.nameSnapshot}
                          />
                        </div>
                      )}
                      {li.servedAt && (
                        <div className="mt-2">
                          <RatingInline
                            orderItemId={li.id}
                            tenantSlug={slug}
                            existing={
                              li.rating
                                ? { stars: li.rating.stars, comment: li.rating.comment }
                                : null
                            }
                            defaultGuestName={li.guestName ?? null}
                          />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      </div>

      {(() => {
        const groups = new Map<
          string,
          { name: string; items: typeof order.items; subtotal: number }
        >();
        // Skip cancelled-round items — they don't count toward anyone's
        // tab anymore.
        const liveItems = order.items.filter(
          (i) => !i.round || i.round.status !== "cancelled",
        );
        for (const i of liveItems) {
          const key = i.guestName?.trim() || "__anon__";
          const label = i.guestName?.trim() || "Sin nombre";
          const entry =
            groups.get(key) ??
            { name: label, items: [] as typeof order.items, subtotal: 0 };
          entry.items.push(i);
          entry.subtotal += i.priceCentsSnapshot * i.qty;
          groups.set(key, entry);
        }
        const multi = groups.size > 1;
        if (!multi) return null;
        return (
          <div className="mt-8">
            <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted mb-2">
              Por persona
            </div>
            <ul className="space-y-2">
              {Array.from(groups.values()).map((g) => (
                <li
                  key={g.name}
                  className="border border-hairline rounded-xl p-4 bg-paper"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="w-7 h-7 rounded-full bg-terracotta text-paper font-display text-sm inline-flex items-center justify-center">
                        {g.name.charAt(0).toUpperCase()}
                      </span>
                      <div className="font-display text-lg">{g.name}</div>
                    </div>
                    <div className="font-mono text-sm tabular">
                      {fmtCOP(g.subtotal)}
                    </div>
                  </div>
                  <ul className="mt-2 divide-y divide-hairline">
                    {g.items.map((li) => (
                      <li
                        key={li.id}
                        className="py-1.5 flex justify-between gap-3 text-sm"
                      >
                        <div>
                          {li.qty}× {li.nameSnapshot}
                        </div>
                        <div className="font-mono tabular text-ink-3">
                          {fmtCOP(li.priceCentsSnapshot * li.qty)}
                        </div>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
        );
      })()}

      <div className="mt-8 border-t border-hairline pt-5 flex items-center justify-between">
        <div>
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
            Subtotal
          </div>
          <div className="font-display text-3xl">{fmtCOP(order.subtotalCents)}</div>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/t/${slug}/menu?table=${order.table.qrToken}&order=${order.id}`}
            className="h-11 px-5 rounded-full border border-hairline inline-flex items-center text-sm font-medium"
          >
            Añadir más
          </Link>
          <Link
            href={`/t/${slug}/pay/${order.id}`}
            className="h-11 px-5 rounded-full bg-ink text-bone inline-flex items-center text-sm font-medium"
          >
            Pagar
          </Link>
        </div>
      </div>
    </main>
  );
}

function statusLabel(s: string) {
  switch (s) {
    case "open": return "Abierto";
    case "placed": return "Enviado";
    case "in_kitchen": return "En cocina";
    case "ready": return "Listo";
    case "served": return "Servido";
    case "paying": return "Cobrando";
    case "paid": return "Pagado";
    case "cancelled": return "Cancelado";
    default: return s;
  }
}
function statusBadge(s: string) {
  switch (s) {
    case "ready":
    case "served":
    case "paid":
      return "bg-[#2E6B4C]/15 text-[#1E5339]";
    case "in_kitchen":
    case "placed":
      return "bg-[#C98A2E]/15 text-[#8F6828]";
    case "cancelled":
      return "bg-danger/15 text-danger";
    default:
      return "bg-paper text-muted";
  }
}
