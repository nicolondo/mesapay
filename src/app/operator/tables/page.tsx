import { requestTime } from "@/lib/requestTime";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getMeseroScope, meseroTableWhere } from "@/lib/meseroScope";
import { NewTableForm } from "./NewTableForm";
import { LiveRefresh } from "../LiveRefresh";
import { syncOrderSubtotalFromLiveItems } from "@/lib/orderTotals";
import { computeWalkoutRisk, computeVisualState } from "@/lib/walkoutRisk";
import {
  MesasGrid,
  type ActiveOrder,
  type ManualTile,
  type TileData,
} from "./MesasGrid";
import { isChargeBlockedForRole } from "@/lib/chargeControl";

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
 *   - Facturas manuales abiertas (mesas `kind = manual` con cuenta
 *     viva) en su propia sección, fuera de los chips y del conteo de
 *     libres — sólo caja; el mesero no las ve (scope)
 *
 * `?open=<tableId>` abre la ficha de esa mesa al cargar: es cómo
 * "Nueva orden → Factura manual" del cockpit y el menú en modo
 * operador vuelven a la factura recién abierta.
 */
export default async function TablesPage({
  searchParams,
}: {
  searchParams?: Promise<{ open?: string }>;
}) {
  const tr = await getTranslations("opTables");
  const sp = (await searchParams) ?? {};
  const ux = await getTranslations("workspaceUi");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId)
    return <div className="p-6">{tr("noRestaurant")}</div>;

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
  // Control de caja: con "solo el administrador cobra" el mesero no ve el
  // botón de cobrar (que igual le rebotaría el servidor) sino "pedir la
  // cuenta", que avisa a caja. Ver src/lib/chargeControl.ts.
  const chargeLocked = isChargeBlockedForRole(
    session?.user?.role,
    tenant?.adminOnlyCharge ?? false,
  );

  // Mesero scoped: sólo ve sus mesas asignadas — y nunca las facturas
  // manuales, tenga o no sección.
  const scope = await getMeseroScope();
  const tableNumberFilter = meseroTableWhere(scope) ?? {};

  const RECENTLY_PAID_MS = 15 * 60 * 1000;
  const recentlyPaidSince = new Date((await requestTime()) - RECENTLY_PAID_MS);

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
          // Comensal identificado en la cuenta — para mostrar quién es y
          // su descuento en el detalle de la mesa.
          diner: {
            select: { id: true, name: true, email: true, cedula: true },
          },
        },
      },
      _count: { select: { orders: true } },
    },
  });

  const pickupTable = allTables.find((t) => t.kind === "pickup") ?? null;
  const counterMode = tenant?.serviceMode === "counter";
  const standardTables = allTables.filter((t) => t.kind === "standard");
  const tables = counterMode ? standardTables.slice(0, 1) : standardTables;
  // Facturas manuales ABIERTAS. Las que ya se cobraron o descartaron
  // dejan su mesa oculta libre para la próxima factura y no se dibujan.
  // Sólo caja: el scope del mesero ya las filtró, y por las dudas acá
  // tampoco se le pasan.
  const manualTables = isMeseroView
    ? []
    : allTables.filter((t) => t.kind === "manual" && t.orders.length > 0);

  // Mesas libres (sin orden abierta) — necesarias para "Mover a
  // otra mesa" del detail sheet (mueve el pedido ENTERO, solo a libres).
  // Sólo mesas físicas: una factura manual no es destino de nada ni
  // se muda a ningún lado (el servidor también lo rechaza).
  const freeTables = tables
    .filter((t) => t.orders.length === 0)
    .map((t) => ({ id: t.id, number: t.number, label: t.label }));

  // TODAS las mesas (libres y ocupadas) para "Mover un plato" — a
  // diferencia del move de pedido entero, un plato SÍ puede unirse a
  // una mesa con cuenta abierta. `occupied` = tiene orden abierta.
  const allTablesForMove = tables.map((t) => ({
    id: t.id,
    number: t.number,
    label: t.label,
    occupied: t.orders.length > 0,
  }));

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

  // Lo que el tile necesita de una cuenta viva, compartido entre las mesas
  // físicas y las facturas manuales: cobrable neto del descuento, lo que
  // falta por cobrar, y el resumen de rondas/cliente para la ficha.
  const summarizeOrder = (order: (typeof allTables)[number]["orders"][number]) => {
    const approved = order.payments.filter((p) => p.status === "approved");
    const foodPaid = approved.reduce(
      (s, p) => s + p.amountCents - p.tipCents,
      0,
    );
    // El descuento del comensal identificado baja lo que falta por
    // cobrar. Sin restarlo acá, el mesero vería un pendiente mayor al
    // real y el cobro se rechazaría por "excede lo pendiente".
    const chargeableCents = Math.max(
      0,
      order.subtotalCents - order.discountCents,
    );
    const outstandingCents = Math.max(0, chargeableCents - foodPaid);
    const itemCount = order.items.reduce((s, i) => s + i.qty, 0);
    const activeOrder: ActiveOrder = {
      id: order.id,
      shortCode: order.shortCode,
      status: order.status,
      itemCount,
      subtotalCents: chargeableCents,
      grossSubtotalCents: order.subtotalCents,
      discountCents: order.discountCents,
      discountPct: order.discountPct,
      customer: order.diner
        ? {
            id: order.diner.id,
            name: order.diner.name,
            email: order.diner.email,
            cedula: order.diner.cedula,
          }
        : null,
      outstandingCents,
      needsWaiter: order.needsWaiter,
      rounds: order.rounds.map((r) => ({
        id: r.id,
        seq: r.seq,
        status: r.status,
        placedAt: r.placedAt.toISOString(),
        placedByName: r.placedByName,
        placedByRole: r.placedByRole,
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
    };
    return { activeOrder, approved, outstandingCents };
  };

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
    const { activeOrder, approved, outstandingCents } = summarizeOrder(order);

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
      order: activeOrder,
    };
  });

  // Facturas manuales: sin walkout-risk ni estado de cocina (nada se
  // prepara ni se entrega) — sólo la cuenta.
  const manualTiles: ManualTile[] = manualTables.map((t) => ({
    id: t.id,
    number: t.number,
    qrToken: t.qrToken,
    order: summarizeOrder(t.orders[0]).activeOrder,
  }));

  const base = process.env.APP_PUBLIC_BASE_URL ?? "http://localhost:3300";
  const nextNumber = (tables.at(-1)?.number ?? 0) + 1;

  return (
    <div className="mp-page">
      {tenant?.slug && <LiveRefresh tenantSlug={tenant.slug} />}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div><p className="mp-eyebrow">{tenant?.name}</p><h1 className="mp-page-title">{counterMode ? tr("headerCounter") : tr("headerTables")}</h1><p className="mp-page-description">{ux("tablesDescription")}</p></div>
        {!isMeseroView && (
          <a
            href="/operator/tables/print"
            target="_blank"
            className="h-9 px-4 rounded-full border border-op-border inline-flex items-center text-sm font-medium"
          >
            {counterMode ? tr("printQr") : tr("printQrs")}
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
                {tr("pickupKicker")}
              </div>
              <div className="text-sm font-medium">{tr("pickupTitle")}</div>
            </div>
            <a
              href={`/operator/tables/print?pickup=1`}
              target="_blank"
              className="h-9 px-4 rounded-full bg-ink text-bone text-sm font-medium inline-flex items-center shrink-0"
            >
              {tr("pickupPrint")}
            </a>
          </div>
          <details className="mt-2">
            <summary className="text-[11px] text-op-muted cursor-pointer">
              {tr("pickupQrLink")}
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
        initialTime={await requestTime()}
        tiles={tiles}
        manualTiles={manualTiles}
        canOpenManual={!isMeseroView}
        initialOpenTileId={sp.open ?? null}
        tenantSlug={tenant!.slug}
        counterMode={counterMode}
        isMeseroView={isMeseroView}
        chargeLocked={chargeLocked}
        freeTables={freeTables}
        allTables={allTablesForMove}
        country={tenant!.country}
      />
    </div>
  );
}
