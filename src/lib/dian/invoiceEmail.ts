// Correo de la FACTURA ELECTRÓNICA al adquiriente, con el AttachedDocument
// adjunto. Sale solo, una vez, cuando la DIAN acepta.
//
// Ojo con no confundirlo con el correo de la TIRILLA de MESAPAY
// (`sendSimpleInvoiceEmail`), que sale al cerrar la cuenta y es un
// comprobante nuestro. Este es el otro: el documento fiscal que el emisor
// está OBLIGADO a entregarle al comprador, y que hasta ahora no se mandaba.
//
// Acá vive sólo lo PURO: el render del correo y a quién va dirigido. El
// envío (DB, adjunto, idempotencia) está en `sendInvoiceEmail.ts` — mismo
// corte que `invoice.ts` (renderers) vs. `simpleInvoice.ts` (envío), y es
// lo que deja estas dos piezas testeables sin base de datos.
import { getEmailTranslator } from "@/lib/emailIntl";
import { formatDate, formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";

// ── Render ──────────────────────────────────────────────────────────────────

type IssuerArgs = Pick<
  DianInvoiceEmailArgs,
  "issuerAddress" | "issuerCity" | "issuerPhone"
>;
type T = (key: string, values?: Record<string, string>) => string;

/**
 * Renglones del emisor (dirección, ciudad, teléfono), sólo los que existen.
 * Antes el correo identificaba al emisor únicamente por su nombre
 * comercial: el comensal recibía un documento fiscal sin saber a qué
 * dirección ni a qué teléfono corresponde.
 */
function issuerLines(args: IssuerArgs, t: T): string[] {
  const lines: string[] = [];
  const address = args.issuerAddress?.trim();
  const city = args.issuerCity?.trim();
  const phone = args.issuerPhone?.trim();
  if (address) lines.push(address);
  if (city) lines.push(city);
  if (phone) lines.push(t("phone", { phone }));
  return lines;
}

function issuerBlockHtml(args: IssuerArgs, t: T): string {
  const lines = issuerLines(args, t);
  if (lines.length === 0) return "";
  return (
    `<div style="font-family:'SF Mono','Menlo',monospace;font-size:11px;line-height:1.6;color:#8B7B65;margin:6px 0 0 0;">` +
    lines.map(escapeHtml).join("<br/>") +
    `</div>`
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type DianInvoiceEmailArgs = {
  /** Nombre comercial del restaurante (el que reconoce el comensal). */
  brandName: string;
  /** Número legal del documento — el mismo que viajó a la DIAN. */
  invoiceNumber: string;
  /** Momento del cobro (se muestra como fecha de la factura). */
  issuedAt: Date;
  cufe: string;
  totalCents: number;
  /** Representación gráfica ya existente: /factura/[id]. */
  invoiceUrl: string;
  /** Enlace al catálogo de la DIAN para validar el CUFE. */
  verifyUrl: string;
  /** Nombre del archivo adjunto; null si no se pudo armar el sobre. */
  attachmentName: string | null;
  /** Idioma del COMENSAL (Order.locale). null ⇒ default (es). */
  locale?: string | null;
  /**
   * Datos del EMISOR tal como quedaron en el snapshot de la factura — los
   * mismos que carga el comercio en Identidad (dirección, ciudad, teléfono)
   * y los mismos que ya lleva la representación gráfica. Van congelados a
   * propósito: un correo que muestre la dirección de HOY para una factura
   * emitida ayer contradiría el XML que la DIAN aceptó.
   */
  issuerAddress?: string | null;
  issuerCity?: string | null;
  issuerPhone?: string | null;
};

/**
 * Frame MESAPAY (fondo bone, tarjeta paper, Instrument Serif, CTA ink) —
 * el mismo lenguaje visual del welcome y de la tirilla, sólo tablas y
 * estilos inline para que Gmail y Outlook no lo desarmen.
 */
export async function renderDianInvoiceEmail(
  args: DianInvoiceEmailArgs,
): Promise<{ subject: string; html: string; text: string }> {
  const { t, locale } = await getEmailTranslator(args.locale, "emailDianInvoice");
  const lang: Locale = locale;
  const subject = t("subject", {
    brand: args.brandName,
    number: args.invoiceNumber,
  });
  // Moneda fija en COP a propósito: el documento DIAN se emite en COP
  // (el XML lleva currencyID="COP" hardcodeado). El locale sólo decide el
  // idioma y la agrupación de miles.
  const totalStr = formatMoney(args.totalCents, {
    currency: "COP",
    locale: lang,
  });
  const dateStr = formatDate(args.issuedAt, { locale: lang });
  const intro = t("intro", { brand: args.brandName });

  const text = [
    t("title"),
    "",
    t("greeting"),
    "",
    intro,
    ...issuerLines(args, t),
    "",
    `${t("labelNumber")}: ${args.invoiceNumber}`,
    `${t("labelDate")}: ${dateStr}`,
    `${t("labelTotal")}: ${totalStr}`,
    "",
    `${t("labelCufe")}: ${args.cufe}`,
    t("cufeLead"),
    `${t("verifyCta")}: ${args.verifyUrl}`,
    "",
    args.attachmentName
      ? `${t("attachmentTitle")}: ${t("attachmentLead", { file: args.attachmentName })}`
      : "",
    "",
    t("ctaText", { url: args.invoiceUrl }),
    "",
    t("footerHelp", { brand: args.brandName }),
    t("sentBy"),
  ]
    .filter((l) => l !== "")
    .join("\n");

  const row = (label: string, value: string, mono = false) =>
    `<tr>` +
    `<td style="padding:10px 0;border-bottom:1px solid #EAE1D0;font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#8B7B65;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>` +
    `<td align="right" style="padding:10px 0;border-bottom:1px solid #EAE1D0;font-size:${mono ? "11px" : "15px"};${mono ? "font-family:'SF Mono','Menlo',monospace;word-break:break-all;" : "font-family:'Instrument Serif',Georgia,serif;"}color:#1A1613;">${escapeHtml(value)}</td>` +
    `</tr>`;

  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light only" />
<meta name="supported-color-schemes" content="light only" />
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#F5F1EA;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:#1A1613;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5F1EA;padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#FBF8F3;border:1px solid #E5DED1;border-radius:18px;overflow:hidden;">
      <tr><td style="padding:32px 36px 8px 36px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#8B7B65;">${escapeHtml(args.brandName)}</td>
            <td align="right" style="font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#B8A98D;">MESAPAY</td>
          </tr>
        </table>
        ${issuerBlockHtml(args, t)}
        <h1 style="font-family:'Instrument Serif','Times New Roman',Georgia,serif;font-size:32px;line-height:1.1;margin:14px 0 10px 0;color:#1A1613;font-weight:400;letter-spacing:-0.015em;">${escapeHtml(t("title"))}</h1>
        <p style="font-size:15px;line-height:1.55;margin:0 0 4px 0;">${escapeHtml(t("greeting"))}</p>
        <p style="font-size:14px;line-height:1.55;color:#3A332B;margin:6px 0 0 0;">${escapeHtml(intro)}</p>
      </td></tr>
      <tr><td style="padding:14px 36px 0 36px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #EAE1D0;">
          ${row(t("labelNumber"), args.invoiceNumber)}
          ${row(t("labelDate"), dateStr)}
          ${row(t("labelTotal"), totalStr)}
          ${row(t("labelCufe"), args.cufe, true)}
        </table>
        <p style="font-size:12px;line-height:1.5;color:#8B7B65;margin:12px 0 0 0;">${escapeHtml(t("cufeLead"))}<br/><a href="${escapeHtml(args.verifyUrl)}" style="color:#C9532E;word-break:break-all;">${escapeHtml(t("verifyCta"))}</a></p>
      </td></tr>
      ${
        args.attachmentName
          ? `<tr><td style="padding:20px 36px 0 36px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5F1EA;border:1px solid #EAE1D0;border-radius:12px;">
          <tr><td style="padding:14px 16px;">
            <div style="font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#8B7B65;margin:0 0 6px 0;">${escapeHtml(t("attachmentTitle"))}</div>
            <div style="font-size:13px;line-height:1.5;color:#3A332B;">${escapeHtml(t("attachmentLead", { file: args.attachmentName }))}</div>
          </td></tr>
        </table>
      </td></tr>`
          : ""
      }
      <tr><td align="center" style="padding:24px 36px 30px 36px;">
        <a href="${escapeHtml(args.invoiceUrl)}" style="display:inline-block;background:#1A1613;color:#F5F1EA;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:500;font-size:14px;">${escapeHtml(t("cta"))}</a>
        <p style="font-size:12px;line-height:1.5;color:#8B7B65;margin:18px 0 0 0;">${escapeHtml(t("footerHelp", { brand: args.brandName }))}</p>
      </td></tr>
    </table>
    <div style="font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#B8A98D;margin-top:16px;">${escapeHtml(t("sentBy"))}</div>
  </td></tr>
</table>
</body>
</html>`;

  return { subject, html, text };
}

// ── Destinatario ────────────────────────────────────────────────────────────

export type DianRecipientSources = {
  /** Correo de la factura PERSONALIZADA (InvoiceRequest.email). */
  invoiceRequestEmail?: string | null;
  /** Correo con el que se emitió la factura simple (SimpleInvoice.email). */
  simpleInvoiceEmail?: string | null;
  /** Correo de la genérica pedida en el checkout (Order.simpleInvoiceEmail). */
  orderSimpleInvoiceEmail?: string | null;
};

/**
 * A qué correo va la factura electrónica. En orden:
 *
 *   1. `InvoiceRequest.email` — el comensal pidió factura A SU NOMBRE y
 *      dejó ese correo. Es la declaración más explícita que existe, y es
 *      la misma precedencia que ya aplica `invoiceOnPaid.ts` ("la
 *      personalizada manda sobre la genérica").
 *   2. `SimpleInvoice.email` — el correo con el que se emitió la factura.
 *      Lo resuelven los tres rieles que la emiten y nunca sale de otro
 *      lado que no sea un pedido de factura.
 *   3. `Order.simpleInvoiceEmail` — la genérica pedida en el checkout, por
 *      si la SimpleInvoice se emitió antes de que se guardara.
 *
 * `Order.customerEmail` queda AFUERA a propósito: es el correo del titular
 * de la tarjeta y lo pisa cada cobro (ver el comentario del schema).
 * Tenerlo lleno NO significa que nadie haya pedido factura, y mandarle un
 * documento fiscal a quien sólo pagó sería correo no pedido.
 *
 * null ⇒ nadie pidió factura en esa cuenta. No se manda y NO es un error.
 */
export function resolveDianRecipient(
  sources: DianRecipientSources,
): string | null {
  for (const candidate of [
    sources.invoiceRequestEmail,
    sources.simpleInvoiceEmail,
    sources.orderSimpleInvoiceEmail,
  ]) {
    const email = candidate?.trim();
    if (email) return email;
  }
  return null;
}
