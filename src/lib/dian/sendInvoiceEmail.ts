// Envío de la factura electrónica al adquiriente.
//
// AUTOMÁTICO: se dispara desde los DOS caminos por los que puede llegar la
// aceptación de la DIAN: la respuesta síncrona de `SendBillSync` (emit) y
// la consulta diferida de `GetStatusZip` (status). La DIAN valida
// asíncrono, así que cualquiera de los dos puede ser el primero en
// enterarse — y por eso el envío es idempotente por `DianDocument.emailedAt`.
//
// MANUAL (`force: true`): el reenvío desde el panel. Ahí la idempotencia
// sobra —es justamente lo que hay que saltarse— y el operador es el que
// decide cuándo vuelve a salir el correo.
//
// Contrato, igual que `invoiceOnPaid.ts`: NUNCA lanza. Cuando esto corre la
// factura YA está aceptada por la DIAN; un fallo de correo no puede tumbar
// la emisión ni dejar en rojo la respuesta del endpoint. Se traga y se
// loguea.
import { db } from "@/lib/db";
import { sendEmail, type EmailAttachment } from "@/lib/mailer";
import { brandedInvoiceFrom, invoiceUrlFor } from "@/lib/simpleInvoice";
import { formatInvoiceNumber, type InvoiceSnapshot } from "@/lib/invoice";
import { dianQrUrl } from "@/lib/dian/crypto";
import {
  attachedDocumentFileName,
  buildAttachedDocumentXml,
  invoiceIssueInstant,
} from "@/lib/dian/attachedDocument";
import { renderDianInvoiceEmail, resolveDianRecipient } from "@/lib/dian/invoiceEmail";
import {
  bogotaIssueTime,
  customerPartyFor,
  type InvoiceRequestParty,
} from "@/lib/dian/emit";
import { emisorToSupplierParty, resolveEmisor } from "@/lib/dian/config";
import {
  extractApplicationResponse,
  unzipFirstXml,
  zipInvoice,
} from "@/lib/dian/soap";

/** Por qué NO salió el correo. Se devuelve y se escribe en `emailError`. */
export type DianEmailFailure =
  /** No existe el documento. */
  | "not_found"
  /** La DIAN todavía no lo aceptó: no hay documento fiscal que mandar. */
  | "not_accepted"
  /** Ya se mandó y no se pidió `force`. El camino automático sale por acá. */
  | "already_emailed"
  /** Aceptado pero sin tirilla enlazada o sin CUFE: no se puede armar nada. */
  | "incomplete_document"
  /** Nadie pidió factura en esa cuenta — no hay a quién mandarle. */
  | "no_recipient"
  /** El correo se intentó y el proveedor lo rechazó. */
  | "send_failed";

export type DianEmailOutcome =
  | {
      ok: true;
      /** A qué correo salió. */
      to: string;
      /** Momento del envío, ISO — lo que quedó en `emailedAt`. */
      emailedAt: string;
      /** false ⇒ salió sin el AttachedDocument (ver `buildAttachment`). */
      attachment: boolean;
    }
  | { ok: false; reason: DianEmailFailure };

/**
 * Manda la factura electrónica (AttachedDocument) al adquiriente.
 *
 * Idempotente por defecto: el envío se RECLAMA con un `updateMany` acotado
 * a `emailedAt: null`, así que si los dos rieles de la aceptación corren a
 * la vez sólo uno manda. Si el envío falla se libera la marca para poder
 * reintentar.
 *
 * Con `force` —el reenvío manual— el reclamo deja de filtrar por
 * `emailedAt: null` y el documento vuelve a salir aunque ya se haya
 * mandado. Es el ÚNICO efecto de la opción: el resto de los guardarraíles
 * (aceptado, con CUFE, con destinatario) siguen igual, y el camino
 * automático, que nunca la pasa, conserva su idempotencia intacta.
 */
