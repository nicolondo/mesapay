import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto";

const schema = z.object({
  // Empty string -> set field to null. Lets the admin clear a value.
  merchantId: z.string().trim().max(200).nullable(),
  publicKey: z.string().trim().max(500).nullable(),
  // Plaintext from the form. Encrypted before persisting. If omitted/null,
  // the stored key is untouched (so admins can update other fields without
  // re-entering the secret).
  privateKey: z.string().trim().max(500).nullable().optional(),
  // Webhook signing secret — Kushki firma cada webhook con HMAC-SHA256
  // usando este secreto. Misma política que la private key: cifrada
  // at-rest, write-only en el form, "" explícito limpia el valor.
  webhookSecret: z.string().trim().max(500).nullable().optional(),
  // Modo Kushki por comercio. null = hereda el modo global de plataforma.
  // "" del form también se trata como null (heredar).
  kushkiMode: z
    .enum(["mock", "sandbox", "production"])
    .nullable()
    .optional(),
  // 3DS en pagos con tarjeta del comensal (OTP del banco vía redirect).
  card3ds: z.boolean().optional(),
  onboardingStatus: z.enum([
    "not_started",
    "docs_uploaded",
    "submitted",
    "in_review",
    "active",
    "rejected",
    "suspended",
  ]),
  notes: z.string().trim().max(2000).nullable(),
});

/**
 * Platform-admin-only override for a restaurant's payment-provider config.
 *
 * Lets us patch in production credentials manually (e.g., when a merchant
 * was onboarded through Kushki's portal directly, not through our wizard),
 * or fix a wedged state — flip a stuck "submitted" back to "active", etc.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "platform_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const rest = await db.restaurant.findUnique({ where: { id } });
  if (!rest) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const wasActive = rest.kushkiOnboardingStatus === "active";
  const willBeActive = parsed.data.onboardingStatus === "active";

  const data: Record<string, unknown> = {
    kushkiMerchantId: parsed.data.merchantId,
    kushkiPublicKey: parsed.data.publicKey,
    kushkiOnboardingStatus: parsed.data.onboardingStatus,
    kushkiOnboardingNotes: parsed.data.notes,
  };
  // Modo por comercio: sólo lo tocamos si vino en el body. null = heredar
  // el modo global de plataforma.
  if (parsed.data.kushkiMode !== undefined) {
    data.kushkiMode = parsed.data.kushkiMode;
  }
  // 3DS de tarjeta del comensal: sólo si vino en el body.
  if (parsed.data.card3ds !== undefined) {
    data.kushkiCard3ds = parsed.data.card3ds;
  }
  // Stamp activatedAt the first time the merchant becomes active, but don't
  // overwrite an existing stamp if the admin toggles status around.
  if (willBeActive && !rest.kushkiActivatedAt) {
    data.kushkiActivatedAt = new Date();
  }
  // Only re-encrypt if a new private key was provided.
  if (parsed.data.privateKey !== undefined && parsed.data.privateKey !== null) {
    if (parsed.data.privateKey.length === 0) {
      data.kushkiPrivateKeyEnc = null;
    } else {
      try {
        data.kushkiPrivateKeyEnc = encrypt(parsed.data.privateKey);
      } catch (err) {
        return NextResponse.json(
          {
            error: "encrypt_failed",
            detail:
              err instanceof Error
                ? err.message.split("\n")[0]
                : "missing MESAPAY_SECRET_KEY",
          },
          { status: 500 },
        );
      }
    }
  }
  // Misma lógica para el webhook secret.
  if (
    parsed.data.webhookSecret !== undefined &&
    parsed.data.webhookSecret !== null
  ) {
    if (parsed.data.webhookSecret.length === 0) {
      data.kushkiWebhookSecretEnc = null;
    } else {
      try {
        data.kushkiWebhookSecretEnc = encrypt(parsed.data.webhookSecret);
      } catch (err) {
        return NextResponse.json(
          {
            error: "encrypt_failed",
            detail:
              err instanceof Error
                ? err.message.split("\n")[0]
                : "missing MESAPAY_SECRET_KEY",
          },
          { status: 500 },
        );
      }
    }
  }

  await db.restaurant.update({ where: { id }, data });

  return NextResponse.json({
    ok: true,
    flipped: !wasActive && willBeActive,
  });
}
