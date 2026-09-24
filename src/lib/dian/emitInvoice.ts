// Emisión a la DIAN de la factura electrónica de una factura simple.
//
// Vivía entera dentro del route handler `POST /api/operator/dian/emit/
// [simpleInvoiceId]`, o sea que sólo se podía emitir con un operador
// logueado apretando un botón. Como función de librería la llaman tres
// rieles: esa ruta ("Emitir" / "Reintentar"), el intento inmediato al
// cobrar (`issueInvoiceOnPaid`) y el barrido (`sweepDianEmissions`). El
// cerrojo entre los tres es el reclamo del documento (`claimDianDocument`):
// pasa a `sent` con un updateMany condicionado por estado, y sólo el que
// lo logra firma y envía.
//
// Los guards de configuración (resolución, ubicación DANE, correo del
// emisor, certificado, número dentro del rango) corren ANTES de firmar y
// enviar, a propósito: cada uno de esos faltantes es un rechazo seguro de
// la DIAN, y cada rechazo quema un consecutivo del rango autorizado.
// Bloquear antes es gratis. Un documento bloqueado vuelve a `to_send` con
// el motivo en `lastError` —sin contar intento, sin consumir nada— y el
// barrido lo retoma cuando el operador completa la configuración.
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
  creditPaymentMeans,
  customerPartyFor,
  orderToInvoiceLines,
} from "@/lib/dian/emit";
import {
  BLOCKED_RETRY_MS,
  emissionBackoffMs,
  RETRYABLE_STATES,
} from "@/lib/dian/retry";
import { sendDianInvoiceEmail } from "@/lib/dian/sendInvoiceEmail";
import { dianQrUrl } from "@/lib/dian/crypto";
import { printAcceptedDianInvoice } from "@/lib/print/invoiceQueue";
import {
  formatInvoiceNumber,
  frozenSalesTax,
  type InvoiceSnapshot,
} from "@/lib/invoice";

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
  /** El consecutivo de la tirilla no cae dentro del rango de la resolución. */
  | "number_out_of_range"
  | "no_lines";

/**
 * Motivos que pueden dejar una orden pagada SIN factura: los del emit más
 * `numbering_exhausted` (el rango se agotó antes de numerar la tirilla —
 * ver `issueInvoiceOnPaid`). Es lo que la pantalla traduce.
 */
export type PendingBlockReason = EmitBlockReason | "numbering_exhausted";

/**
 * ¿El motivo frena a TODO el comercio (configuración) o sólo a este
 * documento? El barrido usa la distinción para no re-evaluar cien veces
 * la misma config rota, y la pantalla para el aviso rojo.
 */
export function isRestaurantWideReason(reason: string): boolean {
  return reason !== "no_lines" && reason !== "number_out_of_range";
}

export type EmitDianInvoiceResult =
  /** No existe la factura simple, o es de otro comercio. */
  | { outcome: "not_found" }
  /** Ya aceptada, pendiente en la DIAN o reclamada por otro: no se re-emite. */
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

/** Datos que deja un bloqueo: vuelve a la cola con el motivo y una espera. */
function blockedData(reason: EmitBlockReason, now: Date) {
  return {
    state: "to_send",
    errors: [reason],
    lastError: reason,
    nextAttemptAt: new Date(now.getTime() + BLOCKED_RETRY_MS),
  };
}

/**
 * Marca un documento como frenado por configuración SIN haberlo reclamado
 * (el barrido, cuando ya sabe que la config del comercio está rota por
 * otro documento del mismo lote). Sólo toca estados reintentables: si
 * alguien lo reclamó entre medio, es suyo.
 */
