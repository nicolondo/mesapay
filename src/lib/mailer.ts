// Thin Resend wrapper. No-ops when RESEND_API_KEY is unset so local/dev builds
// don't break. Errors are logged but never thrown — an email failure must not
// abort a signup or a successful payment.

type SendArgs = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export async function sendEmail(args: SendArgs): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM ?? "MESAPAY <hola@mesapay.co>";
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
