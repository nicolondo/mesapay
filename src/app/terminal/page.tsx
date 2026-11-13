import { getTranslations } from "next-intl/server";
import { requestTime } from "@/lib/requestTime";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { terminalTablesWhere } from "@/lib/tables/salonTables";
import { getActiveContext } from "@/lib/activeRestaurant";
import { computeOrderTotals } from "@/lib/orderTotals";
import { isCashMethod } from "@/lib/payments/methods";
import { TerminalGrid } from "./TerminalGrid";
import { usableTerminalDevices } from "@/lib/payments/terminalAvailability";
import {
  resolvePhonePaidHighlightMinutes,
  wasPaidFromPhone,
} from "@/lib/tables/phonePaid";
import { salonVisualStateOf } from "@/lib/tables/salonVisualState";
import { withReplaceable } from "@/lib/payments/pendingRequests";
import { terminalChargeState } from "@/lib/tables/terminalCharge";

export const dynamic = "force-dynamic";

export default async function TerminalPage() {
  const tr = await getTranslations("opTerminal");
  const session = await auth();
  const ctx = await getActiveContext();
  const restaurantId = ctx?.restaurantId ?? session?.user?.restaurantId ?? null;
  if (!restaurantId) return <div className="p-6">{tr("noRestaurant")}</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      id: true,
      slug: true,
      name: true,
      serviceMode: true,
      // Para ordenar las mesas con la regla del salón (ver más abajo).
      walkoutDangerMinutes: true,
      phonePaidHighlightMinutes: true,
    },
  });
  if (!tenant) return <div className="p-6">{tr("restaurantNotFound")}</div>;

  // All tables of the tenant (excluding the pickup virtual table number -1
  // since the terminal can't charge a pickup customer at the table).
  const tables = await db.table.findMany({
    // Sin la de recogida ni las facturas manuales (src/lib/tables/salonTables.ts).
    where: terminalTablesWhere(tenant.id),
    orderBy: { number: "asc" },
    include: {
      orders: {
        where: { status: { notIn: ["cancelled"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        include: {
          // La factura (o comprobante) ya emitida: "Imprimir factura".
          simpleInvoice: { select: { id: true } },
          payments: {
            where: { status: { in: ["approved", "pending"] } },
            orderBy: { createdAt: "asc" },
          },
          // Items, filtered to skip cancelled-round items. The terminal
          // shows the cashier WHAT was ordered so they can sanity-check
          // before pressing cobrar — especially useful when guests pay
          // separately and the cashier needs to know who ate what.
          items: {
            where: {
              cancelledAt: null,
              OR: [
                { roundId: null },
                { round: { status: { not: "cancelled" } } },
              ],
            },
            orderBy: { id: "asc" },
          },
        },
      },
    },
  });

  // Los datáfonos del comercio a los que se puede mandar un cobro ahora.
  // Antes se usaba siempre el primero; con varios, quien cobra elige.
  const { devices } = await usableTerminalDevices(tenant);

  // ORDEN: el mismo del salón del admin (/operator/tables) — primero la mesa
  // que acaba de pagar desde el celular, después las cuentas abiertas por
  // urgencia y al final las pagadas y las libres. La grilla ordena con
  // `sortTablesForTerminal` (src/lib/tables/terminalOrder.ts); acá sólo se
  // calcula, con los datos que ya trae la consulta, lo que esa regla mira de
  // cada mesa: el estado visual del salón de la cuenta abierta, si llamaron
  // al mesero y, de la pagada, cuándo se cerró y si fue desde el celular.
  const nowMs = await requestTime();
  const now = new Date(nowMs);
  const dangerMinutes = tenant.walkoutDangerMinutes;
  const phonePaidHighlightMinutes = resolvePhonePaidHighlightMinutes(
    tenant.phonePaidHighlightMinutes,
  );

  // «Cobrar» desde la ficha: qué pagos pendientes son sólo una solicitud
  // (se reemplazan al cobrar) y cuáles tienen plata en vuelo (un cobro ya
  // enviado al datáfono, un pago en línea del comensal). Una sola consulta
  // para todas las mesas.
  const replaceableById = new Map(
    (
      await withReplaceable(
        db,
        tables.flatMap((t) => (t.orders[0]?.payments ?? []).filter((p) => p.status === "pending")),
      )
    ).map((p) => [p.id, p.replaceable]),
  );

  const cards = tables.map((t) => {
    const order = t.orders[0] ?? null;
    if (!order) {
      return {
        tableId: t.id,
        number: t.number,
        label: t.label,
        state: "free" as const,
        orderId: null,
        invoiceId: null,
        shortCode: null,
        subtotalCents: 0,
        outstandingCents: 0,
        paidCents: 0,
        pendingPayments: [],
        pendingTerminalAmountCents: null,
        pendingTerminalRequestedAt: null,
        pendingCashAmountCents: null,
        pendingCashRequestedAt: null,
        items: [],
        guestGroups: [],
        approvedSummaries: [],
        visualState: null,
        needsWaiter: false,
        paidAt: null,
        paidFromPhone: false,
        charge: { canCharge: false, block: null, inFlight: null },
      };
    }
    const approved = order.payments.filter((p) => p.status === "approved");
    const pendingPayments = order.payments.filter(
      (p) => p.status === "pending",
    );
    const pendingTerminal = pendingPayments.find(
      (p) => p.method === "kushki_card_terminal",
    );
    // Efectivo pedido desde la mesa: `cash` (o `demo_cash` si el pending
    // se creó antes de que existiera `cash`).
    const pendingCash = pendingPayments.find((p) => isCashMethod(p.method));
    // El descuento del comensal identificado baja lo cobrable; sin
    // pasarlo, el datáfono cobraría el bruto y el servidor lo rechazaría.
    const totals = computeOrderTotals(
      order.subtotalCents,
      approved,
      order.taxCents,
      order.discountCents,
    );

    // Estado de la tarjeta (color + rótulo): datáfono pedido > efectivo
    // pedido > otro pago pendiente. El ORDEN de la grilla no sale de acá
    // sino de la regla del salón (ver arriba).
    const state:
      | "paid"
      | "terminal_requested"
      | "cash_requested"
      | "charging"
      | "partial"
      | "occupied" =
      order.status === "paid"
        ? "paid"
        : pendingTerminal
          ? "terminal_requested"
          : pendingCash
            ? "cash_requested"
            : pendingPayments.length > 0
              ? "charging"
              : totals.foodPaidCents > 0
                ? "partial"
                : "occupied";

    // Lo que mira el orden del salón. Cuenta abierta: su estado visual (mismo
    // cálculo que /operator/tables). Cuenta pagada: cuándo se cerró y si la
    // cerró el comensal desde su celular (esa va de primera unos minutos).
    const isPaid = order.status === "paid";
    const visualState = isPaid
      ? null
      : salonVisualStateOf(
          {
            outstandingCents: totals.outstandingCents,
            items: order.items,
            payments: order.payments,
            needsWaiter: order.needsWaiter,
            waiterCalledAt: order.waiterCalledAt,
          },
          { dangerMinutes, now },
        ).visualState;

    // Per-guest aggregation so the cashier can see who ordered what when
    // the diners are splitting the bill. Items without a guestName are
    // bucketed under "Sin nombre" so they still show up.
    const guestMap = new Map<
      string,
      { name: string; items: typeof order.items; subtotalCents: number }
    >();
    for (const i of order.items) {
      const key = i.guestName?.trim() || "__anon__";
      const label = i.guestName?.trim() || tr("anonGuest");
      const g = guestMap.get(key) ?? { name: label, items: [], subtotalCents: 0 };
      g.items.push(i);
      g.subtotalCents += i.priceCentsSnapshot * i.qty;
      guestMap.set(key, g);
    }
    const guestGroups = Array.from(guestMap.values())
      .sort((a, b) => b.subtotalCents - a.subtotalCents)
      .map((g) => ({
        name: g.name,
        subtotalCents: g.subtotalCents,
        items: g.items.map((i) => ({
          id: i.id,
          name: i.nameSnapshot,
          qty: i.qty,
          priceCents: i.priceCentsSnapshot,
        })),
      }));

    return {
      tableId: t.id,
      number: t.number,
      label: t.label,
      state,
      orderId: order.id,
      invoiceId: order.simpleInvoice?.id ?? null,
      shortCode: order.shortCode,
      subtotalCents: Math.max(0, order.subtotalCents - order.discountCents),
      outstandingCents: totals.outstandingCents,
      paidCents: totals.foodPaidCents,
      pendingPayments: pendingPayments.map((p) => ({
        id: p.id,
        method: p.method,
        amountCents: p.amountCents,
        tipCents: p.tipCents,
        cashTenderCents: p.cashTenderCents,
        createdAt: p.createdAt.toISOString(),
        // Ya enviado al datáfono (o pago en línea en curso): no se vuelve
        // a ofrecer "Cobrar con datáfono" para este pago.
        inFlight: !(replaceableById.get(p.id) ?? false),
      })),
      // amountCents YA es el TOTAL (food + tip). Sumarlo de nuevo
      // duplica la propina en la pantalla del datáfono.
      pendingTerminalAmountCents: pendingTerminal
        ? pendingTerminal.amountCents
        : null,
      pendingTerminalRequestedAt: pendingTerminal
        ? pendingTerminal.createdAt.toISOString()
        : null,
      pendingCashAmountCents: pendingCash
        ? pendingCash.amountCents
        : null,
      pendingCashRequestedAt: pendingCash
        ? pendingCash.createdAt.toISOString()
        : null,
      items: order.items.map((i) => ({
        id: i.id,
        name: i.nameSnapshot,
        qty: i.qty,
        priceCents: i.priceCentsSnapshot,
        guestName: i.guestName,
      })),
      guestGroups,
      approvedSummaries: approved.slice(-4).map((p) => ({
        id: p.id,
        method: p.method,
        amountCents: p.amountCents,
        tipCents: p.tipCents,
        settledAt: p.settledAt?.toISOString() ?? null,
      })),
      visualState,
      charge: terminalChargeState({
        paid: isPaid,
        outstandingCents: totals.outstandingCents,
        pending: pendingPayments.map((p) => ({
          method: p.method,
          amountCents: p.amountCents,
          tipCents: p.tipCents,
          // Si no está clasificado (no debería pasar), se trata como en vuelo:
          // mejor no ofrecer un cobro que el servidor puede rechazar.
          replaceable: replaceableById.get(p.id) ?? false,
        })),
      }),
      needsWaiter: !isPaid && order.needsWaiter,
      paidAt: isPaid ? (order.paidAt?.toISOString() ?? null) : null,
      paidFromPhone: isPaid && wasPaidFromPhone(approved),
    };
  });

  return (
    <TerminalGrid
      tenantSlug={tenant.slug}
      tenantName={tenant.name}
      tables={cards}
      devices={devices}
      initialTime={nowMs}
      phonePaidHighlightMinutes={phonePaidHighlightMinutes}
    />
  );
}
