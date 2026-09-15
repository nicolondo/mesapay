// Emisión a la DIAN de la factura electrónica de una factura simple.
//
// Vivía entera dentro del route handler `POST /api/operator/dian/emit/
// [simpleInvoiceId]`, o sea que sólo se podía emitir con un operador
// logueado apretando un botón. Sacarla a una función de librería es lo
// que permite emitir desde un barrido (cron) o desde el riel del cobro,
// sin request ni sesión. La ruta la sigue llamando y traduce el resultado
// a HTTP; el comportamiento (guards, códigos, transiciones) es el mismo.
//
// Los guards de configuración (resolución, ubicación DANE, correo del
// emisor) corren ANTES de firmar y enviar, a propósito: cada uno de esos
// faltantes es un rechazo seguro de la DIAN, y cada rechazo quema un
// consecutivo del rango autorizado. Bloquear antes es gratis.
import { db } from "@/lib/db";
import {
  DianConfigError,
  emisorResolution,
  emisorToSupplierParty,
  loadDianConfig,
  missingContactFields,
  missingLocationFields,
  missingResolutionFields,
  resolveEmisor,
} from "@/lib/dian/config";
import { buildDianInvoiceXml, type DianInvoiceInput } from "@/lib/dian/ubl";
import { signXmlDian } from "@/lib/dian/xades";
import { sendBillSync, sendTestSetAsync, zipInvoice } from "@/lib/dian/soap";
import { transitionAfterSend } from "@/lib/dian/documentState";
import {
  bogotaIssueTime,
  claimDianDocument,
  customerPartyFor,
  orderToInvoiceLines,
} from "@/lib/dian/emit";
import { sendDianInvoiceEmail } from "@/lib/dian/sendInvoiceEmail";
import { formatInvoiceNumber, type InvoiceSnapshot } from "@/lib/invoice";

/**
 * Por qué NO se envió. Los cinco primeros son `DianConfigError.code`
 * (falta config/certificado/credenciales/clave maestra o no se pudo
 * descifrar); el resto son los guards del emisor y de la orden.
 */
export type EmitBlockReason =
  | DianConfigError["code"]
  | "no_emisor"
  | "resolution_incomplete"
  | "location_incomplete"
  | "contact_email_incomplete"
  | "no_lines";

export type EmitDianInvoiceResult =
  /** No existe la factura simple, o es de otro comercio. */
  | { outcome: "not_found" }
  /** Ya aceptada o en vuelo: no se re-emite. */
  | { outcome: "already_emitted" }
  /**
   * Un guard la frenó ANTES de enviar. No se consumió nada en la DIAN.
   * `missing` lista los campos que faltan cuando el motivo es de datos.
   */
  | { outcome: "blocked"; reason: EmitBlockReason; missing: string[] }
  /** Se envió: lo que dijo la DIAN (o el canal). */
  | {
      outcome: "accepted" | "pending" | "rejected" | "error";
      documentId: string;
      cufe: string | null;
      /** Sólo cuando quedó fiscalmente válida (aceptada). */
      qrUrl: string | null;
      errors: string[];
      statusMessage: string | null;
    };

/** Marca el documento como frenado por un guard, con el motivo legible. */
async function markBlocked(documentId: string, reason: EmitBlockReason): Promise<void> {
  await db.dianDocument.update({
    where: { id: documentId },
    data: { state: "error", errors: [reason] },
  });
}

/**
 * Emite a la DIAN la factura electrónica de una factura simple ya
 * generada. Idempotente (`claimDianDocument`): sólo (re)envía lo
 * reintentable. La venta NUNCA se bloquea — un rechazo/caída deja el
 * documento con estado y errores para reintentar.
 *
 * `restaurantId` es el del caller (sesión del operador o fila del
 * documento en el barrido): una factura de otro comercio es `not_found`.
 */
