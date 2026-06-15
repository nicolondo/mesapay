import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { fmtCOP } from "@/lib/format";
import { formatItemSelections } from "@/lib/modifiers";
import { OrderLive } from "./OrderLive";
import { computeRoundEtas, type EtaRoundInput } from "@/lib/eta";
import { EtaBadge, OrderEta } from "./EtaBadge";
import { RatingInline } from "./RatingInline";
import { CancelItemButton } from "./CancelItemButton";
import { CallWaiterButton } from "./CallWaiterButton";
import { syncOrderSubtotalFromLiveItems } from "@/lib/orderTotals";

export default async function OrderView({
  params,
}: {
  params: Promise<{ slug: string; orderId: string }>;
}) {
  const { slug, orderId } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant) return notFound();

  // Defensive: re-derive subtotal from live items in case a previous
  // cancellation didn't recompute it (older code path, race, etc.). This
  // is idempotent and a no-op when the stored value already matches.
  await syncOrderSubtotalFromLiveItems(orderId);

  const order = await db.order.findUnique({
    where: { id: orderId },
    include: {
      table: true,
      items: {
        where: { cancelledAt: null },
        include: { menuItem: true, rating: true, round: true },
        orderBy: { id: "asc" },
      },
      rounds: { orderBy: { seq: "asc" } },
    },
  });
  if (!order || order.restaurantId !== tenant.id) return notFound();

  // Último Payment aprobado de la orden — lo usamos para linkear al
  // /done page donde están los botones de tirilla / factura. Cuando
  // hay múltiples pagos (split), el más reciente sirve como ancla.
  const lastApprovedPayment =
    order.status === "paid"
      ? await db.payment.findFirst({
          where: { orderId: order.id, status: "approved" },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        })
      : null;

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
  const t = await getTranslations("order");

  return (
    <main className="flex flex-1 flex-col px-5 py-8 max-w-2xl mx-auto w-full">
      <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">
        {tenant.serviceMode === "counter"
          ? t("locationCounter", { name: tenant.name })
          : t("locationTable", { number: order.table.number, name: tenant.name })}
      </div>
      <h1 className="font-display text-4xl tracking-[-0.015em] mt-1">
        {t("yourOrder")}{" "}
        <span className="font-mono text-base text-muted">· {order.shortCode}</span>
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
                {t("cancelledTitle", { count: cancelledLines.length })}
              </div>
              <p className="text-sm text-ink-3 mt-1">{t("cancelledBody")}</p>
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
                        {t("reasonLabel")}{" "}
                        <span className="italic">{c.reason}</span>
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
          {t("rounds")}
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
                    {t("roundN", { seq: r.seq })}
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
                      {statusLabel(r.status, t)}
                    </span>
                  </div>
                </div>
                {isCancelled && r.cancellationReason && (
                  <div className="mt-2 text-xs text-danger">
                    {t("cancelReasonLabel")}{" "}
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
                              "text-sm flex items-center gap-2 flex-wrap " +
                              (isCancelled
                                ? "line-through text-muted"
                                : "")
                            }
                          >
                            <span>{li.qty}× {li.nameSnapshot}</span>
                            {!isCancelled && (
                              <ItemStatusBadge
                                kitchenStatus={li.kitchenStatus}
                                servedAt={li.servedAt}
                                t={t}
                              />
                            )}
                          </div>
                          {li.guestName && (
                            <div className="text-[11px] text-terracotta mt-0.5">
                              {t("by")} {li.guestName}
                            </div>
                          )}
                          {(() => {
                            // Resolve modifier group labels from the
                            // menu item's live definition so the
                            // diner reads "Adición: Carne, Pollo"
                            // instead of a bare "Carne · Pollo · ..."
                            const groups = formatItemSelections(
                              li.modifierSelections,
                              li.menuItem?.modifiers,
                            );
                            if (groups.length === 0) return null;
                            return (
                              <div className="text-xs text-muted mt-0.5 space-y-0.5">
                                {groups.map((g, i) => (
                                  <div key={i}>- {g}</div>
                                ))}
                              </div>
                            );
                          })()}
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
          const label = i.guestName?.trim() || t("noName");
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
              {t("perPerson")}
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
            {t("subtotal")}
          </div>
          <div className="font-display text-3xl">{fmtCOP(order.subtotalCents)}</div>
        </div>
        {/* Acciones solo cuando la cuenta sigue abierta. Una orden ya
            paid / cancelled no tiene nada más para cobrar ni para
            añadir — el cliente llegó acá desde "Ver pedido completo"
            del done page para mirar la cuenta, no para volver a pagar. */}
        {order.status !== "paid" && order.status !== "cancelled" ? (
          <div className="flex gap-2">
            <Link
              href={`/t/${slug}/menu?table=${order.table.qrToken}&order=${order.id}`}
              className="h-11 px-5 rounded-full border border-hairline inline-flex items-center text-sm font-medium"
            >
              {t("addMore")}
            </Link>
            <Link
              href={`/t/${slug}/pay/${order.id}`}
              className="h-11 px-5 rounded-full bg-ink text-bone inline-flex items-center text-sm font-medium"
            >
              {t("pay")}
            </Link>
          </div>
        ) : order.status === "cancelled" ? (
          // Orden cancelada: el cliente puede volver a la carta y arrancar un
          // pedido nuevo (no se reanuda la cancelada — el menú la excluye).
          <Link
            href={`/t/${slug}/menu?table=${order.table.qrToken}`}
            className="h-11 px-5 rounded-full bg-ink text-bone inline-flex items-center text-sm font-medium"
          >
            {t("orderAgain")}
          </Link>
        ) : (
          <span className="h-11 px-4 rounded-full bg-[#2E6B4C]/15 text-[#1E5339] inline-flex items-center text-sm font-medium">
            {t("paidPill")}
          </span>
        )}
      </div>

      {/* Comprobante — link explícito al /done que tiene los botones de
          tirilla por email + factura electrónica. Mostramos sólo en
          orden pagada y con al menos un Payment aprobado de referencia
          (en split bills usamos el más reciente como ancla — sirve para
          que la página /done pueda mostrar el resumen del último cobro
          mientras los botones aplican a la orden completa). */}
      {order.status === "paid" && lastApprovedPayment && (
        <div className="mt-5 rounded-2xl border border-hairline bg-paper p-4 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="font-display text-lg leading-tight">
              {t("needReceipt")}
            </div>
            <p className="text-xs text-muted mt-0.5">{t("receiptHint")}</p>
          </div>
          <Link
            href={`/t/${slug}/pay/${order.id}/done?pid=${lastApprovedPayment.id}`}
            className="shrink-0 h-10 px-4 rounded-full bg-ink text-bone inline-flex items-center text-sm font-medium"
          >
            {t("viewOptions")}
          </Link>
        </div>
      )}
    </main>
  );
}

