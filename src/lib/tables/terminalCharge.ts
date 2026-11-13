/**
 * ¿Puede el usuario de datáfono EMPEZAR el cobro de esta mesa desde «Mesas
 * en vivo», y si no, por qué? Lo que decide si la ficha muestra el botón
 * «Cobrar» o el motivo.
 *
 * Son los mismos bloqueos que ya aplica el cobro del staff en el servidor
 * (src/lib/payments/staffCharge.ts), leídos antes para no mandar a nadie a
 * un checkout que le va a rebotar:
 *
 *   - Cuenta pagada → nada que cobrar.
 *   - Sin saldo pendiente → nada que cobrar.
 *   - Plata EN VUELO que se lleva todo el saldo: un cobro ya enviado al
 *     datáfono Kushki, o un pago en línea del comensal en curso (PSE,
 *     tarjeta, Apple Pay). No se toca: hay que esperar su resultado.
 *     Si el pago en vuelo cubre sólo una parte, se puede cobrar el resto
 *     (`inFlight` lo dice para avisarlo).
 *
 * Una SOLICITUD (el comensal o un mesero pidió efectivo, datáfono propio o
 * datáfono Kushki que nadie envió) no bloquea: la ficha la muestra con su
 * propio botón, y si se cobra de otra forma el servidor la reemplaza.
 *
 * Función pura: la página la evalúa con los pagos ya clasificados
 * (`withReplaceable`).
 */

export type TerminalChargeBlock =
  | "paid"
  | "nothing_outstanding"
  | "terminal_in_flight"
  | "online_in_flight";

export type TerminalInFlight = {
  /** "terminal" si hay un cobro del datáfono Kushki en curso; si no, "online". */
  kind: "terminal" | "online";
  /** Lo que reservan los pagos en vuelo (TOTAL, propina incluida). */
  amountCents: number;
};

export type TerminalChargeState = {
  canCharge: boolean;
  block: TerminalChargeBlock | null;
  inFlight: TerminalInFlight | null;
};

/** Holgura de redondeo, la misma del cobro del staff y del trigger. */
const SLACK_CENTS = 1;

export function terminalChargeState(input: {
  paid: boolean;
  /** Lo que falta por cobrar de la cuenta (sin propina). */
  outstandingCents: number;
  /** Pagos `pending` de la cuenta, ya clasificados. */
  pending: ReadonlyArray<{
    method: string;
    amountCents: number;
    tipCents: number;
    replaceable: boolean;
  }>;
}): TerminalChargeState {
  if (input.paid) return { canCharge: false, block: "paid", inFlight: null };
  if (input.outstandingCents <= 0) {
    return { canCharge: false, block: "nothing_outstanding", inFlight: null };
  }

  const flying = input.pending.filter((p) => !p.replaceable);
  if (flying.length === 0) return { canCharge: true, block: null, inFlight: null };

  const inFlight: TerminalInFlight = {
    kind: flying.some((p) => p.method === "kushki_card_terminal") ? "terminal" : "online",
    amountCents: flying.reduce((s, p) => s + p.amountCents, 0),
  };
  // Lo que reservan, sin la propina: es lo que se descuenta del saldo.
  const reservedFood = flying.reduce((s, p) => s + Math.max(0, p.amountCents - p.tipCents), 0);
  if (input.outstandingCents - reservedFood <= SLACK_CENTS) {
    return {
      canCharge: false,
      block: inFlight.kind === "terminal" ? "terminal_in_flight" : "online_in_flight",
      inFlight,
    };
  }
  return { canCharge: true, block: null, inFlight };
}
