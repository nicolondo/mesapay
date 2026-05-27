import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveContext } from "@/lib/activeRestaurant";
import { computeOrderTotals } from "@/lib/orderTotals";
import { TerminalGrid } from "./TerminalGrid";

export const dynamic = "force-dynamic";

export default async function TerminalPage() {
  const session = await auth();
  const ctx = await getActiveContext();
  const restaurantId = ctx?.restaurantId ?? session?.user?.restaurantId ?? null;
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { id: true, slug: true, name: true, serviceMode: true },
  });
  if (!tenant) return <div className="p-6">Restaurante no encontrado.</div>;

  // All tables of the tenant (excluding the pickup virtual table number -1
  // since the terminal can't charge a pickup customer at the table).
  const tables = await db.table.findMany({
    where: { restaurantId: tenant.id, number: { gte: 0 } },
    orderBy: { number: "asc" },
    include: {
      orders: {
        where: { status: { notIn: ["cancelled"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        include: {
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

  const devices = await db.terminalDevice.findMany({
    where: { restaurantId: tenant.id, active: true },
    orderBy: { createdAt: "asc" },
  });

  // Pick the device this session is bound to. For now we pick the first
  // active one — in Phase 8 we'll let an admin pin a device per user.
  const device = devices[0] ?? null;

  const cards = tables.map((t) => {
    const order = t.orders[0] ?? null;
    if (!order) {
      return {
        tableId: t.id,
        number: t.number,
        label: t.label,
        state: "free" as const,
        orderId: null,
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
      };
    }
    const approved = order.payments.filter((p) => p.status === "approved");
    const pendingPayments = order.payments.filter(
      (p) => p.status === "pending",
    );
    const pendingTerminal = pendingPayments.find(
      (p) => p.method === "kushki_card_terminal",
    );
    // Cash payments come through demo_cash today (the table flow names it
    // that way regardless of mock vs real cash). Future: rename to "cash".
    const pendingCash = pendingPayments.find((p) => p.method === "demo_cash");
    const totals = computeOrderTotals(order.subtotalCents, approved);

    // Sort priority: terminal request > cash request > generic charging.
    // Both terminal and cash requests promote the table to the top of the
    // grid so the cashier sees them immediately.
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

    // Per-guest aggregation so the cashier can see who ordered what when
    // the diners are splitting the bill. Items without a guestName are
    // bucketed under "Sin nombre" so they still show up.
    const guestMap = new Map<
      string,
      { name: string; items: typeof order.items; subtotalCents: number }
    >();
    for (const i of order.items) {
      const key = i.guestName?.trim() || "__anon__";
      const label = i.guestName?.trim() || "Sin nombre";
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
      shortCode: order.shortCode,
      subtotalCents: order.subtotalCents,
      outstandingCents: totals.outstandingCents,
      paidCents: totals.foodPaidCents,
      pendingPayments: pendingPayments.map((p) => ({
        id: p.id,
        method: p.method,
        amountCents: p.amountCents,
        tipCents: p.tipCents,
        cashTenderCents: p.cashTenderCents,
        createdAt: p.createdAt.toISOString(),
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
    };
  });

  return (
    <TerminalGrid
      tenantSlug={tenant.slug}
      tenantName={tenant.name}
      tables={cards}
      device={device ? { id: device.kushkiDeviceId, label: device.label } : null}
    />
  );
}
