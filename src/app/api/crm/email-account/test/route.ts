import { NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { getCrmContext } from "@/lib/crm/access";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";

// Re-check private host at test time in case a row was created before this guard.
function isPrivateHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^0\./.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && parseInt(m[1], 10) >= 16 && parseInt(m[1], 10) <= 31) return true;
  if (/^192\.168\./.test(h)) return true;
  return false;
}

export async function POST() {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const account = await db.crmEmailAccount.findUnique({
    where: { userId: ctx.userId },
  });

  if (!account) {
    return NextResponse.json(
      { error: "no_account", detail: "Configura tu cuenta SMTP primero." },
      { status: 400 },
    );
  }

  // S3: Reject private/loopback hosts even for existing rows.
  if (isPrivateHost(account.smtpHost)) {
    return NextResponse.json({ error: "invalid_smtp_host" }, { status: 400 });
  }

  let smtpPass: string;
  try {
    smtpPass = decrypt(account.smtpPassEnc);
  } catch {
    return NextResponse.json(
      { error: "decrypt_failed", detail: "No se pudo descifrar la contraseña guardada." },
      { status: 500 },
    );
  }

  const transport = nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpPort === 465,
    auth: {
      user: account.smtpUser,
      pass: smtpPass,
    },
  });

  try {
    await transport.sendMail({
      from: `"${account.fromName}" <${account.email}>`,
      to: account.email,
      subject: "MESAPAY CRM ✓",
      text: "Tu cuenta de correo está correctamente configurada en MESAPAY CRM.",
    });

    await db.crmEmailAccount.update({
      where: { userId: ctx.userId },
      data: { verifiedAt: new Date() },
    });

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message =
      err instanceof Error
        ? err.message.replace(/password|pass|clave|secret/gi, "***")
        : "SMTP error desconocido";

    return NextResponse.json(
      { error: "smtp_failed", detail: message },
      { status: 400 },
    );
  }
}
