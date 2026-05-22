import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { TableActions } from "./TableActions";
import { NewTableForm } from "./NewTableForm";
import { DeleteTableButton, EditLabelButton } from "./TableAdminActions";
import { LiveRefresh } from "../LiveRefresh";

export const dynamic = "force-dynamic";

export default async function TablesPage() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const tenant = await db.restaurant.findUnique({ where: { id: restaurantId } });
  const allTables = await db.table.findMany({
    where: { restaurantId },
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
        },
      },
      _count: { select: { orders: true } },
    },
  });
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
        <a
          href="/operator/tables/print"
          target="_blank"
          className="h-10 px-5 rounded-full border border-op-border inline-flex items-center text-sm font-medium"
        >
          {counterMode ? "Imprimir QR" : "Imprimir QRs"}
        </a>
      </div>
      <p className="text-sm text-op-muted mb-4">
        {counterMode
          ? "En modo mostrador hay un solo QR. El cliente lo escanea, ordena y paga."
          : "Cada mesa tiene un enlace QR único. Imprímelo y colócalo en la mesa."}
      </p>
      {!counterMode && (
        <div className="mb-5">
          <NewTableForm suggestedNumber={nextNumber} />
        </div>
      )}

      {!counterMode && tenant?.pickupEnabled && pickupTable && (
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
          return (
            <div
              key={t.id}
              className="bg-op-surface border border-op-border rounded-2xl p-4"
            >
              <div className="flex items-center justify-between">
                <div className="font-display text-2xl">
                  {counterMode ? "Mostrador" : `Mesa ${t.number}`}
                </div>
                <span
                  className={
                    "w-2 h-2 rounded-full " +
                    (active ? "bg-terracotta" : "bg-op-border-2")
                  }
                  title={active ? "Orden abierta" : "Libre"}
                />
              </div>
              {!counterMode && (
                <div className="mt-1">
                  <EditLabelButton tableId={t.id} currentLabel={t.label} />
                </div>
              )}

              {active && order && (
                <div className="mt-3 rounded-xl bg-op-bg border border-op-border p-3">
                  <div className="flex items-center justify-between">
                    <div className="font-mono text-[11px] tracking-wider uppercase text-op-muted">
                      {order.shortCode}
                    </div>
                    <StatusPill status={order.status} />
                  </div>
                  <div className="mt-1 text-sm">
                    {itemCount} {itemCount === 1 ? "item" : "items"} ·{" "}
                    <span className="font-mono tabular">
                      {fmtCOP(order.subtotalCents)}
                    </span>
                  </div>
                  <TableActions orderId={order.id} status={order.status} />
                </div>
              )}

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

function StatusPill({ status }: { status: string }) {
  const { label, tint } = statusMeta(status);
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

function statusMeta(s: string) {
  switch (s) {
    case "open":
      return { label: "Abierto", tint: "bg-paper text-op-muted" };
    case "placed":
      return { label: "Enviado", tint: "bg-[#C98A2E]/20 text-[#8F6828]" };
    case "in_kitchen":
      return { label: "En cocina", tint: "bg-[#C98A2E]/20 text-[#8F6828]" };
    case "ready":
      return { label: "Listo", tint: "bg-[#2E6B4C]/15 text-[#1E5339]" };
    case "served":
      return { label: "Servido", tint: "bg-[#2E6B4C]/15 text-[#1E5339]" };
    case "paying":
      return { label: "Cobrando", tint: "bg-ink/10 text-ink" };
    default:
      return { label: s, tint: "bg-paper text-op-muted" };
  }
}
