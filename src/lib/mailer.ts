// Thin Resend wrapper. No-ops when RESEND_API_KEY is unset so local/dev builds
// don't break. Errors are logged but never thrown — an email failure must not
// abort a signup or a successful payment.

import { getEmailTranslator } from "./emailIntl";

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

export async function renderWelcomeEmail(
  name: string | null,
  locale?: string | null,
): Promise<{ html: string; text: string; subject: string }> {
  const { t, locale: lang } = await getEmailTranslator(locale, "emailWelcome");
  const greeting = name ? t("greetingNamed", { name }) : t("greeting");
  const subject = t("subject");
  const meUrl = "https://mesapay.co/me";
  const text = [
    `${greeting},`,
    "",
    t("intro"),
    "",
    t("canDoLead"),
    `· ${t("benefit1")}`,
    `· ${t("benefit2")}`,
    `· ${t("benefit3")}`,
    "",
    t("ctaText", { url: meUrl }),
    "",
    t("signoff"),
    t("team"),
  ].join("\n");

  const html = `<!doctype html>
<html lang="${lang}"><body style="margin:0;padding:0;background:#FAF7F2;font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#1A1613;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF7F2;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFBF3;border:1px solid #EAE1D0;border-radius:16px;overflow:hidden;">
        <tr><td style="padding:32px 36px 8px 36px;">
          <div style="font-family:Geist,Monaco,monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#8B7B65;">MESAPAY</div>
          <h1 style="font-family:'Instrument Serif',Georgia,serif;font-size:32px;line-height:1.1;margin:8px 0 16px 0;color:#1A1613;">${escapeHtml(t("title"))}</h1>
          <p style="font-size:15px;line-height:1.55;margin:0 0 14px 0;">${escapeHtml(greeting)},</p>
          <p style="font-size:15px;line-height:1.55;margin:0 0 14px 0;">${escapeHtml(t("intro"))}</p>
          <p style="font-size:15px;line-height:1.55;margin:0 0 6px 0;">${escapeHtml(t("canDoLead"))}</p>
          <ul style="font-size:14px;line-height:1.6;padding-left:20px;margin:0 0 20px 0;color:#3A332B;">
            <li>${escapeHtml(t("benefit1"))}</li>
            <li>${escapeHtml(t("benefit2"))}</li>
            <li>${escapeHtml(t("benefit3"))}</li>
          </ul>
          <p style="margin:24px 0;">
            <a href="${meUrl}" style="display:inline-block;background:#1A1613;color:#FAF7F2;text-decoration:none;padding:12px 20px;border-radius:999px;font-weight:500;font-size:14px;">${escapeHtml(t("cta"))}</a>
          </p>
          <p style="font-size:12px;color:#8B7B65;margin:24px 0 0 0;">${escapeHtml(t("signoff"))}<br/>${escapeHtml(t("team"))}</p>
        </td></tr>
      </table>
      <div style="font-family:Geist,Monaco,monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#B8A98D;margin-top:18px;">${escapeHtml(t("madeIn"))}</div>
    </td></tr>
  </table>
</body></html>`;

  return { html, text, subject };
}

