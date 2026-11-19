// Cobro EN SERIE de una cuenta dividida (modo staff) — LÓGICA PURA, sin DB
// ni React.
//
// Cuando el personal cobra una cuenta entre varios (partes iguales o lo de
// cada comensal), cada pago aprobado NO debe mandar el flujo a "listo" ni a
// Mesas: se queda en la misma pantalla, avanza a la parte siguiente y ofrece
// repetir el mismo método con un toque. Este módulo lleva ese avance:
//
//   · El PLAN: cuántas partes son, cuántas van cobradas, qué comensales ya
//     pagaron (modo individual), el último método usado y el cobro lanzado
//     cuyo resultado aún no se conoce (datáfono, Bre-B).
//   · La RECONCILIACIÓN contra la verdad del servidor: la lista de pagos
//     aprobados y pendientes de la orden. De ahí sale si la parte en vuelo
//     se aprobó (avanzar), se rechazó (ofrecer reintentar ESA parte) o si
//     alguien más pagó a la vez (ajustar y avisar discreto).
//   · El MONTO de cada parte, recalculado contra el saldo real: la parte
//     k+1 de N es el saldo entre las partes que faltan, y la ÚLTIMA parte
//     cobra EXACTO el saldo restante (nada de dejar $1 por redondeo).
//
// El plan se guarda en localStorage POR CUENTA (`serialStorageKey`), pero la
// verdad del saldo y de cada pago es siempre del servidor: si el navegador
// se cierra a mitad, al reabrir el cobro se retoma con el saldo real y el
// plan guardado (o, sin plan, se arma de nuevo sin perder nada cobrado).
//
// Sólo aplica al cobro del personal. El flujo del comensal en su propio
// celular no pasa por acá.

/** Métodos que el staff puede repetir con un toque en la parte siguiente. */
export type SerialMethod =
  | "cash"
  | "kushki_card_terminal"
  | "external_terminal"
  | "kushki_bre_b";

export type SerialMode = "equal" | "mine";

/** Cobro lanzado cuyo resultado todavía no se conoce (datáfono, Bre-B). */
export type SerialInFlight = {
  paymentId: string;
  method: SerialMethod;
  /** Comensal del modo individual, para marcarlo pagado al aprobar. */
  guest: string | null;
};

export type SerialPlan = {
  mode: SerialMode;
  /** Partes totales del modo partes iguales (≥ 2). */
  splitCount: number;
  /** Partes ya cobradas POR ESTE FLUJO (los pagos ajenos no cuentan acá). */
  partsDone: number;
  /** Comensales ya cobrados en el modo individual. */
  guestsPaid: string[];
  /**
   * Pagos aprobados ya contados (ids). Todo aprobado nuevo que no esté acá
   * es o la parte en vuelo (avanza el plan) o un pago ajeno (ajusta saldo).
   */
  accountedPaymentIds: string[];
  /** Último método con el que se cobró una parte, para «Cobrar siguiente». */
  lastMethod: SerialMethod | null;
  inFlight: SerialInFlight | null;
};

/** Qué pasó al reconciliar contra el servidor, para contárselo a quien cobra. */
export type SerialEvent =
  | {
      kind: "approved";
      /** La parte que se acaba de cobrar (1-based) y el total del plan. */
      partIndex: number;
      splitCount: number;
      /** En modo individual, el comensal que quedó pagado. */
      guest: string | null;
      amountCents: number;
      method: SerialMethod;
    }
  | { kind: "declined"; method: SerialMethod; guest: string | null }
  | { kind: "balance_changed"; amountCents: number };

export const MAX_SERIAL_PARTS = 20;

/** Dónde se recuerda (en este aparato) el plan de cobro en serie de una cuenta. */
export function serialStorageKey(orderId: string): string {
  return `mesapay.serial.${orderId}`;
}

const SERIAL_METHODS: readonly string[] = [
  "cash",
  "kushki_card_terminal",
  "external_terminal",
  "kushki_bre_b",
];

export function isSerialMethod(method: unknown): method is SerialMethod {
  return typeof method === "string" && SERIAL_METHODS.includes(method);
}

const clampParts = (n: number) =>
  Math.min(MAX_SERIAL_PARTS, Math.max(2, Math.round(n)));

