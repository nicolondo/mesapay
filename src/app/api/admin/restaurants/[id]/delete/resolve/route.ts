import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getDeletionPreview } from "@/lib/restaurantDeletion";
import { BLOCKER_ACTIONS } from "@/lib/restaurantDeletion/resolution";
import {
  cancelOpenPaymentLinks,
  cancelSubscriptionDebit,
  declinePendingPaymentRequests,
} from "@/lib/restaurantDeletion/resolve";
import { requirePlatformAdmin } from "../guard";

export const dynamic = "force-dynamic";

/**
 * Resolver un bloqueo de "Eliminar comercio" desde el mismo diálogo, sin
 * entrar como el comercio (src/lib/restaurantDeletion/resolve.ts).
 *
 *   POST { action } → corre la acción, deja auditoría y devuelve el resumen
 *   recalculado (conteos, bloqueos y avisos) para que el diálogo se recargue.
 *
 * Sólo platform_admin. Ninguna acción borra nada ni relaja las guardas del
 * borrado: ../route.ts vuelve a validar todo dentro de su transacción.
 */
const bodySchema = z.object({ action: z.enum(BLOCKER_ACTIONS) });

async function POSTHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { session, denied } = await requirePlatformAdmin();
  if (!session) return denied;
  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const restaurant = await db.restaurant.findUnique({ where: { id }, select: { id: true } });
  if (!restaurant) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const actor = { id: session.user.id ?? null, email: session.user.email ?? "", role: session.user.role };
  const action = parsed.data.action;

  let failure: { error: string; detail?: string } | null = null;
  let result: Record<string, number | boolean> = {};
  if (action === "decline_pending_payments") {
    result = await declinePendingPaymentRequests(id, actor);
  } else if (action === "cancel_payment_links") {
    result = await cancelOpenPaymentLinks(id, actor);
  } else {
    const outcome = await cancelSubscriptionDebit(id, actor);
    // `providerUnknown`: Kushki no conocía la suscripción (K012 / 404) y se
    // marcó cancelada sólo en MESAPAY; el diálogo lo avisa.
    if (outcome.ok) result = { alreadyCanceled: outcome.alreadyCanceled, providerUnknown: outcome.providerUnknown };
    else failure = { error: outcome.error, detail: outcome.detail };
  }

  // Con éxito o sin él, el diálogo se recarga con lo que quedó.
  const preview = await getDeletionPreview(id);
  const headers = { "Cache-Control": "no-store" };
  if (failure) {
    return NextResponse.json(
      { ok: false, action, error: "subscription_cancel_failed", reason: failure.error, detail: failure.detail, preview },
      { status: 502, headers },
    );
  }
  return NextResponse.json({ ok: true, action, result, preview }, { headers });
}

export const POST = secureApi(POSTHandler);
