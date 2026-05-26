import { db } from "@/lib/db";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getMeseroScope } from "@/lib/meseroScope";
import { NewTableForm } from "./NewTableForm";
import { LiveRefresh } from "../LiveRefresh";
import { syncOrderSubtotalFromLiveItems } from "@/lib/orderTotals";
import { computeWalkoutRisk, computeVisualState } from "@/lib/walkoutRisk";
import { MesasGrid, type TileData } from "./MesasGrid";

export const dynamic = "force-dynamic";

/**
 * /operator/tables (y /mesero/mesas vía re-export) — grilla de mesas
 * del restaurante. Diseño compacto con tiles + walkout-risk + tap →
 * detail sheet. Ver MesasGrid.tsx para la UI de cada tile.
 *
 * Esta página se encarga de:
 *   - Fetch + heal subtotal de órdenes vivas
 *   - Cálculo de walkout-risk por mesa activa (server-side, con
 *     acceso a payments pending y waiterCalledAt; pasarlo al cliente
 *     ya pre-computado evita exponer todos los payments al bundle)
 *   - Marcar "recién pagadas" (últimos 15min)
 *   - Render del header (Mesas/Mostrador, Imprimir QRs, alta de
 *     mesas nuevas, pickup card) — sólo en operator/admin
 */
