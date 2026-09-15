import { getEmailTranslator } from "@/lib/emailIntl";
import { formatDate, formatMoney } from "@/lib/format";
import { sendEmail, type EmailAttachment } from "@/lib/mailer";
import { formatVoucherCode } from "./code";

/**
 * Correo de EMISIÓN de un lote de bonos a la empresa. Lleva la lista de
 * códigos con su valor (y vigencia), un CSV adjunto para repartirlos, y
 * —sólo en prepago— el botón al link de pago. En crédito explica que se
 * cobra por corte. Misma paleta que el resto de correos de MESAPAY
 * (invoice.ts / reservationEmail.ts).
 *
 * Acá vive sólo el render (puro, testeable); el envío es la última
 * función y es best-effort como todos los correos.
 */
export type VoucherIssueEmailArgs = {
  locale?: string | null;
  restaurantName: string;
  customerName: string;
  quantity: number;
  unitValueCents: number;
  totalCents: number;
  currency: string;
  expiresAt: Date | null;
  mode: "prepaid" | "credit";
  note: string | null;
  vouchers: { code: string; valueCents: number }[];
  /** Prepago: URL pública del link de pago. Crédito: null. */
  paymentUrl: string | null;
};

export async function renderVoucherIssueEmail(
  args: VoucherIssueEmailArgs,
): Promise<{ subject: string; html: string; text: string; csv: string }> {
  const { t, locale } = await getEmailTranslator(args.locale, "emailVoucherIssue");
  const money = (cents: number) =>
    formatMoney(cents, { currency: args.currency, locale });
  const value = money(args.unitValueCents);
  const total = money(args.totalCents);
  const expiry = args.expiresAt
    ? formatDate(args.expiresAt, { locale, dateStyle: "long", timeStyle: undefined })
    : null;

  const subject = t("subject", {
    restaurant: args.restaurantName,
    count: args.quantity,
    customer: args.customerName,
  });
  const intro = t("intro", {
    restaurant: args.restaurantName,
    count: args.quantity,
    value,
    total,
  });
  const expiryLine = expiry ? t("expiresLine", { date: expiry }) : t("noExpiry");
  const modeNote =
    args.mode === "prepaid" ? t("prepaidNote", { total }) : t("creditNote");

  const csv =
    "﻿" +
    [
      [t("csvCode"), t("csvValue"), t("csvExpires")].join(","),
      ...args.vouchers.map((v) =>
        [
          formatVoucherCode(v.code),
          Math.round(v.valueCents / 100),
          args.expiresAt ? args.expiresAt.toISOString().slice(0, 10) : "",
        ].join(","),
      ),
    ].join("\r\n") +
    "\r\n";

  const text = [
    t("greeting", { customer: args.customerName }),
    "",
    intro,
    expiryLine,
    "",
    t("howToUse"),
    "",
    modeNote,
    ...(args.paymentUrl ? ["", `${t("payCta", { total })}: ${args.paymentUrl}`] : []),
    ...(args.note ? ["", `${t("noteLabel")}: ${args.note}`] : []),
    "",
    t("codesTitle"),
    ...args.vouchers.map((v) => `${formatVoucherCode(v.code)}  ${money(v.valueCents)}`),
    "",
    t("csvNote"),
    "",
    t("footer", { restaurant: args.restaurantName }),
  ].join("\n");

  const rows = args.vouchers
    .map(
      (v) =>
        `<tr>
          <td style="padding:6px 0;border-bottom:1px solid #EAE1D0;font-family:'SF Mono','Menlo',monospace;font-size:14px;letter-spacing:0.06em;">${escapeHtml(formatVoucherCode(v.code))}</td>
          <td align="right" style="padding:6px 0;border-bottom:1px solid #EAE1D0;font-size:14px;">${escapeHtml(money(v.valueCents))}</td>
        </tr>`,
    )
    .join("");

  const cta = args.paymentUrl
    ? `<p style="margin:22px 0 6px 0;">
        <a href="${escapeHtml(args.paymentUrl)}" style="display:inline-block;background:#1A1613;color:#FAF7F2;text-decoration:none;padding:13px 22px;border-radius:999px;font-weight:500;font-size:14px;">${escapeHtml(t("payCta", { total }))}</a>
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
          <p style="font-size:15px;line-height:1.55;margin:0 0 6px 0;">${escapeHtml(intro)}</p>
          <p style="font-size:13px;line-height:1.5;color:#3A332B;margin:0 0 14px 0;">${escapeHtml(expiryLine)}</p>
          <p style="font-size:14px;line-height:1.55;color:#3A332B;margin:0 0 14px 0;">${escapeHtml(t("howToUse"))}</p>
          <p style="font-size:14px;line-height:1.55;margin:0 0 6px 0;">${escapeHtml(modeNote)}</p>
          ${cta}
          ${
            args.note
              ? `<p style="font-size:13px;line-height:1.5;color:#3A332B;margin:14px 0 0 0;"><strong>${escapeHtml(t("noteLabel"))}:</strong> ${escapeHtml(args.note)}</p>`
              : ""
          }
          <div style="font-family:Geist,Monaco,monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#8B7B65;margin:26px 0 8px 0;">${escapeHtml(t("codesTitle"))}</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <th align="left" style="font-size:11px;color:#8B7B65;font-weight:500;padding:0 0 4px 0;border-bottom:1px solid #EAE1D0;">${escapeHtml(t("colCode"))}</th>
              <th align="right" style="font-size:11px;color:#8B7B65;font-weight:500;padding:0 0 4px 0;border-bottom:1px solid #EAE1D0;">${escapeHtml(t("colValue"))}</th>
            </tr>
            ${rows}
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

export async function sendVoucherIssueEmail(
  args: VoucherIssueEmailArgs & { to: string },
): Promise<boolean> {
  const { subject, html, text, csv } = await renderVoucherIssueEmail(args);
  const attachments: EmailAttachment[] = [
    {
      filename: `bonos-${slugify(args.restaurantName)}-${new Date().toISOString().slice(0, 10)}.csv`,
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

function slugify(s: string): string {
  return (
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "comercio"
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
