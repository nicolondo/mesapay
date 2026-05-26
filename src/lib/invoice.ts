// Renderers + senders para factura simple. La página pública
// `/factura/[id]` consume el mismo snapshot que aparece en el email
// para garantizar que ambos vean exactamente la misma versión.

import { fmtCOP } from "./format";

/**
 * Snapshot guardado en SimpleInvoice.snapshot al momento de emitir.
 * Si el operador cambia logo / NIT / dirección después, la factura
 * ya emitida sigue mostrando el contexto histórico.
 */
export type InvoiceSnapshot = {
  // Identidad del comercio al momento de emitir
  restaurantName: string;
  logoUrl: string | null;
  legalName: string | null;
  taxId: string | null;
  legalAddress: string | null;
  legalPhone: string | null;
  dianResolution: string | null;
  dianResolutionFrom: number | null;
  dianResolutionTo: number | null;
  dianResolutionDate: string | null; // ISO
  invoicePrefix: string | null;
  // Estado de la orden al emitir
  shortCode: string;
  tableLabel: string;
  paidAtIso: string;
  // Items vivos al momento de emitir
  items: Array<{
    qty: number;
    name: string;
    priceCents: number; // unitario
  }>;
  subtotalCents: number;
  tipCents: number;
  totalCents: number;
};

export function formatInvoiceNumber(snapshot: InvoiceSnapshot, n: number): string {
  // Zero-pad según los dígitos del límite superior de la resolución
  // DIAN. Si la resolución va de 1 a 5000, el ancho es 4 → "0050"
  // en vez de "50". Convención común para tirillas POS en Colombia.
  // Si no hay dianResolutionTo, no padeamos (back-compat con
  // facturas viejas que se emitieron sin resolución configurada).
  const width = snapshot.dianResolutionTo
    ? String(snapshot.dianResolutionTo).length
    : 0;
  const numStr = width > 0 ? String(n).padStart(width, "0") : String(n);
  if (snapshot.invoicePrefix) return `${snapshot.invoicePrefix}-${numStr}`;
  return numStr;
}

/**
 * Email HTML simple — anuncia que la factura está lista, da el monto
 * y un botón al link público. El cuerpo no replica la tirilla
 * completa porque imprimir desde un email cliente a cliente es
 * impredecible — preferimos que abra el link en el navegador.
 */
export function renderInvoiceEmail(args: {
  snapshot: InvoiceSnapshot;
  invoiceNumber: number;
  invoiceUrl: string;
}): { subject: string; html: string; text: string } {
  const { snapshot, invoiceNumber, invoiceUrl } = args;
  const numberStr = formatInvoiceNumber(snapshot, invoiceNumber);
  const merchantName =
    snapshot.legalName?.trim() || snapshot.restaurantName;
  const subject = `Tu comprobante de ${merchantName} — ${numberStr}`;

  const lines = [
    `Comprobante ${numberStr}`,
    `${merchantName}`,
    snapshot.taxId ? `NIT ${snapshot.taxId}` : "",
    "",
    `Total pagado: ${fmtCOP(snapshot.totalCents)}`,
    "",
    "Abre tu comprobante e imprímelo si lo necesitas:",
    invoiceUrl,
    "",
    "Gracias por tu visita.",
  ];
  const text = lines.filter(Boolean).join("\n");

  const html = `<!doctype html>
<html lang="es"><body style="margin:0;padding:0;background:#FAF7F2;font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#1A1613;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF7F2;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border:1px solid #EAE1D0;border-radius:16px;overflow:hidden;">
        <tr><td style="padding:32px 32px 8px 32px;">
          <div style="font-family:Geist,Monaco,monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#8B7B65;">Comprobante ${escapeHtml(numberStr)}</div>
          <h1 style="font-family:'Instrument Serif',Georgia,serif;font-size:28px;line-height:1.15;margin:8px 0 14px 0;color:#1A1613;">${escapeHtml(merchantName)}</h1>
          ${snapshot.taxId ? `<div style="font-size:12px;color:#6B6259;margin:0 0 6px 0;">NIT ${escapeHtml(snapshot.taxId)}</div>` : ""}
          <div style="font-size:24px;font-weight:600;margin:18px 0 6px 0;">${fmtCOP(snapshot.totalCents)}</div>
          <div style="font-size:13px;color:#6B6259;margin:0 0 22px 0;">Total pagado</div>
          <a href="${invoiceUrl}" style="display:inline-block;background:#1A1613;color:#FFFFFF;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:500;font-size:14px;">Ver e imprimir comprobante</a>
          <p style="font-size:12px;color:#8B7B65;margin:28px 0 0 0;">Gracias por tu visita.</p>
        </td></tr>
      </table>
      <div style="font-family:Geist,Monaco,monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#B8A98D;margin-top:14px;">Enviado por MESAPAY</div>
    </td></tr>
  </table>
</body></html>`;

  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
