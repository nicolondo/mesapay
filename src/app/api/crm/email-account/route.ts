import { NextResponse } from "next/server";
import { z } from "zod";
import { getCrmContext } from "@/lib/crm/access";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto";

const PutSchema = z.object({
  fromName: z.string().min(1),
  email: z.string().email(),
  smtpHost: z.string().min(1),
  smtpPort: z.number().int().min(1).max(65535),
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

  const existing = await db.crmEmailAccount.findUnique({
    where: { userId: ctx.userId },
    select: { smtpPassEnc: true },
  });

  // Credentials changed → reset verifiedAt
  const credentialsChanged =
    smtpPass !== undefined ||
    (existing &&
      (existing.smtpPassEnc === undefined || smtpHost || smtpUser || email));

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

  // Reset verifiedAt when smtp credentials actually change
  const shouldResetVerified = smtpPass !== undefined || !existing;

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
      ...(shouldResetVerified ? { verifiedAt: null } : {}),
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

  // suppress unused var warning
  void credentialsChanged;

  return NextResponse.json({ account: { ...account, hasPassword: true } });
}
