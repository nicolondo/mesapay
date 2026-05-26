// Walkout-risk: calcula la probabilidad de que una mesa con cuenta
// abierta se vaya sin pagar. Lo consume la vista /mesero/mesas (y
// /operator/tables) para colorear los tiles por urgencia.
//
// Diseño (ver discusión 26-may):
//   Señal 1 — Requests EXPLÍCITOS sin atender (peso alto)
//     · Payment pending creado hace X min (cash_requested o
//       terminal_requested)
//     · Order.needsWaiter activo con waiterCalledAt vieja
//     Umbral efectivo: 50% del walkoutDangerMinutes del comercio.
//
//   Señal 2 — Comió y no paga (peso medio)
//     · Todos los items entregados (servedAt lleno en todos los
//       no-cancelados) + outstanding > 0
//     · El reloj arranca en el último servedAt
//     Umbral: walkoutDangerMinutes completo.
//
//   Señal 3 — Items en cocina (sin riesgo)
//     · Falta cocinar/entregar algo → están comiendo. Salida
//       temprana, devuelve "none".
//
// Niveles: "none" | "watch" | "warn" | "danger"
//   none   — sin highlight visual
//   watch  — atento, sin alarma (>25% del umbral)
//   warn   — atención necesaria (>50% del umbral)
//   danger — riesgo real, atención inmediata (>=100% del umbral)

export type RiskLevel = "none" | "watch" | "warn" | "danger";

export type RiskInput = {
  // Lo que les falta por pagar. Si <= 0, riesgo = none (ya pagaron).
  outstandingCents: number;
  // Items vivos (no cancelados) de la orden con su servedAt. Si
  // alguno es null, todavía hay algo en cocina/servir.
  items: Array<{ servedAt: Date | null; cancelledAt: Date | null }>;
  // Payments en estado pending (cash/terminal request). Sólo
  // cuentan los que NO tienen providerRef (los pinneados a un
  // datafono que está esperando aprobación NO son walkout).
  pendingPaymentCreatedAts: Date[];
  // Llamada al mesero sin acknowledge. needsWaiter=true significa
  // que está pendiente; al hacer ack se baja a false.
  waiterCalledAt: Date | null;
  needsWaiter: boolean;
  // Pago aprobado más reciente — resetea el reloj de Señal 2.
  // Indica que están pagando (parcial), no fugando.
  lastApprovedPaymentAt: Date | null;
  // Umbral del comercio (default 20). Watch/warn/danger se derivan
  // a partir de este número.
  dangerMinutes: number;
};

export type RiskResult = {
  level: RiskLevel;
  // Minutos transcurridos en el factor que dispara el riesgo. Lo
  // usa la UI para mostrar "23m" debajo del tile.
  // 0 si level === "none".
  agingMinutes: number;
  // Qué señal lo gatilla — útil para tooltip/explicación.
  reason: "none" | "request" | "served";
};

const NO_RISK: RiskResult = { level: "none", agingMinutes: 0, reason: "none" };

export function computeWalkoutRisk(
  input: RiskInput,
  now: Date = new Date(),
): RiskResult {
  // 1. Sin outstanding → sin riesgo, fin.
  if (input.outstandingCents <= 0) return NO_RISK;

  const dangerMin = Math.max(1, input.dangerMinutes);

  // Helper: minutos entre dos fechas (positivo si ts < now).
  const minSince = (ts: Date): number =>
    Math.max(0, (now.getTime() - ts.getTime()) / 60000);

  // 2. Requests explícitos pendientes — umbral más corto (mitad).
  // Sumamos los timestamps de Payment.pending + waiter call.
  const requestAges: number[] = [];
  for (const created of input.pendingPaymentCreatedAts) {
    requestAges.push(minSince(created));
  }
  if (input.needsWaiter && input.waiterCalledAt) {
    requestAges.push(minSince(input.waiterCalledAt));
  }
  if (requestAges.length > 0) {
    const oldestMin = Math.max(...requestAges);
    const reqDanger = dangerMin / 2; // ej: 10 si danger=20
    const reqWarn = dangerMin / 4; // ej: 5
    let level: RiskLevel = "watch";
    if (oldestMin >= reqDanger) level = "danger";
    else if (oldestMin >= reqWarn) level = "warn";
    return {
      level,
      agingMinutes: Math.round(oldestMin),
      reason: "request",
    };
  }

  // 3. Items en cocina → salida temprana, sin riesgo.
  const liveItems = input.items.filter((i) => i.cancelledAt == null);
  if (liveItems.length === 0) return NO_RISK; // sin items vivos = sin orden cobrable
  const allServed = liveItems.every((i) => i.servedAt != null);
  if (!allServed) return NO_RISK;

  // 4. Comieron + outstanding > 0. El reloj arranca en max(servedAt)
  // pero si hubo un pago aprobado posterior, ese pisa (están
  // pagando, no fugando).
  const lastServed = new Date(
    Math.max(
      ...liveItems
        .map((i) => i.servedAt!.getTime())
        .filter((t) => Number.isFinite(t)),
    ),
  );
  const clockStart =
    input.lastApprovedPaymentAt &&
    input.lastApprovedPaymentAt.getTime() > lastServed.getTime()
      ? input.lastApprovedPaymentAt
      : lastServed;
  const min = minSince(clockStart);

  // Sub-umbrales sobre dangerMin completo.
  const watchAt = dangerMin * 0.25; // ej: 5
  const warnAt = dangerMin * 0.5; // ej: 10
  const dangerAt = dangerMin; // ej: 20

  let level: RiskLevel = "none";
  if (min >= dangerAt) level = "danger";
  else if (min >= warnAt) level = "warn";
  else if (min >= watchAt) level = "watch";

  if (level === "none") return NO_RISK;
  return {
    level,
    agingMinutes: Math.round(min),
    reason: "served",
  };
}

