import { displayOrderCode } from "@/lib/orderCode";
import { getEmailTranslator } from "@/lib/emailIntl";
import { formatDate, formatMoney } from "@/lib/format";
import { sendEmail } from "@/lib/mailer";

/**
 * Correo con el LINK DE PAGO de una factura manual: a nombre del comercio,
 * con el total vigente, el detalle de la cuenta (si lo hay), el botón al
 * link y hasta cuándo sirve. El idioma es el de la cuenta (`Order.locale`,
 * el del operador que la abrió), como el resto de los correos de una orden.
 */
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
};

export async function renderManualInvoicePayLinkEmail(
  args: ManualInvoicePayLinkEmailArgs,
): Promise<{ subject: string; html: string; text: string }> {
  const { t, locale } = await getEmailTranslator(args.locale, "emailOrderPayLink");
  const money = (cents: number) => formatMoney(cents, { currency: args.currency, locale });
  const total = money(args.totalCents);
  const code = displayOrderCode(args.orderCode);
  const expires = formatDate(args.expiresAt, { locale, dateStyle: "long", timeStyle: undefined });

  const subject = t("subject", { restaurant: args.restaurantName, code, total });
  const greeting = args.customerName ? t("greetingNamed", { name: args.customerName }) : t("greeting");
  const intro = t("intro", { restaurant: args.restaurantName, code, total });

  const text = [
    greeting,
    "",
    intro,
    "",
    `${t("payCta", { total })}: ${args.payUrl}`,
    "",
    t("methods"),
    t("expires", { date: expires }),
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

  const html = `<!doctype html>
<html lang="${locale}"><body style="margin:0;padding:0;background:#FAF7F2;font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#1A1613;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF7F2;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFBF3;border:1px solid #EAE1D0;border-radius:16px;overflow:hidden;">
        <tr><td style="padding:32px 36px 28px 36px;">
          <div style="font-family:Geist,Monaco,monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#8B7B65;">${escapeHtml(args.restaurantName)} · MESAPAY</div>
          <h1 style="font-family:'Instrument Serif',Georgia,serif;font-size:30px;line-height:1.1;margin:8px 0 16px 0;color:#1A1613;">${escapeHtml(t("title"))}</h1>
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
          <p style="font-size:13px;line-height:1.5;color:#3A332B;margin:0 0 4px 0;">${escapeHtml(t("methods"))}</p>
          <p style="font-size:13px;line-height:1.5;color:#3A332B;margin:0;">${escapeHtml(t("expires", { date: expires }))}</p>
          ${detail}
        </td></tr>
      </table>
      <div style="font-family:Geist,Monaco,monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#B8A98D;margin-top:18px;">${escapeHtml(t("footer", { restaurant: args.restaurantName }))}</div>
    </td></tr>
  </table>
</body></html>`;

  return { subject, html, text };
}

export async function sendManualInvoicePayLinkEmail(
  args: ManualInvoicePayLinkEmailArgs & { to: string },
): Promise<boolean> {
  const { subject, html, text } = await renderManualInvoicePayLinkEmail(args);
  return sendEmail({
    to: args.to,
    subject,
    html,
    text,
    from: `${args.restaurantName} vía MESAPAY <cuentas@mesapay.co>`,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
