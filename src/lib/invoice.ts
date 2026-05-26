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
  // Ciudad agregada en sprint 7 — facturas anteriores no la tienen
  // en el snapshot. Opcional acá; el renderer lo trata defensivamente.
  legalCity?: string | null;
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
 * Email HTML completo — frame MESAPAY (Instrument Serif + paleta
 * bone/ink) con la tirilla POS embebida en el body usando solo
 * tablas + estilos inline (Outlook + Gmail seguros). El link a
 * /factura/[id] queda al final como CTA para imprimir bien.
 *
 * Las dimensiones están en píxeles fijos porque los email clients
 * no soportan dvh, vw, fr, grid ni flexbox de forma consistente.
 * Receipt-block ~360px ancho (mimics 80mm). Outer 600px.
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
  const brandName = snapshot.restaurantName;
  const subject = `Tu comprobante de ${brandName} — ${numberStr}`;
  const paidAt = new Date(snapshot.paidAtIso);
  const dianDate = snapshot.dianResolutionDate
    ? new Date(snapshot.dianResolutionDate)
    : null;
  // Formato compacto sin "p. m." — el locale es-CO mete espacios
  // dentro del time que rompen línea en viewports angostos del
  // correo. 24h + middle-dot queda limpio y MESAPAY-style.
  const fechaStr = paidAt
    .toLocaleString("es-CO", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
    .replace(", ", " · ");
  const dianDateStr = dianDate
    ? dianDate.toLocaleDateString("es-CO")
    : null;

  // Texto plano fallback — clientes sin HTML support, screen readers.
  const text = [
    `${merchantName}`,
    snapshot.taxId ? `NIT ${snapshot.taxId}` : "",
    snapshot.legalAddress ?? "",
    snapshot.legalCity ?? "",
    snapshot.legalPhone ? `Tel: ${snapshot.legalPhone}` : "",
    "",
    `Comprobante ${numberStr}`,
    `Fecha: ${fechaStr}`,
    `${snapshot.tableLabel}  ${snapshot.shortCode}`,
    "",
    ...snapshot.items.map(
      (i) =>
        `${i.qty}× ${i.name}  ${fmtCOP(i.qty * i.priceCents)}`,
    ),
    "",
    `Subtotal: ${fmtCOP(snapshot.subtotalCents)}`,
    snapshot.tipCents > 0
      ? `Propina: ${fmtCOP(snapshot.tipCents)}`
      : "",
    `TOTAL: ${fmtCOP(snapshot.totalCents)}`,
    "",
    snapshot.dianResolution
      ? `Resolución DIAN: ${snapshot.dianResolution}`
      : "",
    snapshot.dianResolutionFrom != null && snapshot.dianResolutionTo != null
      ? `Numeración del ${snapshot.dianResolutionFrom} al ${snapshot.dianResolutionTo}`
      : "",
    dianDateStr ? `Fecha de resolución ${dianDateStr}` : "",
    "",
    "Para imprimir tu comprobante con formato POS, ábrelo en tu navegador:",
    invoiceUrl,
    "",
    "¡Gracias por tu visita!",
  ]
    .filter((l) => l !== "")
    .join("\n");

  const html = renderHtml({
    snapshot,
    numberStr,
    merchantName,
    brandName,
    fechaStr,
    dianDateStr,
    invoiceUrl,
  });

  return { subject, html, text };
}