export async function sendDianInvoiceEmail(opts: {
  documentId: string;
  /** Ambiente del emisor — decide contra qué catálogo DIAN se valida. */
  environment: "habilitacion" | "produccion";
  /** Reenvío manual: manda aunque `emailedAt` ya tenga valor. */
  force?: boolean;
}): Promise<DianEmailOutcome> {
  // Lo que había ANTES de reclamar. Si el envío falla se restaura tal cual:
  // en el camino automático siempre es null (idéntico a como estaba), y en
  // un reenvío fallido no se borra la constancia del envío anterior.
  let previousEmailedAt: Date | null = null;
  // La marca que escribimos nosotros, para poder revertir SOLO la nuestra.
  let claimedAt: Date | null = null;
  try {
    const doc = await db.dianDocument.findUnique({
      where: { id: opts.documentId },
      select: {
        id: true,
        restaurantId: true,
        state: true,
        cufe: true,
        xmlZip: true,
        responseXml: true,
        emailedAt: true,
        simpleInvoice: {
          select: {
            id: true,
            email: true,
            invoiceNumber: true,
            snapshot: true,
            totalCents: true,
            order: {
              select: {
                id: true,
                locale: true,
                simpleInvoiceEmail: true,
                paidAt: true,
              },
            },
          },
        },
      },
    });
    // Guardarraíles: sólo sale lo ACEPTADO y —salvo reenvío— sólo una vez.
    // El estado se vuelve a mirar acá (no sólo en el caller) justamente
    // porque son varios los rieles que llaman.
    if (!doc) return { ok: false, reason: "not_found" };
    if (doc.state !== "accepted") return { ok: false, reason: "not_accepted" };
    if (doc.emailedAt && !opts.force) {
      return { ok: false, reason: "already_emailed" };
    }
    if (!doc.simpleInvoice || !doc.cufe) {
      return { ok: false, reason: "incomplete_document" };
    }
    previousEmailedAt = doc.emailedAt;
    const inv = doc.simpleInvoice;

    // La personalizada manda sobre la genérica (mismo criterio que
    // `invoiceOnPaid.ts`). No se filtra por `status`: cuando esto corre la
    // solicitud ya pasó a `generated`. Es la MISMA solicitud (la más
    // reciente de la orden) con la que el emit decidió el adquiriente de
    // la factura, y por eso también nombra al receptor del sobre.
    const request = await db.invoiceRequest.findFirst({
      where: { orderId: inv.order.id },
      orderBy: { createdAt: "desc" },
      select: {
        customerName: true,
        docType: true,
        docNumber: true,
        address: true,
        city: true,
        department: true,
        email: true,
      },
    });
    const to = resolveDianRecipient({
      invoiceRequestEmail: request?.email,
      simpleInvoiceEmail: inv.email,
      orderSimpleInvoiceEmail: inv.order.simpleInvoiceEmail,
    });
    if (!to) {
      // Nadie pidió factura en esa cuenta: no hay a quién mandarle. Queda
      // escrito el motivo para que no parezca que el correo se perdió.
      await db.dianDocument.update({
        where: { id: doc.id },
        data: { emailError: "no_recipient" },
      });
      console.log("[dian-email] sin destinatario", { documentId: doc.id });
      return { ok: false, reason: "no_recipient" };
    }

    // Reclamo del envío ANTES de mandar: el que pierde la carrera sale acá.
    // El reenvío manual NO filtra por `emailedAt: null` — ahí no hay
    // carrera que ganar, hay un operador pidiendo que vuelva a salir.
    const at = new Date();
    const claimed = await db.dianDocument.updateMany({
      where: { id: doc.id, ...(opts.force ? {} : { emailedAt: null }) },
      data: { emailedAt: at, emailError: null },
    });
    if (claimed.count === 0) return { ok: false, reason: "already_emailed" };
    claimedAt = at;

    const snap = inv.snapshot as unknown as InvoiceSnapshot;
    const invoiceNumber = formatInvoiceNumber(snap, inv.invoiceNumber);
    const envCode: "1" | "2" = opts.environment === "produccion" ? "1" : "2";

    // La fecha que vale es la que DECLARA la factura, no la del cobro: se
    // lee del XML firmado (ver `invoiceIssueInstant`). Sólo si no se puede
    // recuperar el XML se cae a la del cobro, que es la mejor aproximación
    // que queda.
    const invoiceXml = doc.xmlZip ? await unzipFirstXml(doc.xmlZip) : null;
    const issued = invoiceXml ? invoiceIssueInstant(invoiceXml) : null;
    const issuedAt = issued?.at ?? inv.order.paidAt ?? new Date(snap.paidAtIso);

    const attachment = await buildAttachment({
      restaurantId: doc.restaurantId,
      environment: envCode,
      invoiceNumber,
      issueDate: issued?.date ?? issuedAt.toISOString().slice(0, 10),
      issueTime: issued?.time ?? bogotaIssueTime(issuedAt),
      cufe: doc.cufe,
      invoiceXml,
      responseXml: doc.responseXml,
      request,
    });

    const { subject, html, text } = await renderDianInvoiceEmail({
      brandName: snap.restaurantName,
      invoiceNumber,
      issuedAt,
      cufe: doc.cufe,
      totalCents: inv.totalCents,
      invoiceUrl: invoiceUrlFor(inv.id),
      verifyUrl: dianQrUrl(doc.cufe, envCode),
      attachmentName: attachment?.filename ?? null,
      locale: inv.order.locale,
      // Del snapshot, no del Restaurant de hoy: lo mismo que muestra la
      // representación gráfica y lo que viajó en el XML de ESTA factura.
      issuerAddress: snap.legalAddress,
      issuerCity: snap.legalCity,
      issuerPhone: snap.legalPhone,
    });

    // Mismo remitente que la tirilla: para el comensal los dos correos
    // vienen del mismo restaurante.
    const from = brandedInvoiceFrom(snap.restaurantName);
    const ok = await sendEmail({
      to,
      subject,
      html,
      text,
      ...(from && { from }),
      ...(attachment && { attachments: [attachment] }),
    });
    if (!ok) {
      // Se revierte el reclamo: el documento queda otra vez enviable y el
      // motivo queda escrito. En un reenvío fallido vuelve la marca del
      // envío ANTERIOR, que sigue siendo cierta.
      await db.dianDocument.update({
        where: { id: doc.id },
        data: { emailedAt: previousEmailedAt, emailError: "send_failed" },
      });
      return { ok: false, reason: "send_failed" };
    }
    if (!attachment) {
      // El correo salió igual (número, CUFE, total y enlace a la
      // representación gráfica) pero sin el sobre. Queda anotado: es lo
      // único que distingue un correo completo de uno a medias.
      await db.dianDocument.update({
        where: { id: doc.id },
        data: { emailError: "attachment_unavailable" },
      });
    }
    return { ok: true, to, emailedAt: at.toISOString(), attachment: !!attachment };
  } catch (err) {
    console.error("[dian-email] no se pudo enviar la factura electrónica", {
      documentId: opts.documentId,
      err,
    });
    // Best-effort del best-effort: si el reclamo alcanzó a escribirse, se
    // revierte para que un reintento pueda mandarla. El `where` apunta a
    // NUESTRA marca: si alguien más reclamó después, no se le pisa.
    if (claimedAt) {
      await db.dianDocument
        .updateMany({
          where: { id: opts.documentId, emailedAt: claimedAt },
          data: { emailedAt: previousEmailedAt, emailError: "send_failed" },
        })
        .catch(() => undefined);
    }
    return { ok: false, reason: "send_failed" };
  }
}