/**
 * Plan nuevo. `accountedPaymentIds` arranca con los aprobados que YA tiene la
 * orden: lo pagado antes de armar el plan nunca dispara eventos.
 */
export function createSerialPlan(
  mode: SerialMode,
  splitCount: number,
  accountedPaymentIds: string[],
): SerialPlan {
  return {
    mode,
    splitCount: clampParts(splitCount),
    partsDone: 0,
    guestsPaid: [],
    accountedPaymentIds: [...new Set(accountedPaymentIds)],
    lastMethod: null,
    inFlight: null,
  };
}

/**
 * Monto de la parte que sigue en partes iguales: el saldo REAL entre las
 * partes que faltan, al PESO entero (como la propina: COP no usa centavos y
 * el datáfono Kushki cobra pesos enteros — una parte de $33.333,33 acabaría
 * «aprobada por otro monto»). La última parte se lleva exacto el saldo, con
 * sus centavos si los hubiera; cualquier aritmética rara queda topada por el
 * saldo (nunca se cobra de más).
 */
export function serialEqualPartCents(
  outstandingCents: number,
  splitCount: number,
  partsDone: number,
): number {
  const outstanding = Math.max(0, Math.round(outstandingCents));
  const remaining = Math.max(1, clampParts(splitCount) - Math.max(0, Math.round(partsDone)));
  if (remaining === 1) return outstanding;
  const raw = Math.round(outstanding / remaining);
  const wholePesos = Math.round(raw / 100) * 100;
  return Math.min(outstanding, wholePesos > 0 ? wholePesos : raw);
}

/** Partes que faltan del plan (mínimo 1 mientras haya saldo). */
export function serialRemainingParts(plan: SerialPlan): number {
  return Math.max(1, plan.splitCount - plan.partsDone);
}

/** El staff cambió el "entre cuántos": nunca menos que lo ya cobrado + 1. */
export function withSplitCount(plan: SerialPlan, splitCount: number): SerialPlan {
  return {
    ...plan,
    splitCount: Math.max(clampParts(splitCount), plan.partsDone + 1),
  };
}

/** Se lanzó un cobro (datáfono, Bre-B…) y el resultado llegará después. */
export function withChargeLaunched(
  plan: SerialPlan,
  launch: { paymentId: string; method: SerialMethod; guest?: string | null },
): SerialPlan {
  return {
    ...plan,
    lastMethod: launch.method,
    inFlight: {
      paymentId: launch.paymentId,
      method: launch.method,
      guest: launch.guest ?? null,
    },
  };
}

/** Un aprobado avanza el plan: parte cobrada, comensal pagado, método recordado. */
function advance(
  plan: SerialPlan,
  payment: { id: string; method: SerialMethod; guest: string | null },
): SerialPlan {
  return {
    ...plan,
    partsDone: Math.min(plan.splitCount, plan.partsDone + 1),
    guestsPaid:
      plan.mode === "mine" && payment.guest && !plan.guestsPaid.includes(payment.guest)
        ? [...plan.guestsPaid, payment.guest]
        : plan.guestsPaid,
    accountedPaymentIds: plan.accountedPaymentIds.includes(payment.id)
      ? plan.accountedPaymentIds
      : [...plan.accountedPaymentIds, payment.id],
    lastMethod: payment.method,
    inFlight: plan.inFlight?.paymentId === payment.id ? null : plan.inFlight,
  };
}

/**
 * Un cobro que se aprobó EN EL ACTO (efectivo del staff, QR Bre-B aprobado a
 * la vista): avanza ya, sin esperar la reconciliación. Contarlo acá evita que
 * la reconciliación lo tome por un pago ajeno.
 */
export function withApprovedNow(
  plan: SerialPlan,
  payment: {
    paymentId: string;
    method: SerialMethod;
    amountCents: number;
    guest?: string | null;
  },
): { plan: SerialPlan; event: SerialEvent } {
  const next = advance(plan, {
    id: payment.paymentId,
    method: payment.method,
    guest: payment.guest ?? null,
  });
  return {
    plan: next,
    event: {
      kind: "approved",
      partIndex: next.partsDone,
      splitCount: next.splitCount,
      guest: payment.guest ?? null,
      amountCents: payment.amountCents,
      method: payment.method,
    },
  };
}

