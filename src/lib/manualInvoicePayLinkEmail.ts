import { displayOrderCode } from "@/lib/orderCode";
import { getEmailTranslator } from "@/lib/emailIntl";
import { formatDate, formatMoney } from "@/lib/format";
import { sendEmail, type EmailAttachment } from "@/lib/mailer";
import type { PayLinkOnlineMethod } from "@/lib/manualInvoicePayLink";

/**
 * Correo de una FACTURA MANUAL con su LINK DE PAGO: a nombre del comercio,
 * con el total, el botón al link, los medios en línea que el comercio
 * ofrece, el detalle y —lo que lo vuelve "el envío de la factura"— la
 * factura misma:
 *
 *   · `issued`: la factura ya existe (emitida al "Emitir y enviar", o antes
 *     de cobrar, #577). Va su número, el enlace a la representación gráfica
 *     y, si es electrónica y la DIAN ya la aceptó, el CUFE, el enlace para
 *     validarla y el XML adjunto (el mismo AttachedDocument que el correo
 *     de la factura electrónica). Si la DIAN todavía no contesta, se dice
 *     que la factura electrónica llega por correo apenas la acepte.
 *   · `on_payment`: todavía no se emite. El correo es una "cuenta por
 *     pagar" y dice que la factura se emite al pagar.
 *
 * El idioma es el de la cuenta (`Order.locale`, el del operador que la
 * abrió), como el resto de los correos de una orden.
 */
export type PayLinkEmailInvoice =
  | {
      kind: "issued";
      /** Número legal con prefijo ("FE-120"). */
      number: string;
      /** Representación gráfica pública: /factura/[id]. */
      url: string;
      /** Factura electrónica aceptada: CUFE y enlace a la DIAN. */
      electronic: { cufe: string; verifyUrl: string; attached: boolean } | null;
      /** Electrónica, pero la DIAN todavía no la acepta. */
      pendingDian: boolean;
    }
  | { kind: "on_payment"; electronic: boolean };

export type ManualInvoicePayLinkEmailArgs = {
  locale?: string | null;
  restaurantName: string;
  orderCode: string;
  totalCents: number;
  currency: string;
  lines: { name: string; qty: number; amountCents: number }[];
  payUrl: string;
  expiresAt: Date;
  /** Nombre del cliente identificado en la cuenta, si lo hay. */
  customerName?: string | null;
  /** La factura (emitida o por emitir al pagar). null = no se menciona. */
  invoice?: PayLinkEmailInvoice | null;
  /** Medios en línea que ofrece el link (sin los presenciales). */
  methods?: readonly PayLinkOnlineMethod[];
  /** Factura por cobrar: vencimiento (fecha + plazo del cliente). */
  dueDate?: Date | null;
};

const METHOD_KEY: Record<PayLinkOnlineMethod, string> = {
  kushki_card: "methodCard",
  kushki_apple_pay: "methodApplePay",
  kushki_pse: "methodPse",
  kushki_bre_b: "methodBreB",
};