export async function markDocumentBlocked(
  documentId: string,
  reason: EmitBlockReason,
  now: Date = new Date(),
): Promise<void> {
  await db.dianDocument.updateMany({
    where: { id: documentId, state: { in: [...RETRYABLE_STATES] } },
    data: blockedData(reason, now),
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
  now?: Date;
}): Promise<EmitDianInvoiceResult> {
  const inv = await db.simpleInvoice.findUnique({
    where: { id: opts.simpleInvoiceId },
    select: {
      id: true,
      restaurantId: true,
      invoiceNumber: true,
      snapshot: true,
      // La tarifa del impuesto NO se lee del comercio: va congelada en el
      // snapshot (`frozenSalesTax`). Ver abajo.
      order: {
        select: {
          id: true,
          // Mismos ítems VIVOS que la tirilla (`issueSimpleInvoice`): sin
          // cancelar Y sin ronda cancelada. Cancelar una ronda no marca
          // `cancelledAt` en sus platos, así que filtrar sólo por eso
          // metía al XML platos que el subtotal y el papel ya no cobran —
          // y la DIAN aceptaba un total distinto del pagado.
          items: {
            where: {
              cancelledAt: null,
              OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }],
            },
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
          // Cobro a crédito de la cuenta: la factura sale con forma de
          // pago "crédito" y vence a los días de plazo del cliente.
          payments: {
            where: { method: "customer_credit", status: "approved" },
            take: 1,
            select: { billingCustomer: { select: { creditTermsDays: true } } },
          },
        },
      },
    },
  });
  if (!inv || inv.restaurantId !== opts.restaurantId) {
    return { outcome: "not_found" };
  }

  const now = opts.now ?? new Date();
  const claim = await claimDianDocument(inv.id, opts.restaurantId, {
    orderId: inv.order.id,
    now,
  });
  if (!claim) return { outcome: "already_emitted" };

  const blocked = async (
    reason: EmitBlockReason,
    missing: string[] = [],
  ): Promise<EmitDianInvoiceResult> => {
    await db.dianDocument.update({
      where: { id: claim.id },
      data: blockedData(reason, now),
    });
    return { outcome: "blocked", reason, missing };
  };

  const emisor = await resolveEmisor(opts.restaurantId);
  let config;
  try {
    config = await loadDianConfig(opts.restaurantId);
  } catch (err) {
    if (err instanceof DianConfigError) return blocked(err.code);
    // Un fallo inesperado no puede dejar el documento reclamado para
    // siempre: se libera y se reintenta más tarde.
    await db.dianDocument.update({
      where: { id: claim.id },
      data: blockedData("no_config", now),
    });
    throw err;
  }
  if (!emisor) return blocked("no_emisor");
  // Sin la resolución completa NO se envía: la DIAN rechazaría el
  // documento y el consecutivo quedaría quemado (FAB05b…FAD05c).
  const resolution = emisorResolution(emisor);
  if (!resolution) {
    return blocked("resolution_incomplete", missingResolutionFields(emisor));
  }
  // El número de la tirilla tiene que caer dentro del rango autorizado.
  // Fuera de él la DIAN rechaza (FAB05b) y, peor, un número por encima
  // del tope es una factura que nunca va a poder existir: hace falta una
  // resolución nueva. `issueInvoiceOnPaid` lo frena antes de numerar; esto
  // es la red para tirillas ya numeradas o un `invoiceNextNumber` que
  // alguien ajustó a mano.
  if (inv.invoiceNumber < resolution.from || inv.invoiceNumber > resolution.to) {
    return blocked("number_out_of_range");
  }
  // Ubicación DANE del establecimiento: mismo criterio que la resolución.
  // Mandar Bogotá fija hacía que la DIAN resolviera mal el punto de
  // facturación (FAB10a / FAJ50) y quemaba el consecutivo en el rechazo.
  const missingLocation = missingLocationFields(emisor);
  if (missingLocation.length > 0) {
    return blocked("location_incomplete", missingLocation);
  }
  // Correo de recepción de documentos electrónicos: mismo criterio.
  // Sin él el emisor viaja sin cac:Contact y la DIAN rechaza con FAJ71
  // — con el consecutivo ya quemado.
  const missingContact = missingContactFields(emisor);
  if (missingContact.length > 0) {
    return blocked("contact_email_incomplete", missingContact);
  }
  const snap = inv.snapshot as unknown as InvoiceSnapshot;
  const invoiceNumber = formatInvoiceNumber(snap, inv.invoiceNumber);
  const issueDate = now.toISOString().slice(0, 10);
  const env: "1" | "2" = config.environment === "produccion" ? "1" : "2";

  // Impuesto real: para los platos del menú, la tarifa CONGELADA en la
  // tirilla al emitirla (no la del comercio hoy: el XML tiene que decir
  // lo mismo que el papel, y un reintento días después no puede cambiar
  // lo declarado); para cada línea libre, el suyo, sumado encima — ver
  // salesTax.ts. Snapshot viejo sin tarifa ⇒ sin impuesto embebido.
  const lines = orderToInvoiceLines(inv.order.items, frozenSalesTax(snap));
  if (lines.length === 0) return blocked("no_lines");

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
    ...creditPaymentMeans(inv.order.payments ?? [], issueDate),
  };

  // De acá en adelante se firma y se envía. Cualquier excepción (firma,
  // zip, red fuera del parser SOAP) deja el documento en `error` con
  // backoff, igual que un error de canal: reclamado para siempre no.
  const attempts = claim.attempts + 1;
  let built: ReturnType<typeof buildDianInvoiceXml>;
  let zip: Buffer;
  let result: Awaited<ReturnType<typeof sendBillSync>>;
  try {
    built = buildDianInvoiceXml(input);
    const signed = signXmlDian(built.xml, config.cert);
    zip = await zipInvoice(`${invoiceNumber}.xml`, signed);

    // Habilitación usa test set; producción usa SendBillSync síncrono.
    result =
      env === "2" && config.testSetId
        ? await sendTestSetAsync(zip, config.testSetId, {
            environment: "habilitacion",
            cert: config.cert,
          })
        : await sendBillSync(zip, {
            environment: config.environment,
            cert: config.cert,
          });
  } catch (err) {
    const message = String((err as Error)?.message ?? err).slice(0, 500);
    console.error("[dian-emit] la emisión reventó antes de tener respuesta", {
      simpleInvoiceId: inv.id,
      err,
    });
    await db.dianDocument.update({
      where: { id: claim.id },
      data: {
        state: "error",
        errors: [message],
        lastError: message,
        attempts: { increment: 1 },
        nextAttemptAt: new Date(now.getTime() + emissionBackoffMs(attempts)),
      },
    });
    return {
      outcome: "error",
      documentId: claim.id,
      cufe: null,
      qrUrl: null,
      errors: [message],
      statusMessage: null,
    };
  }
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
      // Error de canal ⇒ el barrido lo reintenta con backoff. Rechazo ⇒
      // queda el motivo pero SIN reintento automático (mismo XML, mismo
      // rechazo, otro consecutivo quemado): se corrige y se reintenta a
      // mano. Aceptada/pendiente ⇒ nada que reintentar.
      lastError: t.state === "error" || t.state === "rejected" ? (t.errors[0] ?? null) : null,
      nextAttemptAt:
        t.state === "error"
          ? new Date(now.getTime() + emissionBackoffMs(attempts))
          : null,
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
    // Y al PAPEL. Con facturación electrónica la tirilla NO sale al
    // cobrar: lo que se imprime es esta factura —con su CUFE y su QR— y
    // sale acá, que es por donde pasan el intento inmediato del cobro y
    // el barrido (la consulta diferida tiene su gemelo en
    // dian/documents/[id]/status). Mismo contrato que el correo: no
    // lanza y es idempotente (dedupeKey `invoice:<id>`), así que si los
    // dos rieles ven la aceptación sale UNA hoja. Rechazada o pendiente
    // ⇒ nada de papel. Ver print/invoiceQueue.ts.
    const cufe = t.cufe ?? built.cufe;
    await printAcceptedDianInvoice({
      simpleInvoiceId: inv.id,
      restaurantId: opts.restaurantId,
      cufe,
      qrUrl: dianQrUrl(cufe, env),
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