function renderHtml(args: {
  snapshot: InvoiceSnapshot;
  numberStr: string;
  merchantName: string;
  brandName: string;
  fechaStr: string;
  dianDateStr: string | null;
  invoiceUrl: string;
}): string {
  const { snapshot, numberStr, merchantName, brandName, fechaStr, dianDateStr, invoiceUrl } = args;

  // Items como filas de tabla — más resistente que divs en Outlook.
  const itemRows = snapshot.items
    .map(
      (i) => `
        <tr>
          <td style="padding:4px 0;font-family:'SF Mono','Menlo','Consolas',monospace;font-size:12px;color:#000;width:32px;text-align:left;vertical-align:top;">${i.qty}×</td>
          <td style="padding:4px 6px;font-family:'SF Mono','Menlo','Consolas',monospace;font-size:12px;color:#000;vertical-align:top;">${escapeHtml(i.name)}</td>
          <td style="padding:4px 0;font-family:'SF Mono','Menlo','Consolas',monospace;font-size:12px;color:#000;text-align:right;vertical-align:top;white-space:nowrap;">${fmtCOP(i.qty * i.priceCents)}</td>
        </tr>`,
    )
    .join("");

  // Línea punteada — span lleno con borde inferior. Más confiable
  // que <hr> en Outlook (que lo renderea con padding raro).
  const dashed = `<div style="border-bottom:1px dashed #000;height:1px;margin:10px 0;line-height:0;font-size:0;">&nbsp;</div>`;

  const logoSrc =
    snapshot.logoUrl && snapshot.logoUrl.trim()
      ? snapshot.logoUrl.startsWith("http")
        ? snapshot.logoUrl
        : `https://mesapay.co${snapshot.logoUrl}`
      : "https://mesapay.co/icons/icon-192.png";

  // Paleta MESAPAY (mismos tokens que globals.css):
  //   bone     #F5F1EA  → fondo exterior del email
  //   paper    #FBF8F3  → card que envuelve TODO el contenido,
  //                       incluida la tirilla (sin sub-recuadro
  //                       blanco — se ve como una sola superficie
  //                       limpia, no anidada).
  //   ink      #1A1613  → tipografía y CTA
  //   hairline #E5DED1  → separadores muy finos donde hace falta
  //
  // `color-scheme: light only` + `supported-color-schemes: light only`
  // bloquean la inversión auto que hace Gmail/Outlook en dark mode.
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light only" />
<meta name="supported-color-schemes" content="light only" />
<title>${escapeHtml(`Comprobante ${numberStr} — ${brandName}`)}</title>
<style>
  :root { color-scheme: light only; supported-color-schemes: light only; }
  /* La tirilla hereda el bg del card para que no se vea anidada;
     este selector específico lo refuerza contra clientes que
     ignoran inline bg en tablas. */
  .mp-receipt { background:#FBF8F3 !important; }
</style>
</head>
<body style="margin:0;padding:0;background:#F5F1EA;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:#1A1613;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5F1EA;padding:32px 12px;">
  <tr>
    <td align="center">
      <!-- Outer card -->
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#FBF8F3;border:1px solid #E5DED1;border-radius:18px;overflow:hidden;">

        <!-- Header MESAPAY style -->
        <tr>
          <td style="padding:32px 36px 4px 36px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#8B7B65;">
                  Comprobante · ${escapeHtml(numberStr)}
                </td>
                <td align="right" style="font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#B8A98D;">
                  MESAPAY
                </td>
              </tr>
            </table>
            <h1 style="font-family:'Instrument Serif','Times New Roman',Georgia,serif;font-size:32px;line-height:1.1;margin:14px 0 6px 0;color:#1A1613;font-weight:400;letter-spacing:-0.015em;">
              ${escapeHtml(brandName)}
            </h1>
            <p style="font-size:14px;line-height:1.5;color:#3A332B;margin:0 0 4px 0;">
              Recibimos tu pago — acá está el comprobante. Si necesitas imprimirlo
              con formato de tirilla, abre el botón al final del correo.
            </p>
          </td>
        </tr>

        <!-- Resumen visual: total destacado.
             Columnas alineadas TOP, ambas con misma estructura
             (label uppercase mono + valor serif/mono). Evita el
             cramping que pasaba antes con 3 líneas apiladas a la
             derecha contra el total a la izquierda. -->
        <tr>
          <td style="padding:18px 36px 6px 36px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #E5DED1;border-bottom:1px solid #E5DED1;">
              <tr>
                <td valign="top" style="padding:18px 0;">
                  <div style="font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#8B7B65;margin:0 0 6px 0;">Total pagado</div>
                  <div style="font-family:'Instrument Serif','Times New Roman',Georgia,serif;font-size:36px;color:#1A1613;line-height:1;white-space:nowrap;">${fmtCOP(snapshot.totalCents)}</div>
                  <div style="font-family:'SF Mono','Menlo',monospace;font-size:11px;color:#8B7B65;margin-top:8px;white-space:nowrap;">${escapeHtml(fechaStr)}</div>
                </td>
                <td valign="top" align="right" style="padding:18px 0;">
                  <div style="font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#8B7B65;margin:0 0 6px 0;">Mesa</div>
                  <div style="font-family:'Instrument Serif','Times New Roman',Georgia,serif;font-size:22px;color:#1A1613;line-height:1.1;">${escapeHtml(snapshot.tableLabel)}</div>
                  <div style="font-family:'SF Mono','Menlo',monospace;font-size:11px;color:#8B7B65;margin-top:8px;white-space:nowrap;">${escapeHtml(snapshot.shortCode)}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Tirilla POS embebida -->
        <tr>
          <td style="padding:22px 36px 8px 36px;">
            <div style="font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#8B7B65;margin:0 0 10px 0;">
              Tu tirilla
            </div>
            <table class="mp-receipt" role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" bgcolor="#FBF8F3" style="width:100%;max-width:380px;background:#FBF8F3;">
              <tr>
                <td style="padding:18px 16px;">
                  <!-- Logo + razón social -->
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td align="center" style="padding:0 0 8px 0;">
                        <img src="${escapeHtml(logoSrc)}" width="56" height="56" alt="${escapeHtml(brandName)}" style="display:block;margin:0 auto;max-width:56px;max-height:56px;object-fit:contain;" />
                      </td>
                    </tr>
                    <tr>
                      <td align="center" style="padding:0 0 2px 0;font-family:'SF Mono','Menlo',monospace;font-size:14px;font-weight:700;color:#000;text-transform:uppercase;line-height:1.3;">
                        ${escapeHtml(merchantName)}
                      </td>
                    </tr>
                    ${
                      snapshot.taxId
                        ? `<tr><td align="center" style="padding:1px 0;font-family:'SF Mono','Menlo',monospace;font-size:11px;color:#000;">NIT ${escapeHtml(snapshot.taxId)}</td></tr>`
                        : ""
                    }
                    ${
                      snapshot.legalAddress
                        ? `<tr><td align="center" style="padding:1px 0;font-family:'SF Mono','Menlo',monospace;font-size:11px;color:#000;">${escapeHtml(snapshot.legalAddress)}</td></tr>`
                        : ""
                    }
                    ${
                      snapshot.legalCity
                        ? `<tr><td align="center" style="padding:1px 0;font-family:'SF Mono','Menlo',monospace;font-size:11px;color:#000;">${escapeHtml(snapshot.legalCity)}</td></tr>`
                        : ""
                    }
                    ${
                      snapshot.legalPhone
                        ? `<tr><td align="center" style="padding:1px 0;font-family:'SF Mono','Menlo',monospace;font-size:11px;color:#000;">Tel: ${escapeHtml(snapshot.legalPhone)}</td></tr>`
                        : ""
                    }
                  </table>

                  ${dashed}

                  <!-- Comprobante meta -->
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="font-family:'SF Mono','Menlo',monospace;font-size:12px;color:#000;padding:2px 0;">Comprobante</td>
                      <td align="right" style="font-family:'SF Mono','Menlo',monospace;font-size:12px;color:#000;padding:2px 0;font-weight:700;">${escapeHtml(numberStr)}</td>
                    </tr>
                    <tr>
                      <td style="font-family:'SF Mono','Menlo',monospace;font-size:12px;color:#000;padding:2px 0;">Fecha</td>
                      <td align="right" style="font-family:'SF Mono','Menlo',monospace;font-size:12px;color:#000;padding:2px 0;">${escapeHtml(fechaStr)}</td>
                    </tr>
                    <tr>
                      <td style="font-family:'SF Mono','Menlo',monospace;font-size:12px;color:#000;padding:2px 0;">${escapeHtml(snapshot.tableLabel)}</td>
                      <td align="right" style="font-family:'SF Mono','Menlo',monospace;font-size:12px;color:#000;padding:2px 0;">${escapeHtml(snapshot.shortCode)}</td>
                    </tr>
                  </table>

                  ${dashed}

                  <!-- Items -->
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    ${itemRows}
                  </table>

                  ${dashed}

                  <!-- Totales -->
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="font-family:'SF Mono','Menlo',monospace;font-size:12px;color:#000;padding:2px 0;">Subtotal</td>
                      <td align="right" style="font-family:'SF Mono','Menlo',monospace;font-size:12px;color:#000;padding:2px 0;">${fmtCOP(snapshot.subtotalCents)}</td>
                    </tr>
                    ${
                      snapshot.tipCents > 0
                        ? `<tr><td style="font-family:'SF Mono','Menlo',monospace;font-size:12px;color:#000;padding:2px 0;">Propina</td><td align="right" style="font-family:'SF Mono','Menlo',monospace;font-size:12px;color:#000;padding:2px 0;">${fmtCOP(snapshot.tipCents)}</td></tr>`
                        : ""
                    }
                    <tr>
                      <td style="font-family:'SF Mono','Menlo',monospace;font-size:14px;font-weight:700;color:#000;padding:8px 0 2px 0;border-top:1px solid #000;">TOTAL</td>
                      <td align="right" style="font-family:'SF Mono','Menlo',monospace;font-size:14px;font-weight:700;color:#000;padding:8px 0 2px 0;border-top:1px solid #000;">${fmtCOP(snapshot.totalCents)}</td>
                    </tr>
                  </table>

                  ${dashed}

                  <!-- Footer DIAN -->
                  <div style="text-align:center;font-family:'SF Mono','Menlo',monospace;font-size:10px;color:#000;line-height:1.5;">
                    ${snapshot.dianResolution ? `Resolución DIAN: ${escapeHtml(snapshot.dianResolution)}<br />` : ""}
                    ${
                      snapshot.dianResolutionFrom != null && snapshot.dianResolutionTo != null
                        ? `Numeración del ${snapshot.dianResolutionFrom} al ${snapshot.dianResolutionTo}<br />`
                        : ""
                    }
                    ${dianDateStr ? `Fecha de resolución ${escapeHtml(dianDateStr)}<br />` : ""}
                  </div>
                  <div style="text-align:center;font-family:'SF Mono','Menlo',monospace;font-size:11px;color:#000;margin-top:10px;">
                    ¡Gracias por tu visita!
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- CTA imprimir -->
        <tr>
          <td align="center" style="padding:22px 36px 8px 36px;">
            <p style="font-size:13px;color:#3A332B;line-height:1.5;margin:0 0 14px 0;">
              ¿Necesitas imprimirla? Abre el comprobante en tu navegador para
              mandarla a tu impresora térmica o de papel.
            </p>
            <a href="${escapeHtml(invoiceUrl)}" style="display:inline-block;background:#1A1613;color:#F5F1EA;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:500;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;letter-spacing:0.01em;">
              Abrir e imprimir comprobante
            </a>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:24px 36px 28px 36px;border-top:1px solid #E5DED1;margin-top:12px;">
            <p style="font-size:12px;color:#8B7B65;line-height:1.5;margin:0;text-align:center;">
              Si tienes dudas con tu cuenta, escríbele directamente a
              <strong style="color:#1A1613;">${escapeHtml(brandName)}</strong>.
            </p>
          </td>
        </tr>
      </table>

      <!-- Brand footer -->
      <div style="font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#B8A98D;margin-top:16px;">
        Enviado por MESAPAY · Hecho en Colombia
      </div>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