export default async function TablesPage() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const tenant = await db.restaurant.findUnique({ where: { id: restaurantId } });

  // Heal subtotals drifteados antes de renderizar la grilla. Las
  // mesas activas con orden abierta recomputan desde live items
  // para que el monto coincida con lo que el cliente ve y con lo
  // que aceptarán los endpoints de pago.
  const openOrderIds = await db.order.findMany({
    where: { restaurantId, status: { notIn: ["paid", "cancelled"] } },
    select: { id: true },
  });
  await Promise.all(
    openOrderIds.map((o) => syncOrderSubtotalFromLiveItems(o.id)),
  );

  const session = await auth();
  const isMeseroView = session?.user?.role === "mesero";

  // Mesero scoped: sólo ve sus mesas asignadas.
  const scope = await getMeseroScope();
  const tableNumberFilter =
    scope.scoped && scope.tableNumbers
      ? { number: { in: scope.tableNumbers } }
      : {};

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
          items: {
            where: {
              cancelledAt: null,
              OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }],
            },
          },
          rounds: {
            where: { status: { not: "cancelled" } },
            orderBy: { seq: "asc" },
            include: {
              items: {
                where: { cancelledAt: null },
                orderBy: { id: "asc" },
              },
            },
          },
          // Necesitamos TODOS los payments (no sólo approved) para
          // calcular walkout-risk: los pending entran en Señal 1, los
          // approved alimentan el lastApprovedPaymentAt que resetea
          // el reloj de Señal 2.
          payments: {
            orderBy: { createdAt: "asc" },
          },
        },
      },
      _count: { select: { orders: true } },
    },
  });

  const pickupTable = allTables.find((t) => t.number === -1) ?? null;
  const counterMode = tenant?.serviceMode === "counter";
  const tables = counterMode
    ? allTables.filter((t) => t.number !== -1).slice(0, 1)
    : allTables.filter((t) => t.number !== -1);

  // Mesas libres (sin orden abierta) — necesarias para "Mover a
  // otra mesa" del detail sheet.
  const freeTables = tables
    .filter((t) => t.orders.length === 0)
    .map((t) => ({ id: t.id, number: t.number, label: t.label }));

  // Recently-paid lookup.
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

  const dangerMinutes = tenant?.walkoutDangerMinutes ?? 20;
  const now = new Date();

  // Pre-compute TileData server-side. El cliente recibe el shape
  // chico (sin payments crudos) y sólo decide filtros + qué sheet
  // está abierto.
  const tiles: TileData[] = tables.map((t) => {
    const order = t.orders[0];
    if (!order) {
      const recentlyPaidAt = recentPaidByTable.get(t.id);
      if (recentlyPaidAt) {
        return {
          id: t.id,
          number: t.number,
          label: t.label,
          qrToken: t.qrToken,
          state: "recently_paid",
          paidAt: recentlyPaidAt.toISOString(),
        };
      }
      return {
        id: t.id,
        number: t.number,
        label: t.label,
        qrToken: t.qrToken,
        state: "free",
      };
    }

    // Active table — calcula outstanding + walkout risk.
    const approved = order.payments.filter((p) => p.status === "approved");
    const foodPaid = approved.reduce(
      (s, p) => s + p.amountCents - p.tipCents,
      0,
    );
    const outstandingCents = Math.max(0, order.subtotalCents - foodPaid);

    // Pending payments para Señal 1 del walkout. Excluimos los que
    // ya están pinneados a un datafono esperando aprobación (tienen
    // providerRef) — flujo normal de cobro, no walkout.
    const pendingForRisk = order.payments.filter(
      (p) => p.status === "pending" && !p.providerRef,
    );
    const lastApproved =
      approved.length > 0
        ? new Date(
            Math.max(
              ...approved
                .map((p) => p.settledAt?.getTime() ?? 0)
                .filter((t) => t > 0),
            ) || 0,
          )
        : null;

    const risk = computeWalkoutRisk(
      {
        outstandingCents,
        items: order.items.map((i) => ({
          servedAt: i.servedAt,
          cancelledAt: i.cancelledAt,
        })),
        pendingPaymentCreatedAts: pendingForRisk.map((p) => p.createdAt),
        waiterCalledAt: order.waiterCalledAt,
        needsWaiter: order.needsWaiter,
        lastApprovedPaymentAt:
          lastApproved && lastApproved.getTime() > 0 ? lastApproved : null,
        dangerMinutes,
      },
      now,
    );

    // Estado discreto de la mesa para coloring. Computa AHORA, con
    // todas las señales en mano (orden + cocina + payments + risk).
    const liveItems = order.items.filter((i) => i.cancelledAt == null);
    const hasReadyItems = liveItems.some(
      (i) => i.kitchenStatus === "ready" && i.servedAt == null,
    );
    const hasCookingItems = liveItems.some(
      (i) =>
        (i.kitchenStatus === "placed" || i.kitchenStatus === "in_kitchen") &&
        i.servedAt == null,
    );
    const hasPendingRequest =
      pendingForRisk.length > 0 || (order.needsWaiter === true);
    const visualState = computeVisualState({
      hasActiveOrder: true,
      recentlyPaid: false,
      hasPendingRequest,
      hasReadyItems,
      hasCookingItems,
      riskLevel: risk.level,
    });

    const itemCount = order.items.reduce((s, i) => s + i.qty, 0);

    return {
      id: t.id,
      number: t.number,
      label: t.label,
      qrToken: t.qrToken,
      state: "active",
      visualState,
      risk: {
        level: risk.level,
        agingMinutes: risk.agingMinutes,
        reason: risk.reason,
      },
      order: {
        id: order.id,
        shortCode: order.shortCode,
        status: order.status,
        itemCount,
        subtotalCents: order.subtotalCents,
        outstandingCents,
        needsWaiter: order.needsWaiter,
        rounds: order.rounds.map((r) => ({
          id: r.id,
          seq: r.seq,
          status: r.status,
          placedAt: r.placedAt.toISOString(),
          items: r.items.map((i) => ({
            id: i.id,
            name: i.nameSnapshot,
            qty: i.qty,
            priceCents: i.priceCentsSnapshot,
            kitchenStatus: i.kitchenStatus,
            preparationStartedAt: i.preparationStartedAt
              ? i.preparationStartedAt.toISOString()
              : null,
            servedAt: i.servedAt ? i.servedAt.toISOString() : null,
            expediteRequestedAt: i.expediteRequestedAt
              ? i.expediteRequestedAt.toISOString()
              : null,
            guestName: i.guestName ?? null,
            notes: i.notes ?? null,
          })),
        })),
      },
    };
  });

  const base = process.env.APP_PUBLIC_BASE_URL ?? "http://localhost:3300";
  const nextNumber = (tables.at(-1)?.number ?? 0) + 1;

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto w-full">
      {tenant?.slug && <LiveRefresh tenantSlug={tenant.slug} />}
      <div className="flex items-center justify-between mb-3">
        <div className="font-display text-3xl">
          {counterMode ? "Mostrador" : "Mesas"}
        </div>
        {!isMeseroView && (
          <a
            href="/operator/tables/print"
            target="_blank"
            className="h-9 px-4 rounded-full border border-op-border inline-flex items-center text-sm font-medium"
          >
            {counterMode ? "Imprimir QR" : "Imprimir QRs"}
          </a>
        )}
      </div>
      {!counterMode && !isMeseroView && (
        <div className="mb-4">
          <NewTableForm suggestedNumber={nextNumber} />
        </div>
      )}

      {!counterMode && !isMeseroView && tenant?.pickupEnabled && pickupTable && (
        <div className="mb-4 rounded-2xl border border-terracotta/40 bg-terracotta/5 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-mono text-[10px] tracking-wider uppercase text-terracotta">
                Pedido anticipado
              </div>
              <div className="text-sm font-medium">QR de recogida</div>
            </div>
            <a
              href={`/operator/tables/print?pickup=1`}
              target="_blank"
              className="h-9 px-4 rounded-full bg-ink text-bone text-sm font-medium inline-flex items-center shrink-0"
            >
              Imprimir
            </a>
          </div>
          <details className="mt-2">
            <summary className="text-[11px] text-op-muted cursor-pointer">
              Enlace QR
            </summary>
            <a
              href={`${base}/p/${tenant.slug}?t=${pickupTable.qrToken}`}
              target="_blank"
              rel="noreferrer"
              className="mt-1.5 block text-[11px] text-terracotta font-mono break-all hover:underline"
            >
              {`${base}/p/${tenant.slug}?t=${pickupTable.qrToken}`}
            </a>
          </details>
        </div>
      )}

      <MesasGrid
        tiles={tiles}
        tenantSlug={tenant!.slug}
        counterMode={counterMode}
        isMeseroView={isMeseroView}
        freeTables={freeTables}
      />
    </div>
  );
}