export async function emitDianInvoice(opts: {
  simpleInvoiceId: string;
  restaurantId: string;
}): Promise<EmitDianInvoiceResult> {
  const inv = await db.simpleInvoice.findUnique({
    where: { id: opts.simpleInvoiceId },
    select: {
      id: true,
      restaurantId: true,
      invoiceNumber: true,
      snapshot: true,
      restaurant: { select: { salesTaxKind: true, salesTaxPct: true } },
      order: {
        select: {
          items: {
            select: {
              nameSnapshot: true,
              qty: true,
              priceCentsSnapshot: true,
              cancelledAt: true,
              taxKind: true,
              taxPct: true,
            },
          },
          // La solicitud de factura más reciente de la orden, sin filtrar
          // por `status` (cuando esto corre ya pasó a `generated`) — el
          // mismo criterio que usa el envío del correo. Es lo que decide
          // si el adquiriente es el comensal o el consumidor final.
          invoiceRequests: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              customerName: true,
              docType: true,
              docNumber: true,
              address: true,
              city: true,
              department: true,
              email: true,
            },
          },
        },
      },
    },
  });
  if (!inv || inv.restaurantId !== opts.restaurantId) {
    return { outcome: "not_found" };
  }

  const claim = await claimDianDocument(inv.id, opts.restaurantId);
  if (!claim) return { outcome: "already_emitted" };

  const emisor = await resolveEmisor(opts.restaurantId);
  let config;
  try {
    config = await loadDianConfig(opts.restaurantId);
  } catch (err) {
    if (err instanceof DianConfigError) {
      await markBlocked(claim.id, err.code);
      return { outcome: "blocked", reason: err.code, missing: [] };
    }
    throw err;
  }
  if (!emisor) {
    return { outcome: "blocked", reason: "no_emisor", missing: [] };
  }
  // Sin la resolución completa NO se envía: la DIAN rechazaría el
  // documento y el consecutivo quedaría quemado (FAB05b…FAD05c).
  const resolution = emisorResolution(emisor);
  if (!resolution) {
    await markBlocked(claim.id, "resolution_incomplete");
    return {
      outcome: "blocked",
      reason: "resolution_incomplete",
      missing: missingResolutionFields(emisor),
    };
  }
  // Ubicación DANE del establecimiento: mismo criterio que la resolución.
  // Mandar Bogotá fija hacía que la DIAN resolviera mal el punto de
  // facturación (FAB10a / FAJ50) y quemaba el consecutivo en el rechazo.
  const missingLocation = missingLocationFields(emisor);
  if (missingLocation.length > 0) {
    await markBlocked(claim.id, "location_incomplete");
    return { outcome: "blocked", reason: "location_incomplete", missing: missingLocation };
  }
  // Correo de recepción de documentos electrónicos: mismo criterio.
  // Sin él el emisor viaja sin cac:Contact y la DIAN rechaza con FAJ71
  // — con el consecutivo ya quemado.
  const missingContact = missingContactFields(emisor);
  if (missingContact.length > 0) {
    await markBlocked(claim.id, "contact_email_incomplete");
    return { outcome: "blocked", reason: "contact_email_incomplete", missing: missingContact };
  }
  const snap = inv.snapshot as unknown as InvoiceSnapshot;
  const invoiceNumber = formatInvoiceNumber(snap, inv.invoiceNumber);
  const now = new Date();
  const issueDate = now.toISOString().slice(0, 10);
  const env: "1" | "2" = config.environment === "produccion" ? "1" : "2";

  // Impuesto real: el del comercio para los platos (embebido) y el
  // propio de cada línea libre (sumado encima) — ver salesTax.ts.
  const lines = orderToInvoiceLines(inv.order.items, {
    kind: inv.restaurant.salesTaxKind as "none" | "inc" | "iva",
    pct: inv.restaurant.salesTaxPct,
  });
  if (lines.length === 0) {
    await markBlocked(claim.id, "no_lines");
    return { outcome: "blocked", reason: "no_lines", missing: [] };
  }

  const input: DianInvoiceInput = {
    environment: env,
    softwareId: config.softwareId,
    softwarePin: config.softwarePin,
    technicalKey: config.technicalKey,
    resolution,
    invoiceNumber,
    issueDate,
    issueTime: bogotaIssueTime(now),
    supplier: emisorToSupplierParty(emisor),
    // Nominativa si el comensal cargó sus datos; consumidor final si no.
    // El CUFE sale de este mismo objeto (NumAdq = companyId).
    customer: customerPartyFor(inv.order.invoiceRequests[0] ?? null),
    lines,
    paymentMeansCode: "10",
  };

  const built = buildDianInvoiceXml(input);
  const signed = signXmlDian(built.xml, config.cert);
  const zip = await zipInvoice(`${invoiceNumber}.xml`, signed);

  // Habilitación usa test set; producción usa SendBillSync síncrono.
  const result =
    env === "2" && config.testSetId
      ? await sendTestSetAsync(zip, config.testSetId, {
          environment: "habilitacion",
          cert: config.cert,
        })
      : await sendBillSync(zip, {
          environment: config.environment,
          cert: config.cert,
        });
  const t = transitionAfterSend(result, built.cufe);

  await db.dianDocument.update({
    where: { id: claim.id },
    data: {
      state: t.state,
      cufe: t.cufe ?? built.cufe,
      trackId: t.trackId ?? null,
      errors: t.errors.length ? t.errors : undefined,
      // La respuesta cruda se guarda siempre: sin ella no hay forma de
      // saber por qué la DIAN rechazó (ver InvalidSecurity de 2026-09).
      responseXml: result.raw ?? null,
      xmlZip: new Uint8Array(zip),
      attempts: { increment: 1 },
    },
  });

  // Aceptada ⇒ al adquiriente le tiene que llegar su factura electrónica
  // (el AttachedDocument). Se AWAITEA en vez de dispararlo al aire porque
  // un fire-and-forget en un route handler se muere cuando la respuesta
  // sale; `sendDianInvoiceEmail` no lanza y es idempotente, así que no
  // puede tumbar la emisión ni duplicar el correo si además lo manda el
  // riel de la consulta diferida.
  if (t.state === "accepted") {
    await sendDianInvoiceEmail({
      documentId: claim.id,
      environment: config.environment,
    });
  }

  return {
    // `transitionAfterSend` mapea 1:1 el estado del canal (que ya es uno
    // de estos cuatro) — se toma de ahí para no castear.
    outcome: result.state,
    documentId: claim.id,
    cufe: t.cufe ?? null,
    qrUrl: t.fiscal ? built.qrUrl : null,
    errors: t.errors,
    statusMessage: result.statusMessage ?? null,
  };
}