/**
 * Reconciliación contra la verdad del servidor (los pagos de la orden, tal
 * como los manda `PayFlow`). Decide, en orden:
 *
 *   1. La parte en vuelo está APROBADA → avanza el plan (evento `approved`).
 *   2. La parte en vuelo no está ni aprobada ni pendiente → se rechazó o se
 *      canceló (evento `declined`); la parte queda igual para reintentarla.
 *      Pendiente (incluido "sin confirmar") NO es rechazo: se sigue esperando.
 *   3. Aprobados nuevos que no son de este flujo → pago ajeno (alguien pagó a
 *      la vez desde su celular): se contabilizan y se avisa discreto
 *      (`balance_changed`); las partes se ajustan solas porque el monto
 *      siempre sale del saldo real.
 */
export function reconcileSerialPlan(
  plan: SerialPlan,
  approvedPayments: ReadonlyArray<{ id: string; amountCents: number; tipCents: number }>,
  pendingPaymentIds: ReadonlyArray<string>,
): { plan: SerialPlan; events: SerialEvent[] } {
  const events: SerialEvent[] = [];
  let next = plan;
  const fresh = approvedPayments.filter(
    (p) => !next.accountedPaymentIds.includes(p.id),
  );

  const ours = next.inFlight
    ? fresh.find((p) => p.id === next.inFlight!.paymentId) ?? null
    : null;
  if (ours && next.inFlight) {
    const inFlight = next.inFlight;
    next = advance(next, { id: ours.id, method: inFlight.method, guest: inFlight.guest });
    events.push({
      kind: "approved",
      partIndex: next.partsDone,
      splitCount: next.splitCount,
      guest: inFlight.guest,
      amountCents: ours.amountCents,
      method: inFlight.method,
    });
  } else if (
    next.inFlight &&
    !approvedPayments.some((p) => p.id === next.inFlight!.paymentId) &&
    !pendingPaymentIds.includes(next.inFlight.paymentId)
  ) {
    // Ni aprobado ni pendiente: el intento murió (rechazo o cancelación).
    events.push({
      kind: "declined",
      method: next.inFlight.method,
      guest: next.inFlight.guest,
    });
    next = { ...next, inFlight: null };
  }

  const foreign = fresh.filter((p) => p.id !== ours?.id);
  if (foreign.length > 0) {
    next = {
      ...next,
      accountedPaymentIds: [
        ...next.accountedPaymentIds,
        ...foreign.map((p) => p.id),
      ],
    };
    events.push({
      kind: "balance_changed",
      amountCents: foreign.reduce((s, p) => s + p.amountCents, 0),
    });
  }

  return { plan: next, events };
}

/**
 * Lee un plan guardado. Cualquier cosa que no cuadre (otra versión, basura,
 * números imposibles) devuelve null: mejor rearmar que cobrar con un plan
 * corrupto.
 */
export function parseSerialPlan(raw: unknown): SerialPlan | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<SerialPlan> | null;
    if (!v || (v.mode !== "equal" && v.mode !== "mine")) return null;
    const splitCount = Number(v.splitCount);
    const partsDone = Number(v.partsDone);
    if (!Number.isInteger(splitCount) || splitCount < 2 || splitCount > MAX_SERIAL_PARTS) return null;
    if (!Number.isInteger(partsDone) || partsDone < 0 || partsDone > splitCount) return null;
    const strings = (list: unknown): string[] =>
      Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
    const inFlight =
      v.inFlight &&
      typeof v.inFlight === "object" &&
      typeof v.inFlight.paymentId === "string" &&
      isSerialMethod(v.inFlight.method)
        ? {
            paymentId: v.inFlight.paymentId,
            method: v.inFlight.method,
            guest: typeof v.inFlight.guest === "string" ? v.inFlight.guest : null,
          }
        : null;
    return {
      mode: v.mode,
      splitCount,
      partsDone,
      guestsPaid: strings(v.guestsPaid),
      accountedPaymentIds: strings(v.accountedPaymentIds),
      lastMethod: isSerialMethod(v.lastMethod) ? v.lastMethod : null,
      inFlight,
    };
  } catch {
    return null;
  }
}
