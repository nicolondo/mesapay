import { displayOrderCode } from "@/lib/orderCode";
import { getEmailTranslator } from "@/lib/emailIntl";
import { formatDate, formatMoney } from "@/lib/format";
import { sendEmail, type EmailAttachment } from "@/lib/mailer";

/**
 * Correo del CORTE de bonos usados a la empresa: período, cuántos usos,
 * total redimido, y —si hay bonos a crédito en el corte— el botón al
 * link de pago por ese monto. Lo prepagado se informa como ya pagado.
 * CSV adjunto con el detalle (fecha, código, cuenta, monto).
 */
export type VoucherStatementEmailArgs = {
  locale?: string | null;
  restaurantName: string;
  customerName: string;
  periodFrom: Date;
  periodTo: Date;
  totalCents: number;
  creditCents: number;
  prepaidCents: number;
  currency: string;
  rows: { redeemedAt: Date; code: string; orderCode: string; amountCents: number }[];
  /** Crédito con saldo por pagar: URL pública del link. Si no, null. */
  paymentUrl: string | null;
};

export async function renderVoucherStatementEmail(
  args: VoucherStatementEmailArgs,
): Promise<{ subject: string; html: string; text: string; csv: string }> {
  const { t, locale } = await getEmailTranslator(args.locale, "emailVoucherStatement");
  const money = (cents: number) => formatMoney(cents, { currency: args.currency, locale });
  const day = (d: Date) => formatDate(d, { locale, dateStyle: "medium", timeStyle: undefined });
  const from = day(args.periodFrom);
  const to = day(args.periodTo);
  const total = money(args.totalCents);
  const credit = money(args.creditCents);
  const prepaid = money(args.prepaidCents);

  const subject = t("subject", { restaurant: args.restaurantName, from, to });
  const intro = t("intro", {
    restaurant: args.restaurantName,
    from,
    to,
    count: args.rows.length,
    total,
  });
  const creditLine =
    args.creditCents > 0
      ? args.paymentUrl
        ? t("creditLine", { credit })
        : t("creditLinePaid", { credit })
      : null;
  const prepaidLine = args.prepaidCents > 0 ? t("prepaidLine", { prepaid }) : null;

  const csv =
    "﻿" +
    [
      [t("csvDate"), t("csvCode"), t("csvOrder"), t("csvAmount")].join(","),
      ...args.rows.map((r) =>
        [r.redeemedAt.toISOString().slice(0, 10), r.code, r.orderCode, Math.round(r.amountCents / 100)].join(","),
      ),
    ].join("\r\n") +
    "\r\n";

  const text = [
    t("greeting", { customer: args.customerName }),
    "",
    intro,
    ...(creditLine ? [creditLine] : []),
    ...(prepaidLine ? [prepaidLine] : []),
    ...(args.paymentUrl ? ["", `${t("payCta", { credit })}: ${args.paymentUrl}`] : []),
    "",
    t("detailTitle"),
    ...args.rows.map(
      (r) => `${day(r.redeemedAt)}  ${r.code}  ${displayOrderCode(r.orderCode)}  ${money(r.amountCents)}`,
    ),
    "",
    t("csvNote"),
    "",
    t("footer", { restaurant: args.restaurantName }),
  ].join("\n");

  const rowsHtml = args.rows
    .map(
      (r) => `<tr>
        <td style="padding:6px 0;border-bottom:1px solid #EAE1D0;font-size:13px;">${escapeHtml(day(r.redeemedAt))}</td>
        <td style="padding:6px 0;border-bottom:1px solid #EAE1D0;font-family:'SF Mono','Menlo',monospace;font-size:13px;letter-spacing:0.04em;">${escapeHtml(r.code)}</td>
        <td style="padding:6px 0;border-bottom:1px solid #EAE1D0;font-size:13px;color:#8B7B65;">${escapeHtml(displayOrderCode(r.orderCode))}</td>
        <td align="right" style="padding:6px 0;border-bottom:1px solid #EAE1D0;font-size:13px;">${escapeHtml(money(r.amountCents))}</td>
      </tr>`,
    )
    .join("");

  const cta = args.paymentUrl
    ? `<p style="margin:22px 0 6px 0;">
        <a href="${escapeHtml(args.paymentUrl)}" style="display:inline-block;background:#1A1613;color:#FAF7F2;text-decoration:none;padding:13px 22px;border-radius:999px;font-weight:500;font-size:14px;">${escapeHtml(t("payCta", { credit }))}</a>
      </p>
      <p style="font-size:12px;line-height:1.5;color:#8B7B65;margin:0 0 14px 0;">${escapeHtml(t("payFallback"))}<br/><a href="${escapeHtml(args.paymentUrl)}" style="color:#C9532E;word-break:break-all;">${escapeHtml(args.paymentUrl)}</a></p>`
    : "";

  const html = `<!doctype html>
<html lang="${locale}"><body style="margin:0;padding:0;background:#FAF7F2;font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#1A1613;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF7F2;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFBF3;border:1px solid #EAE1D0;border-radius:16px;overflow:hidden;">
        <tr><td style="padding:32px 36px 28px 36px;">
          <div style="font-family:Geist,Monaco,monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#8B7B65;">${escapeHtml(args.restaurantName)} · MESAPAY</div>
          <h1 style="font-family:'Instrument Serif',Georgia,serif;font-size:30px;line-height:1.1;margin:8px 0 16px 0;color:#1A1613;">${escapeHtml(t("title"))}</h1>
          <p style="font-size:15px;line-height:1.55;margin:0 0 14px 0;">${escapeHtml(t("greeting", { customer: args.customerName }))}</p>
          <p style="font-size:15px;line-height:1.55;margin:0 0 10px 0;">${escapeHtml(intro)}</p>
          ${creditLine ? `<p style="font-size:14px;line-height:1.55;margin:0 0 6px 0;">${escapeHtml(creditLine)}</p>` : ""}
          ${prepaidLine ? `<p style="font-size:13px;line-height:1.5;color:#3A332B;margin:0 0 6px 0;">${escapeHtml(prepaidLine)}</p>` : ""}
          ${cta}
          <div style="font-family:Geist,Monaco,monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#8B7B65;margin:26px 0 8px 0;">${escapeHtml(t("detailTitle"))}</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <th align="left" style="font-size:11px;color:#8B7B65;font-weight:500;padding:0 0 4px 0;border-bottom:1px solid #EAE1D0;">${escapeHtml(t("colDate"))}</th>
              <th align="left" style="font-size:11px;color:#8B7B65;font-weight:500;padding:0 0 4px 0;border-bottom:1px solid #EAE1D0;">${escapeHtml(t("colCode"))}</th>
              <th align="left" style="font-size:11px;color:#8B7B65;font-weight:500;padding:0 0 4px 0;border-bottom:1px solid #EAE1D0;">${escapeHtml(t("colOrder"))}</th>
              <th align="right" style="font-size:11px;color:#8B7B65;font-weight:500;padding:0 0 4px 0;border-bottom:1px solid #EAE1D0;">${escapeHtml(t("colAmount"))}</th>
            </tr>
            ${rowsHtml}
            <tr>
              <td colspan="3" style="padding:10px 0 0 0;font-size:13px;font-weight:600;">${escapeHtml(t("totalLabel"))}</td>
              <td align="right" style="padding:10px 0 0 0;font-size:15px;font-weight:600;">${escapeHtml(total)}</td>
            </tr>
          </table>
          <p style="font-size:12px;color:#8B7B65;margin:18px 0 0 0;">${escapeHtml(t("csvNote"))}</p>
        </td></tr>
      </table>
      <div style="font-family:Geist,Monaco,monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#B8A98D;margin-top:18px;">${escapeHtml(t("footer", { restaurant: args.restaurantName }))}</div>
    </td></tr>
  </table>
</body></html>`;

  return { subject, html, text, csv };
}

export async function sendVoucherStatementEmail(
  args: VoucherStatementEmailArgs & { to: string },
): Promise<boolean> {
  const { subject, html, text, csv } = await renderVoucherStatementEmail(args);
  const attachments: EmailAttachment[] = [
    {
      filename: `corte-bonos-${args.periodFrom.toISOString().slice(0, 10)}-${args.periodTo.toISOString().slice(0, 10)}.csv`,
      content: Buffer.from(csv, "utf8").toString("base64"),
      contentType: "text/csv",
    },
  ];
  return sendEmail({
    to: args.to,
    subject,
    html,
    text,
    from: `${args.restaurantName} vía MESAPAY <bonos@mesapay.co>`,
    attachments,
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
