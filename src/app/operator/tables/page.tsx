import { db } from "@/lib/db";
import { auth } from "@/auth";
import { fmtCOP } from "@/lib/format";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getMeseroScope } from "@/lib/meseroScope";
import { TableActions } from "./TableActions";
import { NewTableForm } from "./NewTableForm";
import { DeleteTableButton, EditLabelButton } from "./TableAdminActions";
import { LiveRefresh } from "../LiveRefresh";
import { syncOrderSubtotalFromLiveItems } from "@/lib/orderTotals";

export const dynamic = "force-dynamic";

export default async function TablesPage() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const tenant = await db.restaurant.findUnique({ where: { id: restaurantId } });

  // Heal any drifted subtotals before rendering the grid. Mesas with active
  // unpaid orders get a fresh recompute from live items so the displayed
  // amount matches what the diner sees and what payment routes will accept.
  const openOrderIds = await db.order.findMany({
    where: { restaurantId, status: { notIn: ["paid", "cancelled"] } },
    select: { id: true },
  });
  await Promise.all(
    openOrderIds.map((o) => syncOrderSubtotalFromLiveItems(o.id)),
  );

  // Esta página se reusa en /mesero/mesas vía re-export. El mesero
  // no debe ver acciones administrativas (crear mesa, imprimir QRs,
  // configurar pickup) — usa la grilla solo para cobrar / tomar
  // pedidos. El operador sí ve todo.
  const session = await auth();
  const isMeseroView = session?.user?.role === "mesero";

  // Mesero-scoped users only see their assigned table numbers (and
  // the pickup pseudo-table when their assignment includes -1, which
  // typically it won't — pickup is operator territory).
  const scope = await getMeseroScope();
  const tableNumberFilter =
    scope.scoped && scope.tableNumbers
      ? { number: { in: scope.tableNumbers } }
      : {};

  // 15 minutes is our "recién pagada" window. After a bill closes the
  // card stays green while the mesero is still around the table cleaning
  // up and showing the next guests in; once that window passes the
  // table reverts to neutral "free" so the floor view stops drawing the
  // eye to a table that's already turned over.
  const RECENTLY_PAID_MS = 15 * 60 * 1000;
  const recentlyPaidSince = new Date(Date.now() - RECENTLY_PAID_MS);

  const allTables = await db.table.findMany({
    where: { restaurantId, ...tableNumberFilter },
    orderBy: { number: "asc" },
    include: {
      orders: {
        where: { status: { notIn: ["paid", "cancelled"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        include: {
          // Only include items whose parent round is not cancelled. The
          // mesas grid shows the diner's live state, so a cancelled plate
          // should disappear from the count and the subtotal here.
          items: {
            where: {
              OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }],
            },
          },
          // Approved payments feed the "Cobrar la cuenta" CTA — when
          // the diner already settled the full bill we hide the button.
          payments: { where: { status: "approved" } },
        },
      },
      _count: { select: { orders: true } },
    },
  });

  // Most recent paid order per table within the "recién pagada" window.
  // Used for the green-card state below. Cheap because we only ask for
  // paidAt and we filter by both table + time.
  const tableIds = allTables.map((t) => t.id);
  const recentPaid = tableIds.length
    ? await db.order.findMany({
        where: {
          tableId: { in: tableIds },
          status: "paid",
          paidAt: { gte: recentlyPaidSince },
        },
        select: { tableId: true, paidAt: true },
        orderBy: { paidAt: "desc" },
      })
    : [];
  const recentPaidByTable = new Map<string, Date>();
  for (const o of recentPaid) {
    if (o.tableId && !recentPaidByTable.has(o.tableId) && o.paidAt) {
      recentPaidByTable.set(o.tableId, o.paidAt);
    }
  }
  const pickupTable = allTables.find((t) => t.number === -1) ?? null;
  const counterMode = tenant?.serviceMode === "counter";
  // Counter-mode restaurants are the mostrador — one QR is enough.
  // If stale data left multiple "Mostrador" rows behind, only surface
  // the first; the others are effectively duplicates.
  const tables = counterMode
    ? allTables.filter((t) => t.number !== -1).slice(0, 1)
    : allTables.filter((t) => t.number !== -1);

  const base = process.env.APP_PUBLIC_BASE_URL ?? "http://localhost:3300";
  const nextNumber = (tables.at(-1)?.number ?? 0) + 1;

  return (
    <div className="p-6 max-w-5xl mx-auto w-full">
      {tenant?.slug && <LiveRefresh tenantSlug={tenant.slug} />}
      <div className="flex items-center justify-between mb-4">
        <div className="font-display text-3xl">
          {counterMode ? "Mostrador" : "Mesas"}
        </div>
        {!isMeseroView && (
          <a
            href="/operator/tables/print"
            target="_blank"
            className="h-10 px-5 rounded-full border border-op-border inline-flex items-center text-sm font-medium"
          >
            {counterMode ? "Imprimir QR" : "Imprimir QRs"}
          </a>
        )}
      </div>
      {!isMeseroView && (
        <p className="text-sm text-op-muted mb-4">
          {counterMode
            ? "En modo mostrador hay un solo QR. El cliente lo escanea, ordena y paga."
            : "Cada mesa tiene un enlace QR único. Imprímelo y colócalo en la mesa."}
        </p>
      )}
      {!counterMode && !isMeseroView && (
        <div className="mb-5">
          <NewTableForm suggestedNumber={nextNumber} />
        </div>
      )}

      {!counterMode && !isMeseroView && tenant?.pickupEnabled && pickupTable && (
        <div className="mb-5 rounded-2xl border border-terracotta/40 bg-terracotta/5 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-mono text-[10px] tracking-wider uppercase text-terracotta">
                Pedido anticipado
              </div>
              <div className="font-display text-2xl mt-1">QR de recogida</div>
              <div className="text-xs text-op-muted mt-1">
                Cliente escanea, prepaga y recoge en mostrador.
              </div>
            </div>
            <a
              href={`/operator/tables/print?pickup=1`}
              target="_blank"
              className="h-10 px-4 rounded-full bg-ink text-bone text-sm font-medium inline-flex items-center"
            >
              Imprimir
            </a>
          </div>
          <details className="mt-3">
            <summary className="text-xs text-op-muted cursor-pointer">
              Enlace QR
            </summary>
            <a
              href={`${base}/p/${tenant.slug}?t=${pickupTable.qrToken}`}
              target="_blank"
              rel="noreferrer"
              className="mt-2 block text-xs text-terracotta font-mono break-all hover:underline"
            >
              {`${base}/p/${tenant.slug}?t=${pickupTable.qrToken}`}
            </a>
          </details>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {tables.map((t) => {
          const url = `${base}/t/${tenant!.slug}/menu?table=${t.qrToken}`;
          const order = t.orders[0];
          const active = !!order;
          const itemCount = order?.items.reduce((s, i) => s + i.qty, 0) ?? 0;
          const canDelete = !counterMode && t._count.orders === 0;
          // Card colour state (mesero-friendly visual triage):
          //   - needs_payment: active order pending payment → rojizo
          //   - recently_paid: bill cerró hace < 15 min → verde
          //   - free: nada activo y nada reciente → blanco neutro
          const recentlyPaidAt = recentPaidByTable.get(t.id);
          const isRecentlyPaid = !active && !!recentlyPaidAt;
          const cardTone = active
            ? "bg-[#C9302C]/8 border-[#C9302C]/35"
            : isRecentlyPaid
              ? "bg-ok/10 border-ok/35"
              : "bg-op-surface border-op-border";
          const dotTone = active
            ? "bg-[#C9302C]"
            : isRecentlyPaid
              ? "bg-ok"
              : "bg-op-border-2";
          const dotTitle = active
            ? "Cuenta pendiente"
            : isRecentlyPaid
              ? "Recién pagada"
              : "Libre";
          return (
            <div
              key={t.id}
              className={
                "border rounded-2xl p-4 transition-colors " + cardTone
              }
            >
              <div className="flex items-center justify-between">
                <div className="font-display text-2xl">
                  {counterMode ? "Mostrador" : `Mesa ${t.number}`}
                </div>
                <span
                  className={"w-2 h-2 rounded-full " + dotTone}
                  title={dotTitle}
                />
              </div>
              {!counterMode && (
                <div className="mt-1">
                  <EditLabelButton tableId={t.id} currentLabel={t.label} />
                </div>
              )}

              {isRecentlyPaid && recentlyPaidAt && (
                <div className="mt-3 text-[12px] text-[#1E5339] font-medium">
                  ✓ Pagada · {minutesAgo(recentlyPaidAt)}
                </div>
              )}

              {active && order && (
                <div className="mt-3 rounded-xl bg-op-bg border border-op-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-mono text-[11px] tracking-wider uppercase text-op-muted">
                      {order.shortCode}
                    </div>
                    <StatusPill
                      status={order.status}
                      items={order.items.map((i) => ({
                        kitchenStatus: i.kitchenStatus,
                        servedAt: i.servedAt,
                      }))}
                    />
                  </div>
                  <div className="mt-1 text-sm">
                    {itemCount} {itemCount === 1 ? "item" : "items"} ·{" "}
                    <span className="font-mono tabular">
                      {fmtCOP(order.subtotalCents)}
                    </span>
                  </div>
                  {/* Only show the per-table actions when there's actually
                      something to serve / cancel. When itemCount hits 0 the
                      round-cancellation flow has already closed the order
                      out (or is about to). Showing "Marcar servido" against
                      zero items is misleading. */}
                  {itemCount > 0 && (() => {
                    // foodPaidCents = approved (amount - tip). Outstanding
                    // is whatever the diner still owes against subtotal.
                    const foodPaid = order.payments.reduce(
                      (s, p) => s + p.amountCents - p.tipCents,
                      0,
                    );
                    const outstanding = Math.max(
                      0,
                      order.subtotalCents - foodPaid,
                    );
                    return (
                      <TableActions
                        orderId={order.id}
                        tenantSlug={tenant!.slug}
                        status={order.status}
                        outstandingCents={outstanding}
                      />
                    );
                  })()}
                </div>
              )}

              {/* Mesero toma pedido: si el cliente no tiene celular o
                  prefiere dictar, el operador abre el menú en modo
                  mesero y arma el pedido por la mesa. Va a la misma
                  URL pública del menú pero con un flag que oculta el
                  sheet de nombre y redirige a Salón al enviar.
                  Cuando ya hay una cuenta activa el botón es
                  secundario (outline) — "Cobrar la cuenta" es la
                  acción principal en ese estado. Para una mesa libre
                  "Tomar pedido" SÍ es la acción principal. */}
              <a
                href={`/t/${tenant!.slug}/menu?table=${t.qrToken}&op=1`}
                target="_blank"
                rel="noreferrer"
                className={
                  "mt-3 w-full h-10 inline-flex items-center justify-center gap-1.5 rounded-full text-sm font-medium transition-colors " +
                  (active
                    ? "border border-op-border bg-op-surface text-op-text hover:bg-op-bg"
                    : "bg-ink text-bone hover:bg-ink/90")
                }
              >
                {active ? (
                  <>
                    <span aria-hidden className="text-base leading-none">
                      +
                    </span>
                    <span>Agregar platos</span>
                  </>
                ) : (
                  "Tomar pedido"
                )}
              </a>

              <details className="mt-3">
                <summary className="text-xs text-op-muted cursor-pointer">
                  Enlace QR
                </summary>
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 block text-xs text-terracotta font-mono break-all hover:underline"
                >
                  {url}
                </a>
              </details>

              {canDelete && (
                <div className="mt-3 pt-3 border-t border-op-border flex justify-end">
                  <DeleteTableButton tableId={t.id} number={t.number} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

type PillItem = {
  kitchenStatus: "placed" | "in_kitchen" | "ready";
  servedAt: Date | null;
};

/**
 * Compute the most accurate visible status from the actual live items
 * rather than trusting Order.status — which can drift behind reality
 * (e.g. a partial delivery where the order is still flagged "served"
 * from a legacy code path, or an order that auto-advanced to ready
 * but has un-served plates remaining).
 *
 * Display priority, top to bottom:
 *   - Cancelado            → status === "cancelled"
 *   - Cobrando             → status === "paying"
 *   - Servido              → 100% of items have a servedAt
 *   - X de N en mesa       → some delivered, some still pending
 *   - Listo para servir    → all kitchen-ready, none delivered
 *   - X de N listos        → partial kitchen progress with anything ready
 *   - En cocina            → started cooking but nothing ready
 *   - Enviado              → just placed
 */
function StatusPill({
  status,
  items,
}: {
  status: string;
  items: PillItem[];
}) {
  const { label, tint } = computePill(status, items);
  return (
    <span
      className={
        "px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium whitespace-nowrap " +
        tint
      }
    >
      {label}
    </span>
  );
}

const TINT = {
  warm: "bg-[#C98A2E]/20 text-[#8F6828]",
  ok: "bg-[#2E6B4C]/15 text-[#1E5339]",
  ink: "bg-ink/10 text-ink",
  muted: "bg-paper text-op-muted",
};

function computePill(
  status: string,
  items: PillItem[],
): { label: string; tint: string } {
  if (status === "cancelled") return { label: "Cancelado", tint: TINT.muted };
  if (status === "paying") return { label: "Cobrando", tint: TINT.ink };
  if (items.length === 0) {
    // No items left after round cancellations — round-cancel handler
    // closes the order, but until that runs we show a placeholder.
    return { label: "Vacío", tint: TINT.muted };
  }

  const total = items.length;
  const served = items.filter((i) => i.servedAt != null).length;
  const ready = items.filter((i) => i.kitchenStatus === "ready").length;

  if (served === total) return { label: "Servido", tint: TINT.ok };
  if (served > 0) {
    return {
      label: `${served} de ${total} en mesa`,
      tint: TINT.warm,
    };
  }
  if (ready === total) {
    return { label: "Listo para servir", tint: TINT.ok };
  }
  if (ready > 0) {
    return { label: `${ready} de ${total} listos`, tint: TINT.warm };
  }
  if (status === "open") return { label: "Abierto", tint: TINT.muted };
  // Everything still in the kitchen — either just placed or being made.
  // We can't tell from the snapshot whether anyone started cooking yet
  // (kitchenStatus="placed" vs "in_kitchen"); the kitchen board owns
  // that nuance. For the mesas grid "En cocina" covers both states.
  return { label: "En cocina", tint: TINT.warm };
}

// Friendly "hace X min" for the recently-paid hint on the table card.
// Server-rendered so it's accurate to within a refresh cycle — the
// card overall fades to neutral after RECENTLY_PAID_MS so we won't
// ever show "hace 2 h".
function minutesAgo(date: Date): string {
  const mins = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000));
  if (mins < 1) return "hace un momento";
  if (mins === 1) return "hace 1 min";
  return `hace ${mins} min`;
}
