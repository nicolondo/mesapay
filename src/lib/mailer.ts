// Thin Resend wrapper. No-ops when RESEND_API_KEY is unset so local/dev builds
// don't break. Errors are logged but never thrown — an email failure must not
// abort a signup or a successful payment.

type SendArgs = {
  to: string;
  subject: string;
  html: string;
  text: string;
  // Override del From por mensaje (ej: por restaurante, para que el
  // sender muestre el nombre del comercio). Si no se pasa, cae al
  // MAIL_FROM global del env. El email-address tiene que ser de un
  // dominio verificado en Resend; el display name es libre.
  from?: string;
};

export async function sendEmail(args: SendArgs): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const from = args.from ?? process.env.MAIL_FROM ?? "MESAPAY <hola@mesapay.co>";
  if (!key) {
    console.log(`[mailer] skipped (no RESEND_API_KEY) → ${args.to} — ${args.subject}`);
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        from,
        to: args.to,
        subject: args.subject,
        html: args.html,
        text: args.text,
      }),
    });
    if (!res.ok) {
      console.error(`[mailer] resend ${res.status}: ${await res.text().catch(() => "")}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[mailer] send failed", err);
    return false;
  }
}

export function renderWelcomeEmail(name: string | null): { html: string; text: string; subject: string } {
  const greeting = name ? `Hola ${name}` : "Hola";
  const subject = "Bienvenido a MESAPAY";
  const text = [
    `${greeting},`,
    "",
    "Gracias por crear tu cuenta en MESAPAY.",
    "",
    "Con tu cuenta puedes:",
    "· Ver el historial de tus cuentas en cualquier restaurante con MESAPAY.",
    "· Pagar más rápido la próxima vez, sin volver a escribir tus datos.",
    "· Calificar los platos que probaste.",
    "",
    "Cuando quieras revisar tus órdenes, entra a https://mesapay.co/me",
    "",
    "Buen provecho,",
    "El equipo MESAPAY",
  ].join("\n");

  const html = `<!doctype html>
<html lang="es"><body style="margin:0;padding:0;background:#FAF7F2;font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#1A1613;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF7F2;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFBF3;border:1px solid #EAE1D0;border-radius:16px;overflow:hidden;">
        <tr><td style="padding:32px 36px 8px 36px;">
          <div style="font-family:Geist,Monaco,monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#8B7B65;">MESAPAY</div>
          <h1 style="font-family:'Instrument Serif',Georgia,serif;font-size:32px;line-height:1.1;margin:8px 0 16px 0;color:#1A1613;">Bienvenido a MESAPAY</h1>
          <p style="font-size:15px;line-height:1.55;margin:0 0 14px 0;">${greeting},</p>
          <p style="font-size:15px;line-height:1.55;margin:0 0 14px 0;">Gracias por crear tu cuenta. Ya puedes ordenar y pagar desde la mesa en cualquier restaurante con MESAPAY, sin apps ni filas.</p>
          <p style="font-size:15px;line-height:1.55;margin:0 0 6px 0;">Con tu cuenta puedes:</p>
          <ul style="font-size:14px;line-height:1.6;padding-left:20px;margin:0 0 20px 0;color:#3A332B;">
            <li>Ver el historial de tus cuentas.</li>
            <li>Pagar más rápido sin volver a escribir tus datos.</li>
            <li>Calificar los platos que probaste.</li>
          </ul>
          <p style="margin:24px 0;">
            <a href="https://mesapay.co/me" style="display:inline-block;background:#1A1613;color:#FAF7F2;text-decoration:none;padding:12px 20px;border-radius:999px;font-weight:500;font-size:14px;">Ver mis órdenes</a>
          </p>
          <p style="font-size:12px;color:#8B7B65;margin:24px 0 0 0;">Buen provecho,<br/>El equipo MESAPAY</p>
        </td></tr>
      </table>
      <div style="font-family:Geist,Monaco,monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#B8A98D;margin-top:18px;">Hecho en Colombia</div>
    </td></tr>
  </table>
</body></html>`;

  return { html, text, subject };
}

export async function sendWelcomeEmail(user: { email: string; name: string | null }): Promise<boolean> {
  const { html, text, subject } = renderWelcomeEmail(user.name);
  return sendEmail({ to: user.email, subject, html, text });
}

/**
 * Renderer del email de recordatorio de vencimiento. Cuatro umbrales
 * con copy y tono distinto:
 *   T-7      → heads-up suave
 *   T-3      → recordatorio firme
 *   T-0      → vence hoy, urgente
 *   overdue  → vencido (post-vencimiento, antes de auto-suspend)
 *   suspended → ya suspendido por el cron
 *
 * Mantiene la misma paleta MESAPAY del email de factura (bone bg,
 * paper card, ink CTA) para que el operador reconozca el remitente.
 */
export function renderMembershipReminderEmail(args: {
  kind: "T-7" | "T-3" | "T-0" | "overdue" | "suspended";
  restaurantName: string;
  planName: string;
  monthlyPriceCop: number; // pesos (sin centavos)
  periodEndsAt: Date | null;
  daysFromEnd: number; // negativo si ya venció
}): { subject: string; html: string; text: string } {
  const {
    kind,
    restaurantName,
    planName,
    monthlyPriceCop,
    periodEndsAt,
    daysFromEnd,
  } = args;

  const endsAtLabel = periodEndsAt
    ? periodEndsAt.toLocaleDateString("es-CO", {
        day: "2-digit",
        month: "long",
        year: "numeric",
      })
    : "—";

  let subject: string;
  let headline: string;
  let body: string;
  let cta: string;

  switch (kind) {
    case "T-7":
      subject = `Tu plan MESAPAY vence en ${daysFromEnd} días`;
      headline = `Tu plan vence en ${daysFromEnd} días`;
      body = `Hola, tu plan ${planName} de MESAPAY para ${restaurantName} vence el ${endsAtLabel}. Si quieres mantener el servicio sin interrupciones, renueva antes de esa fecha.`;
      cta = "Renovar mi plan";
      break;
    case "T-3":
      subject = `Tu plan MESAPAY vence en ${daysFromEnd} días`;
      headline = `Solo ${daysFromEnd} días para renovar`;
      body = `Tu plan ${planName} de MESAPAY para ${restaurantName} vence el ${endsAtLabel}. Después de esa fecha tendrás un periodo de gracia corto y luego suspendemos el acceso automáticamente.`;
      cta = "Renovar ahora";
      break;
    case "T-0":
      subject = `Tu plan MESAPAY vence hoy`;
      headline = `Tu plan vence hoy`;
      body = `El plan ${planName} de ${restaurantName} vence al final del día (${endsAtLabel}). Si no lo renuevas, mañana entrará en periodo de gracia y suspenderemos el acceso en pocos días.`;
      cta = "Renovar ahora";
      break;
    case "overdue":
      subject = `Tu plan MESAPAY está vencido`;
      headline = `Plan vencido hace ${Math.abs(daysFromEnd)} días`;
      body = `El plan ${planName} de ${restaurantName} venció el ${endsAtLabel}. Estás en periodo de gracia — el acceso sigue activo pero pronto se suspenderá automáticamente. Renueva para evitar interrupciones.`;
      cta = "Renovar para evitar suspensión";
      break;
    case "suspended":
      subject = `Tu cuenta MESAPAY fue suspendida`;
      headline = `Acceso suspendido`;
      body = `El plan ${planName} de ${restaurantName} venció el ${endsAtLabel} y no recibimos el pago. Por eso suspendimos el acceso. Apenas registremos tu pago, reactivamos automáticamente.`;
      cta = "Contactar para renovar";
      break;
  }

  const text = [
    `${restaurantName}`,
    "",
    `${headline}.`,
    "",
    body,
    "",
    `Plan: ${planName}`,
    `Mensualidad: $${monthlyPriceCop.toLocaleString("es-CO")} COP`,
    `Vencimiento: ${endsAtLabel}`,
    "",
    "Contacta a tu asesor de MESAPAY para renovar.",
    "",
    "El equipo MESAPAY",
  ].join("\n");

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light only" />
<meta name="supported-color-schemes" content="light only" />
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#F5F1EA;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:#1A1613;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5F1EA;padding:32px 12px;">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#FBF8F3;border:1px solid #E5DED1;border-radius:18px;overflow:hidden;">
        <tr>
          <td style="padding:32px 36px 4px 36px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#8B7B65;">
                  Cuenta · ${escapeHtml(restaurantName)}
                </td>
                <td align="right" style="font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#B8A98D;">
                  MESAPAY
                </td>
              </tr>
            </table>
            <h1 style="font-family:'Instrument Serif','Times New Roman',Georgia,serif;font-size:32px;line-height:1.1;margin:14px 0 6px 0;color:#1A1613;font-weight:400;letter-spacing:-0.015em;">
              ${escapeHtml(headline)}
            </h1>
            <p style="font-size:14px;line-height:1.55;color:#3A332B;margin:6px 0 0 0;">
              ${escapeHtml(body)}
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:18px 36px 6px 36px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #E5DED1;border-bottom:1px solid #E5DED1;">
              <tr>
                <td style="padding:14px 0;width:50%;">
                  <div style="font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#8B7B65;margin:0 0 4px 0;">Plan</div>
                  <div style="font-family:'Instrument Serif',Georgia,serif;font-size:22px;color:#1A1613;line-height:1;">${escapeHtml(planName)}</div>
                </td>
                <td align="right" style="padding:14px 0;width:50%;">
                  <div style="font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#8B7B65;margin:0 0 4px 0;">Mensualidad</div>
                  <div style="font-family:'Instrument Serif',Georgia,serif;font-size:22px;color:#1A1613;line-height:1;">$${monthlyPriceCop.toLocaleString("es-CO")}</div>
                </td>
              </tr>
              <tr>
                <td colspan="2" style="padding:0 0 14px 0;font-family:'SF Mono','Menlo',monospace;font-size:11px;color:#8B7B65;">
                  Vencimiento ${escapeHtml(endsAtLabel)}
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:24px 36px 28px 36px;">
            <p style="font-size:13px;color:#3A332B;line-height:1.5;margin:0 0 18px 0;">
              Contacta a tu asesor de MESAPAY para renovar tu plan
              o cambiar tu método de pago.
            </p>
            <a href="mailto:hola@mesapay.co?subject=${encodeURIComponent("Renovar plan " + restaurantName)}" style="display:inline-block;background:#1A1613;color:#F5F1EA;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:500;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;">
              ${escapeHtml(cta)}
            </a>
          </td>
        </tr>
      </table>
      <div style="font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#B8A98D;margin-top:16px;">
        Enviado por MESAPAY · Hecho en Colombia
      </div>
    </td>
  </tr>
</table>
</body>
</html>`;

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

// Fire-and-forget: called after a guest's first paid order when we want to
// welcome them without blocking the payment response. Safe to call multiple
// times — the welcomedAt guard ensures only one email per user.
export async function welcomeIfFirstTime(userId: string): Promise<void> {
  const { db } = await import("./db");
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, welcomedAt: true, role: true },
  });
  if (!user || user.welcomedAt || user.role !== "customer") return;
  const sent = await sendWelcomeEmail({ email: user.email, name: user.name });
  if (sent) {
    await db.user.update({
      where: { id: user.id },
      data: { welcomedAt: new Date() },
    });
  }
}
