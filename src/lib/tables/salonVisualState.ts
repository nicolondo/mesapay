import {
  computeVisualState,
  computeWalkoutRisk,
  type RiskResult,
  type TableVisualState,
} from "@/lib/walkoutRisk";

/**
 * Estado visual de una mesa con CUENTA ABIERTA a partir de las señales crudas
 * de la cuenta: es el valor que colorea el tile del salón y el que
 * `sortTablesForSalon` usa para decidir qué mesa activa va más arriba
 * (riesgo de fuga → cobro pedido ya envejecido → cobro pedido / mesero
 * llamado → el resto).
 *
 * Mismas reglas con las que `/operator/tables` arma cada tile activo (ver
 * src/app/operator/tables/page.tsx), puestas en una función pura para que
 * otra pantalla — el datáfono (`/terminal`) — ordene sus mesas con el MISMO
 * criterio sin copiar las reglas de riesgo:
 *
 *   - Cuentan como "pedido de cobro" los pagos `pending` SIN `providerRef`.
 *     Uno con `providerRef` ya está en vuelo contra la pasarela o el
 *     datáfono: es el flujo normal de cobro, no una mesa esperando.
 *   - El mesero llamado (`needsWaiter`) también es un pedido pendiente.
 *   - El último pago aprobado reinicia el reloj de "comieron y no pagan".
 *
 * Sin dependencias de servidor: recibe fechas ya cargadas y el `now`.
 */
export type SalonOrderSignals = {
  /** Lo que falta por cobrar. Con 0 o menos no hay riesgo de fuga. */
  outstandingCents: number;
  /** Ítems vivos de la cuenta (los cancelados pueden venir: se ignoran). */
  items: ReadonlyArray<{
    servedAt: Date | null;
    cancelledAt: Date | null;
    kitchenStatus: string;
  }>;
  /** Pagos de la cuenta; sólo se miran los `pending` y los `approved`. */
  payments: ReadonlyArray<{
    status: string;
    providerRef: string | null;
    createdAt: Date;
    settledAt: Date | null;
  }>;
  needsWaiter: boolean;
  waiterCalledAt: Date | null;
};

export function salonVisualStateOf(
  order: SalonOrderSignals,
  opts: {
    /** `Restaurant.walkoutDangerMinutes` (20 si el comercio no lo fijó). */
    dangerMinutes: number;
    now: Date;
  },
): { risk: RiskResult; visualState: TableVisualState } {
  const pendingForRisk = order.payments.filter(
    (p) => p.status === "pending" && !p.providerRef,
  );
  let lastApprovedMs = 0;
  for (const p of order.payments) {
    if (p.status !== "approved" || !p.settledAt) continue;
    lastApprovedMs = Math.max(lastApprovedMs, p.settledAt.getTime());
  }

  const risk = computeWalkoutRisk(
    {
      outstandingCents: order.outstandingCents,
      items: order.items.map((i) => ({
        servedAt: i.servedAt,
        cancelledAt: i.cancelledAt,
      })),
      pendingPaymentCreatedAts: pendingForRisk.map((p) => p.createdAt),
      waiterCalledAt: order.waiterCalledAt,
      needsWaiter: order.needsWaiter,
      lastApprovedPaymentAt: lastApprovedMs > 0 ? new Date(lastApprovedMs) : null,
      dangerMinutes: opts.dangerMinutes,
    },
    opts.now,
  );

  const liveItems = order.items.filter((i) => i.cancelledAt == null);
  const visualState = computeVisualState({
    hasActiveOrder: true,
    recentlyPaid: false,
    hasPendingRequest: pendingForRisk.length > 0 || order.needsWaiter === true,
    hasReadyItems: liveItems.some(
      (i) => i.kitchenStatus === "ready" && i.servedAt == null,
    ),
    hasCookingItems: liveItems.some(
      (i) =>
        (i.kitchenStatus === "placed" || i.kitchenStatus === "in_kitchen") &&
        i.servedAt == null,
    ),
    riskLevel: risk.level,
  });

  return { risk, visualState };
}
