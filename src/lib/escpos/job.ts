/**
 * De `PrintJob.payload` a bytes, sea cual sea el documento.
 *
 * Hay dos documentos y va a haber más (la tirilla de cierre de turno es
 * la próxima). Quién decide cuál es NO es `PrintJob.kind` sino la FORMA
 * del sobre: `{ v, ticket }` es una comanda, `{ v, invoice }` una
 * factura. Es a propósito — `kind` es un String libre justamente para que
 * sumar un tipo no cueste una migración, y atarle el render lo volvería
 * un enum de hecho: un `kind` nuevo con un documento ya conocido
 * (pongamos "shift_close" con forma de factura) sigue imprimiendo.
 *
 * Un payload que no matchea ninguna forma devuelve null y quien llama lo
 * cierra en fallido: un trabajo corrupto no puede trabar la cola.
 */

import { parseInvoicePayload, renderInvoice } from "./invoice";
import { parseTicketPayload, renderTicket } from "./ticket";

export function renderPrintJobPayload(raw: unknown): Buffer | null {
  const ticket = parseTicketPayload(raw);
  if (ticket) return renderTicket(ticket);
  const invoice = parseInvoicePayload(raw);
  if (invoice) return renderInvoice(invoice);
  return null;
}
