/**
 * Emails de reservas. Reusa el primitivo sendEmail (Resend) con un
 * template propio en la paleta MESAPAY. Best-effort: si Resend no está
 * configurado o falla, loguea y sigue — una reserva no se cae por email.
 */

import { sendEmail } from "./mailer";

const OFFSET_MS = -5 * 60 * 60 * 1000; // Bogotá UTC-5

/** Fecha + hora larga en español Colombia, hora local Bogotá. */
function prettyBogota(d: Date): string {
  const b = new Date(d.getTime() + OFFSET_MS);
  const fecha = b.toLocaleDateString("es-CO", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  const hh = String(b.getUTCHours()).padStart(2, "0");
  const mi = String(b.getUTCMinutes()).padStart(2, "0");
  return `${fecha} a las ${hh}:${mi}`;
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
}): Promise<boolean> {
  const when = prettyBogota(args.startsAt);
  const personas = `${args.partySize} ${args.partySize === 1 ? "persona" : "personas"}`;
  const statusLine = args.autoConfirmed
    ? "Tu reserva está <strong>confirmada</strong>."
    : "Recibimos tu solicitud. El restaurante la <strong>confirmará pronto</strong> y te avisaremos.";
  const statusText = args.autoConfirmed
    ? "Tu reserva está confirmada."
    : "Recibimos tu solicitud. El restaurante la confirmará pronto.";

  const subject = args.autoConfirmed
    ? `Reserva confirmada · ${args.restaurantName}`
    : `Solicitud de reserva recibida · ${args.restaurantName}`;

  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;background:#F5F1E8;padding:32px 24px;color:#1C1C1C;border-radius:16px">
    <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#8A8275;margin-bottom:8px">
      ${args.restaurantName}${args.restaurantCity ? ` · ${args.restaurantCity}` : ""}
    </div>
    <h1 style="font-size:26px;margin:0 0 8px;font-weight:600">Hola ${escapeHtml(args.customerName)} 👋</h1>
    <p style="font-size:14px;color:#5C5446;margin:0 0 20px">${statusLine}</p>
    <div style="background:#FFFDF8;border:1px solid #E4DDCE;border-radius:12px;padding:18px;margin-bottom:20px">
      <table style="width:100%;font-size:14px;border-collapse:collapse">
        <tr><td style="color:#8A8275;padding:4px 0">Fecha</td><td style="text-align:right;font-weight:500">${when}</td></tr>
        <tr><td style="color:#8A8275;padding:4px 0">Personas</td><td style="text-align:right;font-weight:500">${personas}</td></tr>
        <tr><td style="color:#8A8275;padding:4px 0">Mesa</td><td style="text-align:right;font-weight:500">${escapeHtml(args.tableLabel)}</td></tr>
        <tr><td style="color:#8A8275;padding:8px 0 0">Código</td><td style="text-align:right;font-weight:600;font-size:16px;padding-top:8px">${args.confirmationCode}</td></tr>
      </table>
    </div>
    <a href="${args.manageUrl}" style="display:block;text-align:center;background:#1C1C1C;color:#F5F1E8;text-decoration:none;padding:14px;border-radius:999px;font-size:14px;font-weight:500">
      Ver o cancelar mi reserva
    </a>
    <p style="font-size:11px;color:#8A8275;text-align:center;margin-top:16px">
      Si no podés asistir, cancelá con anticipación para liberar la mesa.
    </p>
  </div>`;

  const text = [
    `Hola ${args.customerName},`,
    "",
    statusText,
    "",
    `Restaurante: ${args.restaurantName}`,
    `Fecha: ${when}`,
    `Personas: ${personas}`,
    `Mesa: ${args.tableLabel}`,
    `Código de reserva: ${args.confirmationCode}`,
    "",
    `Ver o cancelar: ${args.manageUrl}`,
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
