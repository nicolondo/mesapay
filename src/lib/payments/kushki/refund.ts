import { kushkiFetch } from "./client";
import type { KushkiMode } from "../../platformConfig";

/**
 * Devolución de un cargo con tarjeta de Kushki.
 *
 * Kushki modela la devolución como un DELETE sobre el cargo:
 *   DELETE https://api.kushkipagos.com/v1/charges/{ticketNumber}
 *   header Private-Merchant-Id: <private key del comercio>
 *   body total:   { "fullResponse": true }
 *   body parcial: { "fullResponse": true, "amount": { subtotalIva, subtotalIva0, iva, currency } }
 *
 * Kushki decide solo si es ANULACIÓN (mismo día, sale del extracto) o
 * DEVOLUCIÓN (después, transacción aparte) según el timing. Es Kushki-only,
 * por eso vive acá y no en la interfaz genérica de PaymentProvider.
 */
export type RefundOutcome = {
  ok: boolean;
  raw: unknown;
  message?: string;
};

export async function refundKushkiCharge(opts: {
  mode: KushkiMode;
  privateKey: string;
  ticketNumber: string;
  currency: "COP" | "MXN";
  /** Monto a devolver en cents (para el desglose del parcial). */
  amountCents: number;
  /** true = devolución total del cargo (sin `amount`). */
  full: boolean;
}): Promise<RefundOutcome> {
  // En modo mock no hay Kushki real: simulamos éxito para que el flujo del
  // operador funcione en demo/local sin tocar la pasarela.
  if (opts.mode === "mock") {
    return {
      ok: true,
      raw: { simulated: true, ticketNumber: opts.ticketNumber },
      message: "mock refund",
    };
  }

  const body = opts.full
    ? { fullResponse: true }
    : {
        fullResponse: true,
        amount: {
          subtotalIva: 0,
          subtotalIva0: opts.amountCents / 100,
          iva: 0,
          currency: opts.currency,
        },
      };

  // Sin schema: la respuesta de la devolución varía y sólo la guardamos en
  // KushkiTransaction.raw. Un 4xx/5xx de Kushki hace throw (KushkiHttpError).
  const raw = await kushkiFetch<Record<string, unknown>>(
    `/v1/charges/${encodeURIComponent(opts.ticketNumber)}`,
    {
      method: "DELETE",
      auth: { kind: "submerchant", privateKey: opts.privateKey },
      mode: opts.mode,
      body,
    },
  );

  const message =
    typeof raw?.message === "string"
      ? raw.message
      : typeof raw?.responseText === "string"
        ? (raw.responseText as string)
        : undefined;
  return { ok: true, raw, message };
}
