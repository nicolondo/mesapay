/**
 * Emails de reservas. Reusa el primitivo sendEmail (Resend) con un
 * template propio en la paleta MESAPAY. Best-effort: si Resend no está
 * configurado o falla, loguea y sigue — una reserva no se cae por email.
 *
 * Idioma: se renderiza en el idioma del comensal (`locale`), que se
 * captura de la cookie al reservar y se guarda en Reservation.locale.
 * Así el correo sale en su idioma aunque lo dispare un webhook de
 * depósito (sin cookie de request).
 */

import { sendEmail } from "./mailer";
import { getEmailTranslator } from "./emailIntl";
import { localeTag } from "./format";

const OFFSET_MS = -5 * 60 * 60 * 1000; // Bogotá UTC-5

/** Fecha (larga) + hora, hora local Bogotá, en el idioma del comensal. */
function bogotaParts(
  d: Date,
  localeTagStr: string,
): { date: string; time: string } {
  const b = new Date(d.getTime() + OFFSET_MS);
  const date = b.toLocaleDateString(localeTagStr, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  const hh = String(b.getUTCHours()).padStart(2, "0");
  const mi = String(b.getUTCMinutes()).padStart(2, "0");
  return { date, time: `${hh}:${mi}` };
}

export async function sendReservationConfirmation(args: {
  to: string;
  customerName: string;
  restaurantName: string;
  restaurantCity: string | null;
  tableLabel: string;
  partySize: number;
  startsAt: Date;
  confirmationCode: string;
  autoConfirmed: boolean;
  manageUrl: string;
  /** Idioma del comensal (Reservation.locale). null ⇒ default (es). */
  locale?: string | null;
  /** Si la reserva tenía depósito y se pagó, su monto en centavos. */
  depositPaidCents?: number;
}): Promise<boolean> {
  const { t, locale } = await getEmailTranslator(args.locale, "emailReservation");
  const tag = localeTag(locale);

  const { date, time } = bogotaParts(args.startsAt, tag);
  const when = t("dateTime", { date, time });
  const personas = t("people", { count: args.partySize });
  const depositPesos =
    args.depositPaidCents && args.depositPaidCents > 0
      ? "$" + Math.round(args.depositPaidCents / 100).toLocaleString(tag)
      : null;
  const statusText = args.autoConfirmed
    ? t("statusConfirmed")
    : t("statusRequested");

  const subject = args.autoConfirmed
    ? t("subjectConfirmed", { name: args.restaurantName })
    : t("subjectRequested", { name: args.restaurantName });

  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;background:#F5F1E8;padding:32px 24px;color:#1C1C1C;border-radius:16px">
    <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#8A8275;margin-bottom:8px">
      ${escapeHtml(args.restaurantName)}${args.restaurantCity ? ` · ${escapeHtml(args.restaurantCity)}` : ""}
    </div>
    <h1 style="font-size:26px;margin:0 0 8px;font-weight:600">${escapeHtml(t("greeting", { name: args.customerName }))}</h1>
    <p style="font-size:14px;color:#5C5446;margin:0 0 20px">${escapeHtml(statusText)}</p>
    <div style="background:#FFFDF8;border:1px solid #E4DDCE;border-radius:12px;padding:18px;margin-bottom:20px">
      <table style="width:100%;font-size:14px;border-collapse:collapse">
        <tr><td style="color:#8A8275;padding:4px 0">${escapeHtml(t("fieldDate"))}</td><td style="text-align:right;font-weight:500">${escapeHtml(when)}</td></tr>
        <tr><td style="color:#8A8275;padding:4px 0">${escapeHtml(t("fieldPeople"))}</td><td style="text-align:right;font-weight:500">${escapeHtml(personas)}</td></tr>
        <tr><td style="color:#8A8275;padding:4px 0">${escapeHtml(t("fieldTable"))}</td><td style="text-align:right;font-weight:500">${escapeHtml(args.tableLabel)}</td></tr>
        <tr><td style="color:#8A8275;padding:8px 0 0">${escapeHtml(t("fieldCode"))}</td><td style="text-align:right;font-weight:600;font-size:16px;padding-top:8px">${escapeHtml(args.confirmationCode)}</td></tr>
        ${
          depositPesos
            ? `<tr><td style="color:#8A8275;padding:8px 0 0">${escapeHtml(t("depositPaidLabel"))}</td><td style="text-align:right;font-weight:600;padding-top:8px">${escapeHtml(depositPesos)}</td></tr>`
            : ""
        }
      </table>
      ${
        depositPesos
          ? `<p style="font-size:12px;color:#5C5446;margin:12px 0 0">${escapeHtml(t("depositNote", { amount: depositPesos }))}</p>`
          : ""
      }
    </div>
    <a href="${escapeHtml(args.manageUrl)}" style="display:block;text-align:center;background:#1C1C1C;color:#F5F1E8;text-decoration:none;padding:14px;border-radius:999px;font-size:14px;font-weight:500">
      ${escapeHtml(t("cta"))}
    </a>
    <p style="font-size:11px;color:#8A8275;text-align:center;margin-top:16px">
      ${escapeHtml(t("footerNote"))}
    </p>
  </div>`;

  const text = [
    t("txtGreeting", { name: args.customerName }),
    "",
    statusText,
    "",
    `${t("fieldRestaurant")}: ${args.restaurantName}`,
    `${t("fieldDate")}: ${when}`,
    `${t("fieldPeople")}: ${personas}`,
    `${t("fieldTable")}: ${args.tableLabel}`,
    `${t("fieldCode")}: ${args.confirmationCode}`,
    "",
    `${t("ctaText")}: ${args.manageUrl}`,
  ].join("\n");

  return sendEmail({
    to: args.to,
    subject,
    html,
    text,
    from: `${args.restaurantName} vía MESAPAY <reservas@mesapay.co>`,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