/**
 * Estado visual discreto de una mesa, derivado del estado de la
 * orden + walkoutRisk. Es lo que el mesero "lee" de un vistazo en
 * el tile. No confundir con OrderStatus (placed/in_kitchen/...) —
 * esto es UI-driven y absorbe varias señales en un solo valor.
 *
 * Orden de precedencia (primer match gana, ver computeVisualState):
 *   1. free / recently_paid (sin orden activa)
 *   2. danger (walkout danger override)
 *   3. needs_payment_urgent / needs_payment (cash/terminal/waiter pending)
 *   4. ready_to_serve (items listos no servidos)
 *   5. eating_at_risk (todo servido + walkout warn)
 *   6. cooking (items en cocina)
 *   7. eating (todo servido sin urgencia)
 */
export type TableVisualState =
  | "free"
  | "recently_paid"
  | "cooking"
  | "ready_to_serve"
  | "eating"
  | "eating_at_risk"
  | "needs_payment"
  | "needs_payment_urgent"
  | "danger";

export type VisualStateInput = {
  hasActiveOrder: boolean;
  recentlyPaid: boolean;
  // Si hay Payment.pending (cash/terminal request) o needsWaiter.
  // El walkout-risk uses these to compute risk level, pero acá
  // queremos saber si la flag está activa para mostrar terracotta.
  hasPendingRequest: boolean;
  // Some item kitchenStatus=ready + servedAt=null + !cancelled
  hasReadyItems: boolean;
  // Some item kitchenStatus in (placed, in_kitchen) + !cancelled
  hasCookingItems: boolean;
  // Resultado del walkout-risk para escalar el state
  riskLevel: RiskLevel;
};

export function computeVisualState(
  input: VisualStateInput,
): TableVisualState {
  if (!input.hasActiveOrder) {
    return input.recentlyPaid ? "recently_paid" : "free";
  }

  // Walkout danger sobre-escribe TODO. Es la señal más urgente.
  if (input.riskLevel === "danger") return "danger";

  // Pedido explícito de cobro / mesero — terracotta. Si el request
  // ya escaló a "warn" en el walkout, marcamos urgente (+pulse).
  if (input.hasPendingRequest) {
    return input.riskLevel === "warn"
      ? "needs_payment_urgent"
      : "needs_payment";
  }

  // Comida lista pero no servida — acción del mesero. Amber fuerte.
  // Si además llegó a "warn" se nota igualmente porque ya es amber.
  if (input.hasReadyItems) return "ready_to_serve";

  // Falta cocinar — amber claro, sin acción urgente del mesero.
  if (input.hasCookingItems) return "cooking";

  // Todo servido, outstanding > 0. Pueden estar comiendo o ya
  // terminaron. Si el walkout dice "warn", subimos a "eating_at_risk".
  if (input.riskLevel === "warn") return "eating_at_risk";
  return "eating";
}

