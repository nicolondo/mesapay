// Cierre automático de las solicitudes de factura cuando la DIAN acepta la
// factura electrónica de la cuenta.
//
// Con emisión automática nadie marca las solicitudes como generadas: la
// factura sale sola con los datos del cliente y la solicitud se quedaba
// `pending` para siempre (454 de 504 en Son y Melona en 60 días). Ahora la
// aceptación las cierra en el mismo punto en que se procesa: la respuesta
// síncrona del envío (`emitDianInvoice`) y la consulta diferida del estado
// (`dian/documents/[id]/status`). Las que llegaron DESPUÉS de emitir quedan
// pendientes: sus datos no entraron en la factura y la pantalla las muestra.
// Reglas en `invoiceRequestCoverage.ts`.
//
// Contrato, igual que el correo y la impresión de la aceptación: NUNCA
// lanza. Cuando esto corre la factura ya está aceptada; un fallo acá no
// puede tumbar la emisión.
import { db } from "@/lib/db";
import { invoiceIssueInstant } from "@/lib/dian/attachedDocument";
import { unzipFirstXml } from "@/lib/dian/soap";
import {
  acceptedInvoiceClosureCutoff,
  coveredRequestsWhere,
} from "@/lib/dian/invoiceRequestCoverage";

/**
 * Pasa a `generated` las solicitudes pendientes de la orden creadas hasta
 * `cutoff`. Devuelve cuántas cerró. `cutoff` null ⇒ ninguna (la factura
 * salió a consumidor final, o no se pudo saber cuándo se emitió).
 */
export async function closeInvoiceRequestsOnAcceptance(args: {
  orderId: string | null | undefined;
  cutoff: Date | null;
  now?: Date;
}): Promise<number> {
  if (!args.orderId || !args.cutoff) return 0;
  try {
    const r = await db.invoiceRequest.updateMany({
      where: coveredRequestsWhere(args.orderId, args.cutoff),
      // Sin `generatedByEmail`: no la marcó una persona, la cerró la
      // aceptación de la DIAN.
      data: {
        status: "generated",
        generatedAt: args.now ?? new Date(),
        generatedByEmail: null,
      },
    });
    return r.count;
  } catch (err) {
    console.error("[dian-requests] no se pudieron cerrar las solicitudes de factura", {
      orderId: args.orderId,
      err,
    });
    return 0;
  }
}

/**
 * Riel de la consulta diferida: el corte es el instante de emisión que
 * declara el XML aceptado (IssueDate + IssueTime). Sin XML legible no se
 * cierra nada —mejor una solicitud pendiente de más que una cerrada que no
 * entró en la factura—.
 */
export async function closeInvoiceRequestsAfterDeferredAcceptance(doc: {
  orderId: string | null | undefined;
  xmlZip: Uint8Array | Buffer | null | undefined;
  now?: Date;
}): Promise<number> {
  try {
    const xml = doc.xmlZip ? await unzipFirstXml(doc.xmlZip) : null;
    const issued = xml ? invoiceIssueInstant(xml) : null;
    return await closeInvoiceRequestsOnAcceptance({
      orderId: doc.orderId,
      cutoff: acceptedInvoiceClosureCutoff({ rail: "status", issuedAt: issued?.at }),
      now: doc.now,
    });
  } catch (err) {
    console.error("[dian-requests] no se pudo leer la emisión para cerrar solicitudes", {
      orderId: doc.orderId,
      err,
    });
    return 0;
  }
}
