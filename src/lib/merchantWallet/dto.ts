import type { Payout } from "@prisma/client";

export function merchantPayoutDTO(p: Payout) {
  return { ok: true, payoutId: p.id, idempotencyKey: p.idempotencyKey, amountCents: p.amountCents,
    currency: p.currency, status: p.status, providerRef: p.providerRef,
    // Legacy responseText can contain raw provider data. Only this flow writes
    // sanitized codes, and legacy entries are never exposed through recovery.
    responseText: p.idempotencyKey ? p.responseText : null };
}
