import { NextResponse } from "next/server";
import { z } from "zod";
import { getCrmContext } from "@/lib/crm/access";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto";

// S3: Only well-known submission ports allowed.
const ALLOWED_SMTP_PORTS = [465, 587, 2525] as const;

// S3: Reject private/loopback SMTP hosts.
function isPrivateHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  // IPv4 private/loopback ranges
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^0\./.test(h)) return true;
  // 172.16.0.0/12 → 172.16.x.x … 172.31.x.x
  const m = h.match(/^172\.(\d+)\./);
  if (m && parseInt(m[1], 10) >= 16 && parseInt(m[1], 10) <= 31) return true;
  if (/^192\.168\./.test(h)) return true;
  return false;
}

const PutSchema = z.object({
  fromName: z.string().min(1),
  email: z.string().email(),
  smtpHost: z.string().min(1),
  smtpPort: z.number().int().refine(
    (p) => (ALLOWED_SMTP_PORTS as readonly number[]).includes(p),
    { message: "smtpPort must be one of 465, 587, or 2525" },
  ),
  smtpUser: z.string().min(1),
  smtpPass: z.string().optional(), // if omitted on update, keep existing
});

export async function GET() {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const account = await db.crmEmailAccount.findUnique({
    where: { userId: ctx.userId },
    select: {
      userId: true,
      fromName: true,
      email: true,
      smtpHost: true,
      smtpPort: true,
      smtpUser: true,
      verifiedAt: true,
      // never return smtpPassEnc
    },
  });

  if (!account) return NextResponse.json({ account: null });

  return NextResponse.json({
    account: {
      ...account,
      hasPassword: true, // always true if row exists
    },
  });
}

export async function PUT(req: Request) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = PutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { fromName, email, smtpHost, smtpPort, smtpUser, smtpPass } =
    parsed.data;

  // S3: Reject private/loopback SMTP hosts to prevent SSRF-style abuse.
  if (isPrivateHost(smtpHost)) {
    return NextResponse.json({ error: "invalid_smtp_host" }, { status: 400 });
  }

  const existing = await db.crmEmailAccount.findUnique({
    where: { userId: ctx.userId },
    select: { smtpPassEnc: true, smtpHost: true, smtpPort: true, smtpUser: true },
  });

  let smtpPassEnc: string;
  if (smtpPass) {
    smtpPassEnc = encrypt(smtpPass);
  } else if (existing?.smtpPassEnc) {
    smtpPassEnc = existing.smtpPassEnc;
  } else {
    return NextResponse.json(
      { error: "password_required" },
      { status: 400 },
    );
  }

  // S2: Reset verifiedAt when smtpHost, smtpPort, smtpUser, or smtpPass change.
  const credentialsChanged =
    !existing ||
    smtpPass !== undefined ||
    smtpHost !== existing.smtpHost ||
    smtpPort !== existing.smtpPort ||
    smtpUser !== existing.smtpUser;

  const account = await db.crmEmailAccount.upsert({
    where: { userId: ctx.userId },
    create: {
      userId: ctx.userId,
      fromName,
      email,
      smtpHost,
      smtpPort,
      smtpUser,
      smtpPassEnc,
      verifiedAt: null,
    },
    update: {
      fromName,
      email,
      smtpHost,
      smtpPort,
      smtpUser,
      smtpPassEnc,
      ...(credentialsChanged ? { verifiedAt: null } : {}),
    },
    select: {
      userId: true,
      fromName: true,
      email: true,
      smtpHost: true,
      smtpPort: true,
      smtpUser: true,
      verifiedAt: true,
    },
  });

  return NextResponse.json({ account: { ...account, hasPassword: true } });
}
