// Envío AUTOMÁTICO de la factura electrónica al adquiriente.
//
// Se dispara desde los DOS caminos por los que puede llegar la aceptación
// de la DIAN: la respuesta síncrona de `SendBillSync` (emit) y la consulta
// diferida de `GetStatusZip` (status). La DIAN valida asíncrono, así que
// cualquiera de los dos puede ser el primero en enterarse — y por eso el
// envío es idempotente por `DianDocument.emailedAt`.
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
import { bogotaIssueTime, CONSUMIDOR_FINAL } from "@/lib/dian/emit";
import { emisorToSupplierParty, resolveEmisor } from "@/lib/dian/config";
import {
  extractApplicationResponse,
  unzipFirstXml,
  zipInvoice,
} from "@/lib/dian/soap";

/**
 * Manda la factura electrónica (AttachedDocument) al adquiriente.
 *
 * Idempotente: el envío se RECLAMA con un `updateMany` acotado a
 * `emailedAt: null`, así que si los dos rieles corren a la vez sólo uno
 * manda. Si el envío falla se libera la marca para poder reintentar.
 */
export async function sendDianInvoiceEmail(opts: {
  documentId: string;
  /** Ambiente del emisor — decide contra qué catálogo DIAN se valida. */
  environment: "habilitacion" | "produccion";
}): Promise<void> {
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
    // Guardarraíles: sólo sale lo ACEPTADO y sólo una vez. El estado se
    // vuelve a mirar acá (no sólo en el caller) justamente porque son dos
    // rieles distintos los que llaman.
    if (!doc || doc.state !== "accepted" || doc.emailedAt) return;
    if (!doc.simpleInvoice || !doc.cufe) return;
    const inv = doc.simpleInvoice;

    // La personalizada manda sobre la genérica (mismo criterio que
    // `invoiceOnPaid.ts`). No se filtra por `status`: cuando esto corre la
    // solicitud ya pasó a `generated`.
    const request = await db.invoiceRequest.findFirst({
      where: { orderId: inv.order.id },
      orderBy: { createdAt: "desc" },
      select: { email: true },
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
      return;
    }

    // Reclamo del envío ANTES de mandar: el que pierde la carrera sale acá.
    const claimed = await db.dianDocument.updateMany({
      where: { id: doc.id, emailedAt: null },
      data: { emailedAt: new Date(), emailError: null },
    });
    if (claimed.count === 0) return;

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
      // Se libera la marca: el documento queda otra vez enviable y el
      // motivo queda escrito.
      await db.dianDocument.update({
        where: { id: doc.id },
        data: { emailedAt: null, emailError: "send_failed" },
      });
      return;
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
  } catch (err) {
    console.error("[dian-email] no se pudo enviar la factura electrónica", {
      documentId: opts.documentId,
      err,
    });
    // Best-effort del best-effort: si el reclamo alcanzó a escribirse, se
    // libera para que un reintento pueda mandarla.
    await db.dianDocument
      .updateMany({
        where: { id: opts.documentId, emailedAt: { not: null } },
        data: { emailedAt: null, emailError: "send_failed" },
      })
      .catch(() => undefined);
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
    // lleva adentro — de ahí la constante compartida con el emit.
    receiver: CONSUMIDOR_FINAL,
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
