import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import { formatItemSelections } from "@/lib/modifiers";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { TableActions } from "../../tables/TableActions";

export const dynamic = "force-dynamic";

export default async function OperatorOrderDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const t = await getTranslations("opOrders");
  const { id } = await params;
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const order = await db.order.findUnique({
    where: { id },
    include: {
      table: true,
      items: {
        orderBy: { id: "asc" },
        include: { menuItem: { select: { modifiers: true } } },
      },
      rounds: { orderBy: { seq: "asc" } },
      payments: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!order || order.restaurantId !== restaurantId) return notFound();
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { serviceMode: true, slug: true },
  });
  const counterMode = tenant?.serviceMode === "counter";

  const groups = new Map<
    string,
    { name: string; items: typeof order.items; subtotal: number }
  >();
  for (const i of order.items) {
    const key = i.guestName?.trim() || "__anon__";
    const label = i.guestName?.trim() || t("noName");
    const entry =
      groups.get(key) ?? { name: label, items: [] as typeof order.items, subtotal: 0 };
    entry.items.push(i);
    entry.subtotal += i.priceCentsSnapshot * i.qty;
    groups.set(key, entry);
  }
  const multiGuest = groups.size > 1;

  const paidSum = order.payments
    .filter((p) => p.status === "approved")
    .reduce((s, p) => s + p.amountCents, 0);
  // foodPaid = approved (amount - tip). Drives whether the Cobrar
  // shortcut shows on the actions card.
  const paidFood = order.payments
    .filter((p) => p.status === "approved")
    .reduce((s, p) => s + p.amountCents - p.tipCents, 0);
  const outstandingCents = Math.max(0, order.subtotalCents - paidFood);

  return (
    <div className="p-6 max-w-4xl mx-auto w-full">
      <div className="mb-4">
        <Link
          href="/operator/orders"
          className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted hover:text-op-text"
        >
          <span aria-hidden>{"← "}</span>
          {t("back")}
        </Link>
      </div>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-op-muted">
            {t("datetime", {
              channel: counterMode
                ? t("channelCounter")
                : t("tableNumber", { number: order.table.number }),
              datetime: fmtDateTime(order.createdAt),
            })}
          </div>
          <div className="font-display text-3xl tracking-[-0.015em] mt-1">
            {t("detailTitle")}{" "}
            <span className="font-mono text-base text-op-muted">
              <span aria-hidden>{"· "}</span>
              {order.shortCode}
            </span>
          </div>
        </div>
        <StatusPill status={order.status} />
      </div>

      <div className="mt-5 grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label={t("statSubtotal")} value={fmtCOP(order.subtotalCents)} />
        <Stat
          label={t("statTip")}
          value={order.tipCents ? fmtCOP(order.tipCents) : "—"}
        />
        <Stat label={t("statPaid")} value={paidSum === 0 ? "—" : fmtCOP(paidSum)} />
        <Stat
          label={t("statRemaining")}
          value={
            order.status === "paid"
              ? "—"
              : fmtCOP(Math.max(0, order.totalCents - paidSum) || order.subtotalCents - paidSum)
          }
        />
      </div>

      {order.status !== "paid" && order.status !== "cancelled" && (
        <div className="mt-4 bg-op-surface border border-op-border rounded-2xl p-4">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
            {t("actions")}
          </div>
          <TableActions
            orderId={order.id}
            tenantSlug={tenant!.slug}
            status={order.status}
            outstandingCents={outstandingCents}
          />
        </div>
      )}

      <div className="mt-6">
        <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-op-muted mb-2">
          {t("rounds")}
        </div>
        <ul className="space-y-2">
          {order.rounds.map((r) => {
            const lines = order.items.filter((i) => i.roundId === r.id);
            const roundCancelled = r.status === "cancelled";
            return (
              <li
                key={r.id}
                className="bg-op-surface border border-op-border rounded-2xl p-4"
              >
                <div className="flex items-center justify-between">
                  <div className="font-mono text-xs tracking-wider uppercase text-op-muted">
                    {t("roundLabel", { seq: r.seq, time: fmtTime(r.placedAt) })}
                  </div>
                  <StatusPill status={r.status} />
                </div>
                <ul className="mt-2 divide-y divide-op-border">
                  {lines.map((li) => (
                    <li
                      key={li.id}
                      className="py-2 flex justify-between gap-3"
                    >
                      <div className="flex-1">
                        <div className={
                          "text-sm flex items-center gap-2 flex-wrap " +
                          (roundCancelled ? "line-through text-op-muted" : "")
                        }>
                          <span>
                            {li.qty}
                            {"× "}
                            {li.nameSnapshot}
                          </span>
                          {!roundCancelled && (
                            <ItemStatusBadge
                              kitchenStatus={li.kitchenStatus}
                              servedAt={li.servedAt}
                            />
                          )}
                        </div>
                        {li.guestName && (
                          <div className="text-[11px] text-terracotta mt-0.5">
                            {t("itemFrom", { name: li.guestName })}
                          </div>
                        )}
                        {(() => {
                          const sels = formatItemSelections(
                            li.modifierSelections,
                            li.menuItem?.modifiers,
                          );
                          if (sels.length === 0) return null;
                          return (
                            <div className="text-xs text-op-muted mt-0.5 space-y-0.5">
                              {sels.map((g, i) => (
                                <div key={i}>
                                  {"- "}
                                  {g}
                                </div>
                              ))}
                            </div>
                          );
                        })()}
                        {li.notes && (
                          <div className="text-xs text-op-muted mt-0.5 italic">
                            {li.notes}
                          </div>
                        )}
                      </div>
                      <div className="font-mono text-sm tabular">
                        {fmtCOP(li.priceCentsSnapshot * li.qty)}
                      </div>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
          {order.rounds.length === 0 && (
            <li className="text-sm text-op-muted py-4">{t("noRounds")}</li>
          )}
        </ul>
      </div>

      {multiGuest && (
        <div className="mt-6">
          <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-op-muted mb-2">
            {t("perGuest")}
          </div>
          <ul className="space-y-2">
            {Array.from(groups.values()).map((g) => (
              <li
                key={g.name}
                className="bg-op-surface border border-op-border rounded-2xl p-4"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-7 h-7 rounded-full bg-terracotta text-bone font-display text-sm inline-flex items-center justify-center">
                      {g.name.charAt(0).toUpperCase()}
                    </span>
                    <div className="font-display text-lg">{g.name}</div>
                  </div>
                  <div className="font-mono text-sm tabular">
                    {fmtCOP(g.subtotal)}
                  </div>
                </div>
                <ul className="mt-2 divide-y divide-op-border">
                  {g.items.map((li) => (
                    <li
                      key={li.id}
                      className="py-1.5 flex justify-between gap-3 text-sm"
                    >
                      <div>
                        {li.qty}
                        {"× "}
                        {li.nameSnapshot}
                      </div>
                      <div className="font-mono tabular text-op-muted">
                        {fmtCOP(li.priceCentsSnapshot * li.qty)}
                      </div>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6">
        <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-op-muted mb-2">
          {t("payments")}
        </div>
        <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
          {order.payments.length === 0 ? (
            <div className="p-4 text-sm text-op-muted">{t("noPayments")}</div>
          ) : (
            <ul className="divide-y divide-op-border">
              {order.payments.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between px-4 py-3"
                >
                  <div>
                    <div className="text-sm">
                      {methodLabel(p.method, t)}{" "}
                      {p.splitOfCount ? (
                        <span className="text-op-muted text-xs">
                          <span aria-hidden>{"· "}</span>
                          {t("splitOf", { count: p.splitOfCount })}
                        </span>
                      ) : null}
                    </div>
                    <div className="text-[11px] text-op-muted">
                      {fmtDateTime(p.createdAt)}
                      {p.providerRef ? ` · ${p.providerRef}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <PaymentPill status={p.status} />
                    <div className="font-mono tabular text-sm">
                      {fmtCOP(p.amountCents)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl p-3 border border-op-border bg-op-surface">
      <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">
        {label}
      </div>
      <div className="font-display text-xl mt-0.5 tracking-[-0.015em]">
        {value}
      </div>
    </div>
  );
}

async function StatusPill({ status }: { status: string }) {
  const t = await getTranslations("opOrders");
  const meta = statusMeta(status, t);
  return (
    <span
      className={
        "px-2 h-6 inline-flex items-center rounded-full text-[11px] font-medium " +
        meta.tint
      }
    >
      {meta.label}
    </span>
  );
}

async function PaymentPill({ status }: { status: string }) {
  const t = await getTranslations("opOrders");
  const tint =
    status === "approved"
      ? "bg-[#2E6B4C]/15 text-[#1E5339]"
      : status === "failed"
        ? "bg-danger/15 text-danger"
        : "bg-paper text-op-muted";
  const label =
    status === "approved"
      ? t("payApproved")
      : status === "failed"
        ? t("payFailed")
        : status === "refunded"
          ? t("payRefunded")
          : t("payPending");
  return (
    <span
      className={
        "px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium " +
        tint
      }
    >
      {label}
    </span>
  );
}

// Per-item status chip — same four stages as the diner-facing order
// view (Por preparar / Preparando / Listo para servir / Servido),
// rendered with the same colour palette so support can talk about
// what they see across both surfaces.
async function ItemStatusBadge({
  kitchenStatus,
  servedAt,
}: {
  kitchenStatus: "placed" | "in_kitchen" | "ready";
  servedAt: Date | null;
}) {
  const t = await getTranslations("opOrders");
  let label: string;
  let className: string;
  if (servedAt) {
    label = t("itemBadgeServed");
    className = "bg-[#2E6B4C]/15 text-[#1E5339]";
  } else if (kitchenStatus === "ready") {
    label = t("itemBadgeReady");
    className = "bg-[#2E6B4C]/10 text-[#1E5339]";
  } else if (kitchenStatus === "in_kitchen") {
    label = t("itemBadgePreparing");
    className = "bg-[#C98A2E]/20 text-[#8F6828]";
  } else {
    label = t("itemBadgeToPrepare");
    className = "bg-paper text-op-muted border border-op-border";
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

function statusMeta(s: string, t: (key: string) => string) {
  switch (s) {
    case "open":
      return { label: t("pillOpen"), tint: "bg-paper text-op-muted" };
    case "placed":
      return { label: t("pillPlaced"), tint: "bg-[#C98A2E]/20 text-[#8F6828]" };
    case "in_kitchen":
      return { label: t("pillInKitchen"), tint: "bg-[#C98A2E]/20 text-[#8F6828]" };
    case "ready":
      return { label: t("pillReady"), tint: "bg-[#2E6B4C]/15 text-[#1E5339]" };
    case "served":
      return { label: t("pillServed"), tint: "bg-[#2E6B4C]/15 text-[#1E5339]" };
    case "paying":
      return { label: t("pillPaying"), tint: "bg-ink/10 text-ink" };
    case "paid":
      return { label: t("pillPaid"), tint: "bg-[#2E6B4C]/15 text-[#1E5339]" };
    case "cancelled":
      return { label: t("pillCancelled"), tint: "bg-danger/15 text-danger" };
    default:
      return { label: s, tint: "bg-paper text-op-muted" };
  }
}

function methodLabel(m: string, t: (key: string) => string) {
  switch (m) {
    case "demo_card":
      return t("mDemoCard");
    case "demo_cash":
      return t("mDemoCash");
    case "wompi_card":
      return t("mWompiCard");
    case "wompi_pse":
      return t("mWompiPse");
    case "wompi_nequi":
      return t("mWompiNequi");
    case "kushki_apple_pay":
      return t("mApplePay");
    case "kushki_card":
      return t("mKushkiCard");
    case "kushki_card_terminal":
      return t("mKushkiTerminal");
    case "external_terminal":
      return t("mExternalTerminal");
    case "kushki_pse":
      return t("mKushkiPse");
    default:
      return m;
  }
}

function fmtDateTime(d: Date) {
  return new Date(d).toLocaleString("es-CO", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function fmtTime(d: Date) {
  return new Date(d).toLocaleTimeString("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