/** Helper de tipografía para el tile (rojo/amber/etc). */
export function tileTokensForRisk(level: RiskLevel): {
  bg: string;
  border: string;
  dot: string;
  textAccent: string;
} {
  // Reusamos los tokens del operator (op-* + danger/warn/ok)
  switch (level) {
    case "danger":
      return {
        bg: "bg-[#C9302C]/10",
        border: "border-[#C9302C]/40",
        dot: "bg-[#C9302C]",
        textAccent: "text-[#C9302C]",
      };
    case "warn":
      return {
        bg: "bg-[#C98A2E]/12",
        border: "border-[#C98A2E]/45",
        dot: "bg-[#C98A2E]",
        textAccent: "text-[#7F5A1F]",
      };
    case "watch":
      return {
        bg: "bg-[#C98A2E]/6",
        border: "border-[#C98A2E]/25",
        dot: "bg-[#C98A2E]/70",
        textAccent: "text-op-text",
      };
    case "none":
    default:
      // Activa sin riesgo: bg sutil pero VISIBLEMENTE distinto del
      // libre (bg-op-surface). Un wash de ink al 5% sobre la
      // superficie da una sombra calida que dice "alguien esta
      // sentado aca" sin levantar alarma. Border ink/30 refuerza
      // el contorno por si el bg no se ve bien en pantallas con
      // poco contraste.
      return {
        bg: "bg-ink/[0.05]",
        border: "border-ink/20",
        dot: "bg-ink/50",
        textAccent: "text-op-text",
      };
  }
}

/**
 * Mapper de TableVisualState → clases tailwind. Lo consume el tile
 * de Mesas para colorear bg/border/dot/accent. Si `pulse=true`, el
 * dot debe animarse — la decisión de animar el dot vive acá (no en
 * el componente) para que el config sea declarativo.
 */
export function tileTokensForState(state: TableVisualState): {
  bg: string;
  border: string;
  dot: string;
  textAccent: string;
  pulse: boolean;
} {
  switch (state) {
    case "free":
      return {
        bg: "bg-op-surface",
        border: "border-op-border",
        dot: "bg-op-border-2",
        textAccent: "text-op-text",
        pulse: false,
      };
    case "recently_paid":
      return {
        bg: "bg-ok/10",
        border: "border-ok/35",
        dot: "bg-ok",
        textAccent: "text-[#1E5339]",
        pulse: false,
      };
    case "cooking":
      // Amber claro — "cocina trabajando, no hay nada que hacer".
      return {
        bg: "bg-[#C98A2E]/8",
        border: "border-[#C98A2E]/30",
        dot: "bg-[#C98A2E]/70",
        textAccent: "text-op-text",
        pulse: false,
      };
    case "ready_to_serve":
      // Amber fuerte — ¡acción! comida lista para entregar.
      return {
        bg: "bg-[#C98A2E]/18",
        border: "border-[#C98A2E]/55",
        dot: "bg-[#C98A2E]",
        textAccent: "text-[#7F5A1F]",
        pulse: false,
      };
    case "eating":
      // Ink suave — mesa ocupada sin acción urgente. Diferente del
      // "free" pero sin alarma.
      return {
        bg: "bg-ink/[0.05]",
        border: "border-ink/20",
        dot: "bg-ink/50",
        textAccent: "text-op-text",
        pulse: false,
      };
    case "eating_at_risk":
      // Walkout warn — los clientes terminaron de comer y llevan
      // un rato sin pagar. Amber medio para llamar la atención
      // sin todavía gritar.
      return {
        bg: "bg-[#C98A2E]/14",
        border: "border-[#C98A2E]/45",
        dot: "bg-[#C98A2E]",
        textAccent: "text-[#7F5A1F]",
        pulse: false,
      };
    case "needs_payment":
      // Terracotta — el cliente pidió cobrar (cash/datafono/mesero).
      return {
        bg: "bg-terracotta/12",
        border: "border-terracotta/40",
        dot: "bg-terracotta",
        textAccent: "text-terracotta",
        pulse: false,
      };
    case "needs_payment_urgent":
      // Cobro pedido + tiempo. Pulsa para forzar la mirada.
      return {
        bg: "bg-terracotta/20",
        border: "border-terracotta/60",
        dot: "bg-terracotta",
        textAccent: "text-terracotta",
        pulse: true,
      };
    case "danger":
      // Walkout danger — rojo + pulse. La situación más urgente.
      return {
        bg: "bg-[#C9302C]/12",
        border: "border-[#C9302C]/45",
        dot: "bg-[#C9302C]",
        textAccent: "text-[#C9302C]",
        pulse: true,
      };
  }
}

/** Copy human-readable de la razón. Para tooltips. */
export function riskExplanation(
  result: RiskResult,
  dangerMinutes: number,
): string {
  if (result.level === "none") return "";
  if (result.reason === "request") {
    return `Pedido de cobro/mesero hace ${result.agingMinutes}m sin atender (umbral ${Math.round(dangerMinutes / 2)}m).`;
  }
  return `Entregado hace ${result.agingMinutes}m sin pagar (umbral ${dangerMinutes}m).`;
}