export async function renderManualInvoicePayLinkEmail(
  args: ManualInvoicePayLinkEmailArgs,
): Promise<{ subject: string; html: string; text: string }> {
  const { t, locale } = await getEmailTranslator(args.locale, "emailOrderPayLink");
  const money = (cents: number) => formatMoney(cents, { currency: args.currency, locale });
  const day = (date: Date) => formatDate(date, { locale, dateStyle: "long", timeStyle: undefined });
  const total = money(args.totalCents);
  const code = displayOrderCode(args.orderCode);
  const expires = day(args.expiresAt);
  const invoice = args.invoice ?? null;
  const issued = invoice?.kind === "issued" ? invoice : null;

  const subject = issued
    ? t("subjectInvoice", { restaurant: args.restaurantName, number: issued.number, total })
    : t("subject", { restaurant: args.restaurantName, code, total });
  const title = issued ? t("titleInvoice", { number: issued.number }) : t("title");
  // "Empresa S.A.S." + "Hola, {name}." no debe quedar con dos puntos.
  const customerName = args.customerName?.trim().replace(/\.+$/, "") || null;
  const greeting = customerName ? t("greetingNamed", { name: customerName }) : t("greeting");
  const intro = issued
    ? t("introInvoice", { restaurant: args.restaurantName, number: issued.number, total })
    : t("intro", { restaurant: args.restaurantName, code, total });

  // Medios: los que de verdad ofrece el link. Sin lista (llamador viejo),
  // el texto genérico de siempre.
  const methodsLine =
    args.methods && args.methods.length > 0
      ? t("methodsList", {
          list: new Intl.ListFormat(locale, { type: "disjunction" }).format(
            args.methods.map((m) => t(METHOD_KEY[m])),
          ),
        })
      : t("methods");
  const whenLine = args.dueDate ? t("dueDate", { date: day(args.dueDate) }) : t("expires", { date: expires });

  // Bloque de la factura: qué es, dónde verla y qué pasa con la electrónica.
  const invoiceLines: string[] = [];
  if (issued) {
    if (issued.electronic) {
      invoiceLines.push(t("invoiceCufe", { cufe: issued.electronic.cufe }));
      if (issued.electronic.attached) invoiceLines.push(t("invoiceXmlAttached"));
    } else if (issued.pendingDian) {
      invoiceLines.push(t("invoicePendingDian"));
    }
  } else if (invoice?.kind === "on_payment") {
    invoiceLines.push(invoice.electronic ? t("invoiceOnPaymentElectronic") : t("invoiceOnPayment"));
  }

  const text = [
    greeting,
    "",
    intro,
    "",
    `${t("payCta", { total })}: ${args.payUrl}`,
    "",
    methodsLine,
    whenLine,
    ...(issued
      ? [
          "",
          `${t("invoiceTitle", { number: issued.number })}: ${issued.url}`,
          ...invoiceLines,
          ...(issued.electronic ? [`${t("invoiceVerify")}: ${issued.electronic.verifyUrl}`] : []),
        ]
      : invoiceLines.length > 0
        ? ["", ...invoiceLines]
        : []),
    ...(args.lines.length > 0
      ? ["", t("detailTitle"), ...args.lines.map((l) => `${l.qty}× ${l.name}  ${money(l.amountCents)}`), `${t("totalLabel")}: ${total}`]
      : []),
    "",
    t("footer", { restaurant: args.restaurantName }),
  ].join("\n");

  const rowsHtml = args.lines
    .map(
      (l) => `<tr>
        <td style="padding:6px 0;border-bottom:1px solid #EAE1D0;font-size:13px;color:#8B7B65;width:36px;">${l.qty}×</td>
        <td style="padding:6px 0;border-bottom:1px solid #EAE1D0;font-size:13px;">${escapeHtml(l.name)}</td>
        <td align="right" style="padding:6px 0;border-bottom:1px solid #EAE1D0;font-size:13px;">${escapeHtml(money(l.amountCents))}</td>
      </tr>`,
    )
    .join("");

  const detail =
    args.lines.length > 0
      ? `<div style="font-family:Geist,Monaco,monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#8B7B65;margin:26px 0 8px 0;">${escapeHtml(t("detailTitle"))}</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${rowsHtml}
            <tr>
              <td colspan="2" style="padding:10px 0 0 0;font-size:13px;font-weight:600;">${escapeHtml(t("totalLabel"))}</td>
              <td align="right" style="padding:10px 0 0 0;font-size:15px;font-weight:600;">${escapeHtml(total)}</td>
            </tr>
          </table>`
      : "";

  const invoiceHtml = issued
    ? `<div style="margin:22px 0 0 0;padding:14px 16px;border:1px solid #EAE1D0;border-radius:12px;">
            <div style="font-family:Geist,Monaco,monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#8B7B65;">${escapeHtml(t("invoiceTitle", { number: issued.number }))}</div>
            <p style="font-size:13px;line-height:1.5;margin:6px 0 0 0;"><a href="${escapeHtml(issued.url)}" style="color:#C9532E;">${escapeHtml(t("invoiceView"))}</a>${
              issued.electronic
                ? ` · <a href="${escapeHtml(issued.electronic.verifyUrl)}" style="color:#C9532E;">${escapeHtml(t("invoiceVerify"))}</a>`
                : ""
            }</p>
            ${invoiceLines
              .map(
                (line) =>
                  `<p style="font-size:12px;line-height:1.5;color:#3A332B;margin:6px 0 0 0;word-break:break-all;">${escapeHtml(line)}</p>`,
              )
              .join("")}
          </div>`
    : invoiceLines.length > 0
      ? `<p style="font-size:13px;line-height:1.5;color:#3A332B;margin:14px 0 0 0;">${escapeHtml(invoiceLines[0])}</p>`
      : "";

  const html = `<!doctype html>
<html lang="${locale}"><body style="margin:0;padding:0;background:#FAF7F2;font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#1A1613;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF7F2;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFBF3;border:1px solid #EAE1D0;border-radius:16px;overflow:hidden;">
        <tr><td style="padding:32px 36px 28px 36px;">
          <div style="font-family:Geist,Monaco,monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#8B7B65;">${escapeHtml(args.restaurantName)} · MESAPAY</div>
          <h1 style="font-family:'Instrument Serif',Georgia,serif;font-size:30px;line-height:1.1;margin:8px 0 16px 0;color:#1A1613;">${escapeHtml(title)}</h1>
          <p style="font-size:15px;line-height:1.55;margin:0 0 14px 0;">${escapeHtml(greeting)}</p>
          <p style="font-size:15px;line-height:1.55;margin:0 0 10px 0;">${escapeHtml(intro)}</p>
          <div style="margin:18px 0 6px 0;padding:14px 16px;border:1px solid #EAE1D0;border-radius:12px;background:#FAF7F2;">
            <div style="font-family:Geist,Monaco,monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#8B7B65;">${escapeHtml(t("totalLabel"))}</div>
            <div style="font-family:'Instrument Serif',Georgia,serif;font-size:28px;line-height:1.1;margin-top:4px;">${escapeHtml(total)}</div>
          </div>
          <p style="margin:22px 0 6px 0;">
            <a href="${escapeHtml(args.payUrl)}" style="display:inline-block;background:#1A1613;color:#FAF7F2;text-decoration:none;padding:13px 22px;border-radius:999px;font-weight:500;font-size:14px;">${escapeHtml(t("payCta", { total }))}</a>
          </p>
          <p style="font-size:12px;line-height:1.5;color:#8B7B65;margin:0 0 14px 0;">${escapeHtml(t("payFallback"))}<br/><a href="${escapeHtml(args.payUrl)}" style="color:#C9532E;word-break:break-all;">${escapeHtml(args.payUrl)}</a></p>
          <p style="font-size:13px;line-height:1.5;color:#3A332B;margin:0 0 4px 0;">${escapeHtml(methodsLine)}</p>
          <p style="font-size:13px;line-height:1.5;color:#3A332B;margin:0;">${escapeHtml(whenLine)}</p>
          ${invoiceHtml}
          ${detail}
        </td></tr>
      </table>
      <div style="font-family:Geist,Monaco,monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#B8A98D;margin-top:18px;">${escapeHtml(t("footer", { restaurant: args.restaurantName }))}</div>
    </td></tr>
  </table>
</body></html>`;

  return { subject, html, text };
}

/**
 * Manda el correo a cada destinatario (uno por destinatario: nadie ve los
 * correos de los demás). Devuelve a quiénes salió y a quiénes no.
 */
export async function sendManualInvoicePayLinkEmail(
  args: ManualInvoicePayLinkEmailArgs & { to: string | readonly string[]; attachments?: EmailAttachment[] },
): Promise<{ sent: string[]; failed: string[] }> {
  const { subject, html, text } = await renderManualInvoicePayLinkEmail(args);
  const recipients = typeof args.to === "string" ? [args.to] : [...args.to];
  const sent: string[] = [];
  const failed: string[] = [];
  for (const to of recipients) {
    const ok = await sendEmail({
      to,
      subject,
      html,
      text,
      from: `${args.restaurantName} vía MESAPAY <cuentas@mesapay.co>`,
      ...(args.attachments?.length ? { attachments: args.attachments } : {}),
    });
    (ok ? sent : failed).push(to);
  }
  return { sent, failed };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
