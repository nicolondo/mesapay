import type { KushkiMode } from "../../platformConfig";
import { kushkiFetch, KushkiHttpError } from "./client";
import { KUSHKI_TRANSFER_ERRORS, readKushkiErrorCode, type TransferProcessor } from "./breB";
import { pseProcessorFor } from "./transferConfig";

/**
 * Token de PSE pedido DESDE EL SERVIDOR (`POST /transfer/v1/tokens`, llave
 * pública), consciente del modo multiprocesador.
 *
 * Un comercio con PSE como único procesador de transferencias pide el token
 * sin `processor`, como siempre. Pero si Kushki le habilita Bre-B en el
 * MISMO comercio (modo multiprocesador), TODO token tiene que decir a qué
 * procesador va —también el de PSE: `processor: { name }`, sin `channel`—.
 * El nombre no se escribe a mano: sale del config del comercio.
 *
 * En MESAPAY el cobro normal de PSE tokeniza en el navegador con Kushki.js,
 * que no sabe mandar `processor`. Por eso este camino es el RESPALDO: si el
 * init de un token del navegador rebota con 422 E046 ("token no compatible
 * con el procesador"), la ruta pide acá un token nuevo, con el procesador
 * de PSE, y reintenta. Con un solo procesador nada de esto corre.
 */

export type PseTokenInput = {
  amountCents: number;
  currency: string;
  callbackUrl: string;
  buyer: { email: string; docType: string; docNumber: string; personType: string };
  bankCode: string;
  paymentDescription?: string;
};

/** Cuerpo del token de PSE. `processor` sólo viaja en modo multiprocesador. */
export function buildPseTokenBody(input: PseTokenInput, processor?: TransferProcessor | null): Record<string, unknown> {
  return {
    amount: { subtotalIva: 0, subtotalIva0: input.amountCents / 100, iva: 0 },
    callbackUrl: input.callbackUrl,
    userType: input.buyer.personType === "juridica" ? "1" : "0",
    documentType: input.buyer.docType,
    documentNumber: input.buyer.docNumber,
    email: input.buyer.email,
    currency: input.currency,
    bankId: input.bankCode,
    ...(input.paymentDescription ? { paymentDescription: input.paymentDescription } : {}),
    // PSE: sólo el nombre, sin canal y sin ninguna otra propiedad.
    ...(processor ? { processor: { name: processor.name } } : {}),
  };
}

/** ¿El init rebotó porque el token no era del procesador (422 E046)? */
export function isProcessorMismatch(err: unknown): boolean {
  return (
    err instanceof KushkiHttpError &&
    err.status === 422 &&
    readKushkiErrorCode(err.body) === KUSHKI_TRANSFER_ERRORS.processorMismatch
  );
}

/**
 * Token de PSE con el `processor` de PSE del comercio, para reintentar un
 * init que rebotó con E046. Lee el config sin caché (acaba de cambiar) y
 * devuelve null si el comercio NO está en modo multiprocesador: ahí el E046
 * no se arregla con esto y quien llama conserva el error original.
 */
export async function requestPseTokenForMultiProcessor(
  mode: Exclude<KushkiMode, "mock">,
  publicKey: string,
  input: PseTokenInput,
): Promise<string | null> {
  const processor = await pseProcessorFor(mode, publicKey, { fresh: true });
  if (!processor) return null;
  const resp = await kushkiFetch<Record<string, unknown>>("/transfer/v1/tokens", {
    method: "POST",
    auth: { kind: "submerchant_public", publicKey },
    mode,
    body: buildPseTokenBody(input, processor),
  });
  return typeof resp.token === "string" && resp.token ? resp.token : null;
}
