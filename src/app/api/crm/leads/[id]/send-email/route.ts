import { NextResponse } from "next/server";
import { z } from "zod";
import path from "path";
import { readFile } from "fs/promises";
import nodemailer from "nodemailer";
import { getCrmContext } from "@/lib/crm/access";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { renderTemplate } from "@/lib/crm/templateRender";

const SendSchema = z.object({
  contactId: z.string(),
  templateId: z.string().optional(),
  subject: z.string().min(1).optional(),
  bodyHtml: z.string().min(1).optional(),
  extraNote: z.string().optional(),
}).refine(
  (d) => d.templateId || (d.subject && d.bodyHtml),
  { message: "Provide templateId or both subject+bodyHtml" },
);

function uploadDir() {
  const base =
    process.env.UPLOAD_DIR ?? path.join(process.cwd(), "public", "uploads");
  return path.join(base, "crm");
}

/** Derive filesystem path from fileUrl (e.g. /uploads/crm/abc.pdf).
 *  S1: resolves the path and asserts it stays within the upload base dir.
 *  Returns null if the path would escape the base (path traversal attempt). */
function filePathFromUrl(fileUrl: string): string | null {
  // fileUrl is like /uploads/crm/filename.pdf
  // filesystem path is UPLOAD_DIR/crm/filename.pdf OR public/uploads/crm/filename.pdf
  const base =
    process.env.UPLOAD_DIR ?? path.join(process.cwd(), "public", "uploads");
  const segments = fileUrl.replace(/^\/uploads\//, "").split("/");
  const joined = path.join(base, ...segments);
  const resolved = path.resolve(joined);
  const allowedPrefix = path.resolve(base) + path.sep;
  // Also allow exact base dir match (no trailing sep) — but uploads should always be files.
  if (!resolved.startsWith(allowedPrefix)) {
    return null;
  }
  return resolved;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id: leadId } = await params;

  // 1. Scope-check lead
  const lead = await db.crmLead.findUnique({
    where: { id: leadId },
    include: {
      assignedTo: { select: { name: true } },
      city: { select: { name: true } },
    },
  });

  if (!lead) {
    return NextResponse.json({ error: "lead_not_found" }, { status: 404 });
  }

  if (
    ctx.visibleUserIds !== null &&
    !ctx.visibleUserIds.includes(lead.assignedToUserId)
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // 2. Parse body
  const body = await req.json().catch(() => null);
  const parsed = SendSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { contactId, templateId, extraNote } = parsed.data;
  let { subject, bodyHtml } = parsed.data;

  // 3. Validate contact has email
  const contact = await db.crmContact.findUnique({
    where: { id: contactId },
    select: { id: true, name: true, email: true, leadId: true },
  });

  if (!contact || contact.leadId !== leadId) {
    return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  }

  if (!contact.email) {
    return NextResponse.json(
      { error: "contact_no_email", detail: "El contacto no tiene dirección de email." },
      { status: 400 },
    );
  }

  // 4. Load email account
  const account = await db.crmEmailAccount.findUnique({
    where: { userId: ctx.userId },
  });

  if (!account) {
    return NextResponse.json(
      {
        error: "no_email_account",
        detail: "Configura tu cuenta de correo en Más → Mi correo.",
      },
      { status: 400 },
    );
  }

  if (!account.verifiedAt) {
    return NextResponse.json(
      {
        error: "account_not_verified",
        detail: "Primero verifica tu cuenta de correo enviando un correo de prueba.",
      },
      { status: 400 },
    );
  }

  // 5. Load template if given
  let attachmentIds: string[] = [];

  if (templateId) {
    const template = await db.crmEmailTemplate.findUnique({
      where: { id: templateId },
    });

    if (!template) {
      return NextResponse.json({ error: "template_not_found" }, { status: 404 });
    }

    // Check template is visible to user
    const isVisible =
      template.scope === "global" ||
      template.ownerUserId === ctx.userId;
    if (!isVisible) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    subject = template.subject;
    bodyHtml = template.bodyHtml;
    attachmentIds = template.attachmentIds;
  }

  // 6. Render variables
  // Get sender's name
  const sender = await db.user.findUnique({
    where: { id: ctx.userId },
    select: { name: true },
  });

  const vars: Record<string, string> = {
    nombre: contact.name,
    comercio: lead.name,
    ciudad: lead.city?.name ?? lead.countryCode ?? "",
    comercial: sender?.name ?? account.fromName,
  };

  const renderedSubject = renderTemplate(subject!, vars);
  const renderedBody = renderTemplate(bodyHtml!, vars);

  // Append extraNote if provided
  const finalBody = extraNote
    ? `${renderedBody}<hr><p><em>${extraNote}</em></p>`
    : renderedBody;

  // 7. Load attachments from filesystem
  const attachments: { filename: string; content: Buffer }[] = [];

  if (attachmentIds.length > 0) {
    const docs = await db.crmDocument.findMany({
      where: {
        id: { in: attachmentIds },
        OR: [
          { scope: "global" },
          { scope: "user", ownerUserId: ctx.userId },
        ],
      },
    });

    for (const doc of docs) {
      try {
        const filePath = filePathFromUrl(doc.fileUrl);
        if (!filePath) continue; // S1: skip invalid/traversal paths
        const content = await readFile(filePath);
        const filename = doc.name + (doc.name.includes(".") ? "" : "." + doc.mime.split("/")[1]);
        attachments.push({ filename, content });
      } catch {
        // skip file if not found
      }
    }
  }

  // 8. Send email via nodemailer
  let smtpPass: string;
  try {
    smtpPass = decrypt(account.smtpPassEnc);
  } catch {
    return NextResponse.json(
      { error: "decrypt_failed", detail: "Error al descifrar la contraseña guardada." },
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
      to: contact.email,
      subject: renderedSubject,
      html: finalBody,
      attachments: attachments.map((a) => ({
        filename: a.filename,
        content: a.content,
      })),
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error
        ? err.message.replace(/password|pass|clave|secret/gi, "***")
        : "SMTP error desconocido";

    return NextResponse.json(
      { error: "smtp_failed", detail: message },
      { status: 502 },
    );
  }

  // 9. Record activity
  const now = new Date();
  await db.$transaction([
    db.crmActivity.create({
      data: {
        leadId,
        userId: ctx.userId,
        type: "email",
        content: renderedSubject,
        meta: {
          to: contact.email,
          templateId: templateId ?? null,
        },
      },
    }),
    db.crmLead.update({
      where: { id: leadId },
      data: { lastActivityAt: now },
    }),
  ]);

  return NextResponse.json({ ok: true });
}
