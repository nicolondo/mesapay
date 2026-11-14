import { requestTime } from "@/lib/requestTime";
import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import { appOrigin } from "@/lib/http/publicOrigin";
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
import { isReplaceablePending } from "@/lib/payments/methods";
import { terminalAmountViews, terminalClaims } from "@/lib/payments/pendingRequests";
import { breBPendingViews } from "@/lib/payments/breB/service";
import { toTerminalAttemptView } from "@/lib/payments/terminalAttempt";
import { canMoveBetweenTables } from "@/lib/tableMoveControl";
import {
  RECENTLY_PAID_MINUTES,
  isRecentlyPaidVisible,
  resolvePhonePaidHighlightMinutes,
  wasPaidFromPhone,
} from "@/lib/tables/phonePaid";
import { asSalesTaxKind } from "@/lib/checkoutTax";
import {
  canCompOrders,
  resolveCompAllowedRoles,
  type CompPolicyView,
} from "@/lib/staffPolicies";
import {
  ORDER_INVOICE_VIEW_SELECT,
  orderInvoiceViewOf,
  type OrderInvoiceView,
} from "@/lib/orders/invoicedOrder";
import type { InvoiceIntent } from "@/components/invoice/types";
import {
  isSimpleInvoiceRequested,
  simpleInvoiceEmailFrom,
} from "@/lib/simpleInvoiceRequest";

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
  const moveLocked = !tenant || !canMoveBetweenTables(
    session?.user?.role,
    tenant.adminOnlyTableMove,
  );
  // Quién puede "No cobrar" un plato: si el rol de quien mira no está en la
  // lista del comercio, el sheet deshabilita el botón y dice quién sí puede.
  // El servidor bloquea igual (src/lib/compGuard.ts).
  const compPolicy: CompPolicyView = {
    locked: !canCompOrders(session?.user?.role, tenant?.compAllowedRoles),
    allowedRoles: resolveCompAllowedRoles(tenant?.compAllowedRoles),
  };

  // Mesero scoped: sólo ve sus mesas asignadas — y nunca las facturas
  // manuales, tenga o no sección.
  const scope = await getMeseroScope();
  const tableNumberFilter = meseroTableWhere(scope) ?? {};

  // Mesa que acaba de pagar desde el celular: minutos de resalte del
  // comercio (default 3, 0 = apagado). La ventana de consulta de "recién
  // pagadas" es la mayor entre los 15 min clásicos y ese resalte, para que
  // un resalte largo no se quede sin datos.
  const phonePaidHighlightMinutes = resolvePhonePaidHighlightMinutes(
    tenant?.phonePaidHighlightMinutes,
  );
  const nowMs = await requestTime();
  const recentWindowMs =
    Math.max(RECENTLY_PAID_MINUTES, phonePaidHighlightMinutes) * 60_000;
  const recentlyPaidSince = new Date(nowMs - recentWindowMs);

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
          // Cliente de la factura (solicitud pendiente): en una factura
          // manual es lo que el operador identifica desde la ficha.
          invoiceRequests: {
            where: { status: "pending" },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              status: true,
              customerName: true,
              docType: true,
              docNumber: true,
              email: true,
            },
          },
          // Factura emitida ANTES de cobrar: la ficha muestra "Facturada ·
          // pendiente de pago" y deja la cuenta cerrada a cambios.
          simpleInvoice: { select: ORDER_INVOICE_VIEW_SELECT },
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

  // Recently-paid lookup. Trae los pagos aprobados de cada cuenta para saber
  // si la cerró el comensal desde su celular (wasPaidFromPhone): esa mesa
  // sale de primera y en verde fuerte durante `phonePaidHighlightMinutes`.
  const tableIds = allTables.map((t) => t.id);
  const recentPaid = tableIds.length
    ? await db.order.findMany({
        where: {
          tableId: { in: tableIds },
          status: "paid",
          paidAt: { gte: recentlyPaidSince },
        },
        select: {
          tableId: true,
          paidAt: true,
          payments: {
            where: { status: "approved" },
            select: {
              method: true,
              status: true,
              collectedByUserId: true,
              settledAt: true,
              createdAt: true,
            },
          },
        },
        orderBy: { paidAt: "desc" },
      })
    : [];
  const recentPaidByTable = new Map<
    string,
    { paidAt: Date; paidFromPhone: boolean }
  >();
  for (const o of recentPaid) {
    if (o.tableId && !recentPaidByTable.has(o.tableId) && o.paidAt) {
      recentPaidByTable.set(o.tableId, {
        paidAt: o.paidAt,
        paidFromPhone: wasPaidFromPhone(o.payments),
      });
    }
  }

  const dangerMinutes = tenant?.walkoutDangerMinutes ?? 20;
  const now = new Date();

  // Datáfonos Kushki pendientes que YA se enviaron al equipo (reclamo
  // `terminal:<id>`): la ficha los muestra como cobro en curso; los que no,
  // como solicitud que se puede cancelar. Una sola consulta para todas.
  const terminalClaimed = await terminalClaims(
    db,
    allTables.flatMap((t) => t.orders.flatMap((o) => o.payments.filter((p) => p.status === "pending"))),
  );

  // Datáfono Kushki aprobado por OTRO monto (propina del datáfono o parcial):
  // la ficha lo avisa. Una sola consulta para todas.
  const approvedTerminalAmounts = await terminalAmountViews(
    db,
    allTables.flatMap((t) => t.orders.flatMap((o) => o.payments.filter((p) => p.status === "approved"))),
  );

  // Bre-B en curso: en qué va su QR (vigente / sin confirmar), para que la
  // ficha ofrezca «Ver código», «Consultar estado» y «Cancelar cobro».
  const breBPending = await breBPendingViews(
    db,
    allTables.flatMap((t) => t.orders.flatMap((o) => o.payments.filter((p) => p.status === "pending"))),
  );

  // Facturas emitidas antes de cobrar (raras: se cargan aparte, con su
  // estado DIAN y si una nota crédito ya las anuló).
  const invoiceViews = new Map<string, OrderInvoiceView>();
  await Promise.all(
    allTables
      .flatMap((t) => t.orders)
      .filter((o) => o.simpleInvoice)
      .map(async (o) => {
        const view = await orderInvoiceViewOf(db, o.simpleInvoice);
        if (view) invoiceViews.set(o.id, view);
      }),
  );

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
      invoiceRequest: order.invoiceRequests[0] ?? null,
      // Lo que ya se pidió de factura en la cuenta (la hoja de "Imprimir
      // factura" lo muestra y deja cambiarlo) y la factura, si ya existe.
      invoiceIntent: (order.invoiceRequests[0]
        ? { kind: "formal", summary: order.invoiceRequests[0] }
        : isSimpleInvoiceRequested(order.simpleInvoiceEmail)
          ? { kind: "simple", email: simpleInvoiceEmailFrom(order.simpleInvoiceEmail) }
          : null) satisfies InvoiceIntent | null,
      invoice: invoiceViews.get(order.id) ?? null,
      outstandingCents,
      needsWaiter: order.needsWaiter,
      // Lo que el comensal pidió para pagar (efectivo, datáfono del
      // comercio) o un pago en línea en curso: la ficha lo muestra arriba.
      pendingPayments: order.payments
        .filter((p) => p.status === "pending")
        .map((p) => ({
          id: p.id,
          method: p.method,
          amountCents: p.amountCents,
          tipCents: p.tipCents,
          cashTenderCents: p.cashTenderCents,
          createdAt: p.createdAt.toISOString(),
          replaceable: isReplaceablePending(p, terminalClaimed.has(p.id)),
          reconciliationRequired: p.reconciliationRequired,
          pushedAt: terminalClaimed.get(p.id)?.createdAt.toISOString() ?? null,
          terminalAttempt: toTerminalAttemptView(terminalClaimed.get(p.id), p.reconciliationRequired),
          breB: breBPending.get(p.id) ?? null,
        })),
      // Cobros del datáfono aprobados por otro monto: «se registró como
      // propina» / «quedan $X por cobrar».
      terminalAmounts: order.payments
        .filter((p) => p.status === "approved")
        .map((p) => approvedTerminalAmounts.get(p.id))
        .filter((a): a is NonNullable<typeof a> => !!a && (a.check === "tip" || a.check === "partial")),
      rounds: order.rounds.map((r) => ({
        id: r.id,
        seq: r.seq,
        status: r.status,
        placedAt: r.placedAt.toISOString(),
        placedByName: r.placedByName,
        placedByRole: r.placedByRole,
        items: r.items.map((i) => ({
          id: i.id,
          menuItemId: i.menuItemId,
          name: i.nameSnapshot,
          qty: i.qty,
          priceCents: i.priceCentsSnapshot,
          kitchenStatus: i.kitchenStatus,
          preparationStartedAt: i.preparationStartedAt
            ? i.preparationStartedAt.toISOString()
            : null,
          preparationFirstStartedAt: i.preparationFirstStartedAt?.toISOString() ?? null,
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
      const recent = recentPaidByTable.get(t.id);
      // La ventana de consulta es la mayor de las dos; acá se decide si ESTA
      // mesa todavía se dibuja como recién pagada (15 min para todas, o el
      // resalte del comercio si la pagó el comensal desde su celular).
      if (
        recent &&
        isRecentlyPaidVisible(recent.paidAt, nowMs, {
          paidFromPhone: recent.paidFromPhone,
          phonePaidHighlightMinutes,
        })
      ) {
        return {
          id: t.id,
          number: t.number,
          label: t.label,
          qrToken: t.qrToken,
          state: "recently_paid",
          paidAt: recent.paidAt.toISOString(),
          paidFromPhone: recent.paidFromPhone,
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

  // APP_PUBLIC_BASE_URL manda; si falta, el origen público del request
  // (headers del proxy). Antes caía a http://localhost:3300 y el QR/link
  // impreso quedaba apuntando a localhost.
  const base = appOrigin(await headers());
  const nextNumber = (tables.at(-1)?.number ?? 0) + 1;

  // Mismo sistema de botón que "+ Añadir mesa" (mp-btn--sm) para que los
  // dos queden a la misma altura cuando van lado a lado en la cabecera.
  const printLink = (
    <a
      href="/operator/tables/print"
      target="_blank"
      className="mp-btn mp-btn--secondary mp-btn--sm"
    >
      {counterMode ? tr("printQr") : tr("printQrs")}
    </a>
  );

  return (
    <div className="mp-page">
      {tenant?.slug && <LiveRefresh tenantSlug={tenant.slug} />}
      {/* Cabecera. En móvil: título a todo el ancho y debajo UNA fila con
          las acciones ("Imprimir QRs" + "+ Añadir mesa"). En md+: título a
          la izquierda, acciones a la derecha. `flex-wrap` en md+ es para
          que el formulario de alta (hijo `w-full` que devuelve
          NewTableForm cuando está abierto) caiga a su propia línea bajo
          la cabecera en vez de empujar las acciones. */}
      <div className="mb-5 flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center md:justify-between">
        <div className="min-w-0">
          <p className="mp-eyebrow">{tenant?.name}</p>
          <h1 className="mp-page-title">
            {counterMode ? tr("headerCounter") : tr("headerTables")}
          </h1>
          <p className="mp-page-description">{ux("tablesDescription")}</p>
        </div>
        {/* Mostrador: no hay alta de mesas, sólo el enlace de impresión. */}
        {!isMeseroView &&
          (counterMode ? (
            printLink
          ) : (
            <NewTableForm suggestedNumber={nextNumber} actions={printLink} />
          ))}
      </div>

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
        initialTime={nowMs}
        phonePaidHighlightMinutes={phonePaidHighlightMinutes}
        tiles={tiles}
        manualTiles={manualTiles}
        canOpenManual={!isMeseroView}
        initialOpenTileId={sp.open ?? null}
        tenantSlug={tenant!.slug}
        counterMode={counterMode}
        isMeseroView={isMeseroView}
        chargeLocked={chargeLocked}
        moveLocked={moveLocked}
        compPolicy={compPolicy}
        viewerRole={session?.user?.role ?? null}
        freeTables={freeTables}
        allTables={allTablesForMove}
        country={tenant!.country}
        salesTax={{
          kind: asSalesTaxKind(tenant!.salesTaxKind),
          pct: tenant!.salesTaxPct,
        }}
      />
    </div>
  );
}