function statusLabel(
  s: string,
  t: Awaited<ReturnType<typeof getTranslations>>,
) {
  switch (s) {
    case "open": return t("statusOpen");
    case "placed": return t("statusPlaced");
    case "in_kitchen": return t("statusInKitchen");
    case "ready": return t("statusReady");
    case "served": return t("statusServed");
    case "paying": return t("statusPaying");
    case "paid": return t("statusPaid");
    case "cancelled": return t("statusCancelled");
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

// Per-item status chip shown next to the dish name on the diner's
// order view. The KitchenState enum + servedAt give us four ordered
// stages: placed → in_kitchen → ready → served. We map them to plain
// Spanish so the diner sees "Listo para servir" rather than "ready".
function ItemStatusBadge({
  kitchenStatus,
  servedAt,
  t,
}: {
  kitchenStatus: "placed" | "in_kitchen" | "ready";
  servedAt: Date | null;
  t: Awaited<ReturnType<typeof getTranslations>>;
}) {
  let label: string;
  let className: string;
  if (servedAt) {
    label = t("itemServed");
    // Strongest "done" colour — matches the order's "paid" pill.
    className = "bg-[#2E6B4C]/15 text-[#1E5339]";
  } else if (kitchenStatus === "ready") {
    label = t("itemReady");
    // Same green family as Servido but with a dot to signal "not on
    // the table yet". We keep one accent colour for done-ish states so
    // the diner reads them at a glance.
    className = "bg-[#2E6B4C]/10 text-[#1E5339]";
  } else if (kitchenStatus === "in_kitchen") {
    label = t("itemPreparing");
    className = "bg-[#C98A2E]/15 text-[#8F6828]";
  } else {
    label = t("itemPending");
    className = "bg-paper text-muted border border-hairline";
  }
  return (
    <span
      className={
        "px-1.5 h-5 inline-flex items-center rounded-full text-[10px] font-medium tracking-wide " +
        className
      }
    >
      {label}
    </span>
  );
}
