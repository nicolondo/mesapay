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
// la DIAN, y un rechazo deja la venta sin factura válida hasta que alguien
// lo corrija y la reenvíe (el número NO se pierde: la DIAN no valida ni
// registra un documento rechazado, y el reenvío sale con el mismo
// consecutivo). Bloquear antes es gratis. Un documento bloqueado vuelve a `to_send` con
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
  claimDianDocument,
  customerPartyFor,
  invoicePaymentMeans,
  orderToInvoiceLines,
} from "@/lib/dian/emit";
import { dianIssueDateTime, dianSigningTime } from "@/lib/dian/dianDateTime";
import {
  BLOCKED_RETRY_MS,
  emissionBackoffMs,
  RETRYABLE_STATES,
} from "@/lib/dian/retry";
import { afterInvoiceAccepted } from "@/lib/dian/invoiceAcceptance";
import { classifyInvoiceResponse, STATUS_CHECK_UNAVAILABLE } from "@/lib/dian/invoiceResponse";
import {
  findAcceptedInvoiceByCufe,
  persistAcceptedInvoice,
  resolveClaimedInvoice,
  type ClaimedInvoice,
} from "@/lib/dian/invoiceReconcile";
import {
  formatInvoiceNumber,
  frozenSalesTax,
  isIssuedBeforePayment,
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
  /**
   * `false`: NO encolar el papel al aceptarse. Lo usa la factura emitida
   * antes de cobrar (`preInvoice.ts`), que imprime ella misma para poder
   * decirle al staff por dónde salió (o caer al navegador). Default true.
   */
  printOnAccept?: boolean;
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
              id: true,
              nameSnapshot: true,
              qty: true,
              priceCentsSnapshot: true,
              cancelledAt: true,
              taxKind: true,
              taxPct: true,
            },
          },
          // La solicitud de factura más reciente de la orden, sin filtrar
          // por `status` — el mismo criterio que usa el envío del correo.
          // Es lo que decide si el adquiriente es el comensal o el
          // consumidor final. Su `createdAt` es además el corte del cierre
          // automático de solicitudes al aceptarse (ver abajo).
          invoiceRequests: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              createdAt: true,
              customerName: true,
              docType: true,
              docNumber: true,
              address: true,
              city: true,
              department: true,
              email: true,
            },
          },
          // Cobros aprobados de la cuenta: uno a crédito hace que la factura
          // salga con forma de pago "crédito" (vence a los días de plazo del
          // cliente; `billingCustomer` sólo existe en `customer_credit`), y
          // una cuenta pagada toda con Bre-B declara el medio "transferencia".
          payments: {
            where: { status: "approved" },
            select: { method: true, billingCustomer: { select: { creditTermsDays: true } } },
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
  // Fecha y hora FISCALES (Colombia) de este intento: IssueDate, IssueTime,
  // el CUFE, el vencimiento del crédito y el SigningTime salen de este
  // mismo `now`. Antes la fecha era el día UTC y de 7 p. m. a medianoche
  // la factura declaraba el día siguiente — ver dianDateTime.ts.
  const issued = dianIssueDateTime(now);
  const env: "1" | "2" = config.environment === "produccion" ? "1" : "2";

  // Impuesto real: para los platos del menú, la tarifa CONGELADA en la
  // tirilla al emitirla (no la del comercio hoy: el XML tiene que decir
  // lo mismo que el papel, y un reintento días después no puede cambiar
  // lo declarado); para cada línea libre, el suyo, sumado encima — ver
  // salesTax.ts. Snapshot viejo sin tarifa ⇒ sin impuesto embebido.
  // Factura emitida ANTES de cobrar: sólo los ítems que congeló. La cuenta
  // queda cerrada a cambios, así que es el mismo conjunto; esto es la red
  // para que una factura ya numerada (y quizá ya impresa) no cambie en
  // silencio si algo se colara.
  const frozenIds = snap.orderItemIds ? new Set(snap.orderItemIds) : null;
  const invoicedItems = frozenIds
    ? inv.order.items.filter((i) => frozenIds.has(i.id))
    : inv.order.items;
  if (frozenIds && invoicedItems.length !== frozenIds.size) {
    console.warn("[dian-emit] la cuenta ya no tiene todos los ítems facturados", {
      simpleInvoiceId: inv.id,
      invoiced: frozenIds.size,
      live: invoicedItems.length,
    });
  }
  const lines = orderToInvoiceLines(invoicedItems, frozenSalesTax(snap));
  if (lines.length === 0) return blocked("no_lines");

  const input: DianInvoiceInput = {
    environment: env,
    softwareId: config.softwareId,
    softwarePin: config.softwarePin,
    technicalKey: config.technicalKey,
    resolution,
    invoiceNumber,
    issueDate: issued.date,
    issueTime: issued.time,
    supplier: emisorToSupplierParty(emisor),
    // Nominativa si el comensal cargó sus datos; consumidor final si no.
    // El CUFE sale de este mismo objeto (NumAdq = companyId).
    customer: customerPartyFor(inv.order.invoiceRequests[0] ?? null),
    lines,
    // Emitida antes de cobrar ⇒ medio "1 – Instrumento no definido" (ver
    // `invoicePaymentMeans`); a crédito ⇒ crédito; toda con Bre-B ⇒
    // transferencia "47"; si no, efectivo "10".
    ...invoicePaymentMeans(inv.order.payments ?? [], issued.date, {
      issuedBeforePayment: isIssuedBeforePayment(snap),
    }),
  };

  const sendArgs = { environment: config.environment, cert: config.cert };
  const useTestSet = env === "2" && !!config.testSetId;
  const attempts = claim.attempts + 1;
  const claimed: ClaimedInvoice = {
    documentId: claim.id,
    restaurantId: opts.restaurantId,
    simpleInvoiceId: inv.id,
    orderId: inv.order.id,
    invoiceNumber,
    notFoundCount: 0,
  };

  // ¿La DIAN ya tiene el envío ANTERIOR? Un intento que terminó en timeout
  // pudo haber sido aceptado sin que nos enteráramos; mandar otro con el
  // mismo número (y fecha y CUFE nuevos) es exactamente lo que la DIAN
  // rechaza con la regla 90. Así que, si hubo un envío antes, primero se
  // pregunta por su CUFE (GetStatus). Aceptado ⇒ listo, sin reenviar. No lo
  // tiene (o lo tiene rechazado) ⇒ se reenvía con el MISMO número: un
  // documento rechazado la DIAN no lo valida ni lo registra (Anexo Técnico,
  // «Documento Rechazado … genera como consecuencia que la DIAN no valide
  // el documento electrónico»), así que el consecutivo sigue libre. Sin
  // respuesta ⇒ no se manda nada nuevo: se reintenta más tarde.
  if (claim.previousCufe && !useTestSet) {
    const prior = await findAcceptedInvoiceByCufe({
      candidates: [claim.previousCufe],
      invoiceNumber,
      args: sendArgs,
    });
    if (prior.kind === "accepted") {
      const stored = await db.dianDocument.findUnique({
        where: { id: claim.id },
        select: { xmlZip: true },
      });
      const r = await persistAcceptedInvoice({
        doc: claimed,
        lookup: prior,
        knownZips: stored?.xmlZip ? [{ zip: stored.xmlZip, persisted: true }] : [],
        config,
        now,
        print: opts.printOnAccept !== false,
      });
      return {
        outcome: "accepted",
        documentId: claim.id,
        cufe: r.cufe,
        qrUrl: r.qrUrl,
        errors: [],
        statusMessage: null,
      };
    }
    if (prior.kind === "channel_error") {
      await db.dianDocument.update({
        where: { id: claim.id },
        data: {
          state: "error",
          errors: [STATUS_CHECK_UNAVAILABLE],
          lastError: STATUS_CHECK_UNAVAILABLE,
          attempts: { increment: 1 },
          nextAttemptAt: new Date(now.getTime() + emissionBackoffMs(attempts)),
        },
      });
      return {
        outcome: "error",
        documentId: claim.id,
        cufe: claim.previousCufe,
        qrUrl: null,
        errors: [STATUS_CHECK_UNAVAILABLE],
        statusMessage: null,
      };
    }
  }

  // De acá en adelante se firma y se envía. Cualquier excepción (firma,
  // zip, red fuera del parser SOAP) deja el documento en `error` con
  // backoff, igual que un error de canal: reclamado para siempre no.
  let built: ReturnType<typeof buildDianInvoiceXml>;
  let zip: Buffer;
  let result: Awaited<ReturnType<typeof sendBillSync>>;
  try {
    built = buildDianInvoiceXml(input);
    // La firma declara el MISMO instante que el IssueDate: si el envío
    // cruzara la medianoche, firma y factura no pueden quedar en días
    // distintos.
    const signed = signXmlDian(built.xml, config.cert, {
      signingTime: dianSigningTime(now),
    });
    zip = await zipInvoice(`${invoiceNumber}.xml`, signed);

    // Habilitación usa test set; producción usa SendBillSync síncrono.
    result = useTestSet
      ? await sendTestSetAsync(zip, config.testSetId!, {
          environment: "habilitacion",
          cert: config.cert,
        })
      : await sendBillSync(zip, sendArgs);
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

  // Qué quiso decir la DIAN (invoiceResponse.ts): sólo un RECHAZO real deja
  // la factura rechazada. Las notificaciones nunca; la regla 90 tampoco.
  const verdict = classifyInvoiceResponse(result);

  // Regla 90: la DIAN YA tiene una factura con este número. Se le pregunta
  // por CUFE —el que devolvió, el de este XML y el del envío anterior— y,
  // si alguno está aceptado para este número, queda aceptada. Si no, queda
  // `pending` sin confirmar: el barrido y «Consultar en la DIAN» la cierran.
  if (verdict.kind === "duplicate") {
    const r = await resolveClaimedInvoice({
      doc: claimed,
      candidates: [result.cufe, built.cufe, claim.previousCufe],
      knownZips: [{ zip, persisted: false }],
      config,
      now,
      print: opts.printOnAccept !== false,
      extra: { attempts: { increment: 1 }, trackId: null },
      extraIfUnverified: {
        errors: result.errors,
        responseXml: result.raw ?? null,
        xmlZip: new Uint8Array(zip),
      },
    });
    return r.outcome === "accepted"
      ? {
          outcome: "accepted",
          documentId: claim.id,
          cufe: r.cufe,
          qrUrl: r.qrUrl,
          errors: [],
          statusMessage: result.statusMessage ?? null,
        }
      : {
          outcome: "pending",
          documentId: claim.id,
          cufe: r.cufe,
          qrUrl: null,
          errors: result.errors,
          statusMessage: result.statusMessage ?? null,
        };
  }

  const t = transitionAfterSend(result, built.cufe);
  // Sin un rechazo real (sólo notificaciones, o la plantilla de la DIAN sin
  // armar, «{StatusRut}»): no es un rechazo, es un error que se reintenta
  // solo, con backoff y con el tope de intentos de siempre.
  const state: "accepted" | "pending" | "rejected" | "error" =
    verdict.kind === "transient" ? "error" : result.state;

  await db.dianDocument.update({
    where: { id: claim.id },
    data: {
      state,
      cufe: t.cufe ?? built.cufe,
      trackId: t.trackId ?? null,
      // Aceptada ⇒ se limpian los motivos de un rechazo anterior.
      errors: t.errors.length ? t.errors : state === "accepted" ? [] : undefined,
      warnings: verdict.warnings.length ? verdict.warnings : undefined,
      // La respuesta cruda se guarda siempre: sin ella no hay forma de
      // saber por qué la DIAN rechazó (ver InvalidSecurity de 2026-09).
      responseXml: result.raw ?? null,
      xmlZip: new Uint8Array(zip),
      attempts: { increment: 1 },
      // Error de canal o respuesta transitoria ⇒ el barrido lo reintenta
      // con backoff. Rechazo ⇒ queda el motivo pero SIN reintento
      // automático (mismo XML, mismo rechazo): se corrige y se reintenta a
      // mano. Aceptada/pendiente ⇒ nada que reintentar.
      lastError: state === "error" || state === "rejected" ? (t.errors[0] ?? null) : null,
      nextAttemptAt:
        state === "error"
          ? new Date(now.getTime() + emissionBackoffMs(attempts))
          : null,
    },
  });

  // Aceptada ⇒ al adquiriente le tiene que llegar su factura electrónica
  // (el AttachedDocument), se cierran las solicitudes de la cuenta y sale
  // al PAPEL (con facturación electrónica la tirilla NO sale al cobrar: lo
  // que se imprime es esta factura, con su CUFE y su QR). Todo
  // idempotente y sin lanzar — ver invoiceAcceptance.ts. Se AWAITEA en vez
  // de dispararlo al aire porque un fire-and-forget en un route handler se
  // muere cuando la respuesta sale. Rechazada o pendiente ⇒ nada.
  if (state === "accepted") {
    await afterInvoiceAccepted({
      documentId: claim.id,
      simpleInvoiceId: inv.id,
      restaurantId: opts.restaurantId,
      orderId: inv.order.id,
      cufe: t.cufe ?? built.cufe,
      environment: config.environment,
      closure: {
        rail: "emit",
        usedRequestCreatedAt: inv.order.invoiceRequests[0]?.createdAt,
        now,
      },
      print: opts.printOnAccept !== false,
    });
  }

  return {
    outcome: state,
    documentId: claim.id,
    cufe: t.cufe ?? null,
    qrUrl: t.fiscal ? built.qrUrl : null,
    errors: t.errors,
    statusMessage: result.statusMessage ?? null,
  };
}
