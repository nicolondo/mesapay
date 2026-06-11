import { NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { getCrmContext } from "@/lib/crm/access";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";

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
