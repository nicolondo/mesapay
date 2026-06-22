import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import {
  getKushkiMode,
  setKushkiMode,
  getBillingCredentials,
  setBillingCredentials,
  type KushkiMode,
} from "@/lib/platformConfig";
import { recordAuditEvent } from "@/lib/auditLog";

/**
 * Configuración plataforma. Sólo platform_admin puede leer/editar.
 *
 * Expone:
 *   - kushkiMode (mock/sandbox/production)
 *   - kushkiBillingPublicKey (valor resuelto: DB o env)
 *   - hasBillingPrivateKey (bool — NUNCA el valor)
 */

const patchSchema = z.object({
  kushkiMode: z.enum(["mock", "sandbox", "production"]).optional(),
  kushkiBillingPublicKey: z.string().optional(),
  kushkiBillingPrivateKey: z.string().optional(),
});

export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "platform_admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const [kushkiMode, billing] = await Promise.all([
    getKushkiMode(),
    getBillingCredentials(),
  ]);
  return NextResponse.json({
    kushkiMode,
    kushkiBillingPublicKey: billing.publicKey,
    // hasBillingPrivateKey: true when a key is configured (DB or env).
    // The private key itself is NEVER returned.
    hasBillingPrivateKey: billing.privateKey !== null,
  });
}

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "platform_admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const actorId = session.user.id ?? null;

  // --- Kushki mode ---
  const before = await getKushkiMode();
  if (parsed.data.kushkiMode && parsed.data.kushkiMode !== before) {
    const next: KushkiMode = parsed.data.kushkiMode;
    await setKushkiMode(next, actorId);
    await recordAuditEvent({
      kind: "platform.kushki_mode.update",
      restaurantId: null,
      target: { type: "platform_config" },
      summary: `Cambió KUSHKI_MODE de ${before} a ${next}`,
      diff: {
        before: { kushkiMode: before },
        after: { kushkiMode: next },
      },
    });
  }

  // --- Billing credentials ---
  const wantsPublicKey = parsed.data.kushkiBillingPublicKey !== undefined;
  const wantsPrivateKey =
    parsed.data.kushkiBillingPrivateKey !== undefined &&
    parsed.data.kushkiBillingPrivateKey.trim().length > 0;

  if (wantsPublicKey || wantsPrivateKey) {
    await setBillingCredentials(
      {
        ...(wantsPublicKey && { publicKey: parsed.data.kushkiBillingPublicKey }),
        ...(wantsPrivateKey && { privateKey: parsed.data.kushkiBillingPrivateKey }),
      },
      actorId,
    );
    // Audit — summary MUST NOT contain key material.
    await recordAuditEvent({
      kind: "platform.kushki_billing.update",
      restaurantId: null,
      target: { type: "platform_config" },
      summary: "Actualizó credenciales de cobro Kushki",
    });
  }

  // Return the updated state (never the private key).
  const billing = await getBillingCredentials();
  return NextResponse.json({
    ok: true,
    kushkiMode: parsed.data.kushkiMode ?? before,
    kushkiBillingPublicKey: billing.publicKey,
    hasBillingPrivateKey: billing.privateKey !== null,
  });
}