export async function sendWelcomeEmail(
  user: { email: string; name: string | null },
  locale?: string | null,
): Promise<boolean> {
  const { html, text, subject } = await renderWelcomeEmail(user.name, locale);
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
export async function renderMembershipReminderEmail(args: {
  kind: "T-7" | "T-3" | "T-0" | "overdue" | "suspended";
  restaurantName: string;
  planName: string;
  monthlyPriceCop: number; // pesos (sin centavos)
  periodEndsAt: Date | null;
  daysFromEnd: number; // negativo si ya venció
  /** Idioma del destinatario (operador). null ⇒ default (es). */
  locale?: string | null;
}): Promise<{ subject: string; html: string; text: string }> {
  const {
    kind,
    restaurantName,
    planName,
    monthlyPriceCop,
    periodEndsAt,
    daysFromEnd,
  } = args;

  const { t, locale: lang } = await getEmailTranslator(
    args.locale,
    "emailMembership",
  );

  const endsAtLabel = periodEndsAt
    ? periodEndsAt.toLocaleDateString("es-CO", {
        day: "2-digit",
        month: "long",
        year: "numeric",
      })
    : t("dateFallback");

  let subject: string;
  let headline: string;
  let body: string;
  let cta: string;

  switch (kind) {
    case "T-7":
      subject = t("subjectT7", { days: daysFromEnd });
      headline = t("headlineT7", { days: daysFromEnd });
      body = t("bodyT7", {
        plan: planName,
        name: restaurantName,
        date: endsAtLabel,
      });
      cta = t("ctaT7");
      break;
    case "T-3":
      subject = t("subjectT3", { days: daysFromEnd });
      headline = t("headlineT3", { days: daysFromEnd });
      body = t("bodyT3", {
        plan: planName,
        name: restaurantName,
        date: endsAtLabel,
      });
      cta = t("ctaT3");
      break;
    case "T-0":
      subject = t("subjectT0");
      headline = t("headlineT0");
      body = t("bodyT0", {
        plan: planName,
        name: restaurantName,
        date: endsAtLabel,
      });
      cta = t("ctaT0");
      break;
    case "overdue":
      subject = t("subjectOverdue");
      headline = t("headlineOverdue", { days: Math.abs(daysFromEnd) });
      body = t("bodyOverdue", {
        plan: planName,
        name: restaurantName,
        date: endsAtLabel,
      });
      cta = t("ctaOverdue");
      break;
    case "suspended":
      subject = t("subjectSuspended");
      headline = t("headlineSuspended");
      body = t("bodySuspended", {
        plan: planName,
        name: restaurantName,
        date: endsAtLabel,
      });
      cta = t("ctaSuspended");
      break;
  }

  const text = [
    `${restaurantName}`,
    "",
    `${headline}.`,
    "",
    body,
    "",
    `${t("labelPlan")}: ${planName}`,
    `${t("labelMonthly")}: $${monthlyPriceCop.toLocaleString("es-CO")} COP`,
    `${t("labelDue")}: ${endsAtLabel}`,
    "",
    t("contactLine"),
    "",
    t("team"),
  ].join("\n");

  const html = `<!doctype html>
<html lang="${lang}">
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
                  <div style="font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#8B7B65;margin:0 0 4px 0;">${escapeHtml(t("labelPlan"))}</div>
                  <div style="font-family:'Instrument Serif',Georgia,serif;font-size:22px;color:#1A1613;line-height:1;">${escapeHtml(planName)}</div>
                </td>
                <td align="right" style="padding:14px 0;width:50%;">
                  <div style="font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#8B7B65;margin:0 0 4px 0;">${escapeHtml(t("labelMonthly"))}</div>
                  <div style="font-family:'Instrument Serif',Georgia,serif;font-size:22px;color:#1A1613;line-height:1;">$${monthlyPriceCop.toLocaleString("es-CO")}</div>
                </td>
              </tr>
              <tr>
                <td colspan="2" style="padding:0 0 14px 0;font-family:'SF Mono','Menlo',monospace;font-size:11px;color:#8B7B65;">
                  ${escapeHtml(t("labelDue"))} ${escapeHtml(endsAtLabel)}
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:24px 36px 28px 36px;">
            <p style="font-size:13px;color:#3A332B;line-height:1.5;margin:0 0 18px 0;">
              ${escapeHtml(t("contactParagraph"))}
            </p>
            <a href="mailto:hola@mesapay.co?subject=${encodeURIComponent("Renovar plan " + restaurantName)}" style="display:inline-block;background:#1A1613;color:#F5F1EA;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:500;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;">
              ${escapeHtml(cta)}
            </a>
          </td>
        </tr>
      </table>
      <div style="font-family:'SF Mono','Menlo',monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#B8A98D;margin-top:16px;">
        ${escapeHtml(t("footer"))}
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
export async function welcomeIfFirstTime(
  userId: string,
  locale?: string | null,
): Promise<void> {
  const { db } = await import("./db");
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, welcomedAt: true, role: true },
  });
  if (!user || user.welcomedAt || user.role !== "customer") return;
  const sent = await sendWelcomeEmail(
    { email: user.email, name: user.name },
    locale,
  );
  if (sent) {
    await db.user.update({
      where: { id: user.id },
      data: { welcomedAt: new Date() },
    });
  }
}
