import { auth } from "@/auth";
import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import { TableActions } from "./TableActions";
import { NewTableForm } from "./NewTableForm";
import { DeleteTableButton, EditLabelButton } from "./TableAdminActions";

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
        where: { status: { notIn: ["paid", "cancelled"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { items: true },
      },
      _count: { select: { orders: true } },
    },
  });

  const base = process.env.APP_PUBLIC_BASE_URL ?? "http://localhost:3300";
  const nextNumber = (tables.at(-1)?.number ?? 0) + 1;

  return (
    <div className="p-6 max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-between mb-4">
        <div className="font-display text-3xl">Mesas</div>
        <a
          href="/operator/tables/print"
          target="_blank"
          className="h-10 px-5 rounded-full border border-op-border inline-flex items-center text-sm font-medium"
        >
          Imprimir QRs
        </a>
      </div>
      <p className="text-sm text-op-muted mb-4">
        Cada mesa tiene un enlace QR único. Imprímelo y colócalo en la mesa.
      </p>
      <div className="mb-5">
        <NewTableForm suggestedNumber={nextNumber} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {tables.map((t) => {
          const url = `${base}/t/${tenant!.slug}/menu?table=${t.qrToken}`;
          const order = t.orders[0];
          const active = !!order;
          const itemCount = order?.items.reduce((s, i) => s + i.qty, 0) ?? 0;
          const canDelete = t._count.orders === 0;
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
              <div className="mt-1">
                <EditLabelButton tableId={t.id} currentLabel={t.label} />
              </div>

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