/**
 * Arma el AttachedDocument zipeado. Devuelve null cuando falta alguno de
 * los dos insumos —el XML firmado o el acuse de la DIAN— y en ese caso el
 * correo sale SIN adjunto: un sobre a medias no probaría nada, y dejar al
 * comensal sin ningún correo es peor que mandarle el CUFE y el enlace a la
 * representación gráfica.
 */
async function buildAttachment(args: {
  restaurantId: string;
  environment: "1" | "2";
  invoiceNumber: string;
  issueDate: string;
  issueTime: string;
  cufe: string;
  invoiceXml: string | null;
  responseXml: string | null;
  /** Solicitud de factura de la orden (la más reciente) o null. */
  request: InvoiceRequestParty | null;
}): Promise<EmailAttachment | null> {
  const { invoiceXml } = args;
  const applicationResponseXml = await extractApplicationResponse(
    args.responseXml,
  );
  if (!invoiceXml || !applicationResponseXml) {
    console.log("[dian-email] sin insumos para el AttachedDocument", {
      invoiceNumber: args.invoiceNumber,
      hasInvoiceXml: !!invoiceXml,
      hasApplicationResponse: !!applicationResponseXml,
    });
    return null;
  }
  const emisor = await resolveEmisor(args.restaurantId);
  if (!emisor) return null;

  const xml = buildAttachedDocumentXml({
    environment: args.environment,
    invoiceNumber: args.invoiceNumber,
    issueDate: args.issueDate,
    issueTime: args.issueTime,
    cufe: args.cufe,
    sender: emisorToSupplierParty(emisor),
    // El sobre tiene que nombrar al MISMO adquiriente que la factura que
    // lleva adentro — de ahí la función compartida con el emit, alimentada
    // con la misma solicitud.
    receiver: customerPartyFor(args.request),
    invoiceXml,
    applicationResponseXml,
  });

  const fileName = attachedDocumentFileName(args.invoiceNumber);
  const zip = await zipInvoice(fileName, xml);
  return {
    filename: fileName.replace(/\.xml$/, ".zip"),
    content: zip.toString("base64"),
    contentType: "application/zip",
  };
}
