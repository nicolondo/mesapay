// Lo que pasa cuando una factura electrónica queda ACEPTADA, venga por
// donde venga la aceptación: la respuesta síncrona del envío
// (`emitDianInvoice`), la consulta por CUFE de una factura que la DIAN ya
// tenía (`invoiceReconcile.ts`: regla 90, reenvío, barrido, recuperación).
//
// Los tres efectos son idempotentes y no lanzan (cada uno se cuida solo):
//   · cierre de las solicitudes de factura de la cuenta;
//   · correo al adquiriente con el AttachedDocument (`emailedAt`);
//   · papel de la factura electrónica (`dedupeKey invoice:<id>`).
//
// La contabilidad NO cuelga de la aceptación de una factura: el motor
// contable asienta las ventas desde las órdenes cobradas, así que una
// factura que pasa de rechazada a aceptada no mueve ningún asiento.
import { dianQrUrl } from "@/lib/dian/crypto";
import {
  closeInvoiceRequestsAfterDeferredAcceptance,
  closeInvoiceRequestsOnAcceptance,
} from "@/lib/dian/invoiceRequestClosure";
import { acceptedInvoiceClosureCutoff } from "@/lib/dian/invoiceRequestCoverage";
import { sendDianInvoiceEmail } from "@/lib/dian/sendInvoiceEmail";
import { printAcceptedDianInvoice } from "@/lib/print/invoiceQueue";

/**
 * Una factura que se recupera tarde (reenvío, consulta, recuperación en
 * lote) sólo sale sola al papel si es de hace poco: la mesa puede seguir
 * ahí esperándola. Una de hace días impresa de golpe en la caja es papel
 * para la basura — para eso está «Reimprimir» en Facturas.
 */
export const AUTO_PRINT_MAX_AGE_MS = 3 * 60 * 60_000;

export function shouldAutoPrintRecovered(invoiceCreatedAt: Date, now: Date): boolean {
  return now.getTime() - invoiceCreatedAt.getTime() <= AUTO_PRINT_MAX_AGE_MS;
}

export type InvoiceClosureRail =
  /** El envío síncrono: el corte es la solicitud con la que se armó el adquiriente. */
  | { rail: "emit"; usedRequestCreatedAt: Date | null | undefined; now: Date }
  /** Aceptación diferida (consulta): el corte sale del instante del XML. */
  | { rail: "status"; xmlZip: Uint8Array | Buffer | null | undefined; now: Date };

export async function afterInvoiceAccepted(opts: {
  documentId: string;
  simpleInvoiceId: string;
  restaurantId: string;
  orderId: string | null | undefined;
  cufe: string;
  environment: "habilitacion" | "produccion";
  closure: InvoiceClosureRail;
  /** false ⇒ sin papel (lo imprime quien la pidió, o es una recuperación vieja). */
  print: boolean;
}): Promise<void> {
  if (opts.closure.rail === "emit") {
    await closeInvoiceRequestsOnAcceptance({
      orderId: opts.orderId,
      cutoff: acceptedInvoiceClosureCutoff({
        rail: "emit",
        usedRequestCreatedAt: opts.closure.usedRequestCreatedAt,
      }),
      now: opts.closure.now,
    });
  } else {
    await closeInvoiceRequestsAfterDeferredAcceptance({
      orderId: opts.orderId,
      xmlZip: opts.closure.xmlZip,
      now: opts.closure.now,
    });
  }
  await sendDianInvoiceEmail({
    documentId: opts.documentId,
    environment: opts.environment,
  });
  if (opts.print) {
    await printAcceptedDianInvoice({
      simpleInvoiceId: opts.simpleInvoiceId,
      restaurantId: opts.restaurantId,
      cufe: opts.cufe,
      qrUrl: dianQrUrl(opts.cufe, opts.environment === "produccion" ? "1" : "2"),
    });
  }
}
