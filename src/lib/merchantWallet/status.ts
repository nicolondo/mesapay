import "server-only";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { WalletError } from "@/lib/platformWallet/errors";
import { terminalStatus, verifyWebhookToken } from "@/lib/platformWallet/validation";
import { merchantWalletContext } from "./context";
import { queryPayout } from "./provider";
import { merchantStatusMatches } from "./validation";
import { merchantPayoutDTO } from "./dto";
import type { Payout } from "@prisma/client";

function webhookAuthorized(p: Payout | null, authorization: string | null) {
  if (!p?.webhookSecretEnc || !p.walletAccountFingerprint || !p.sourceMode || !p.idempotencyKey) return false;
  try { return verifyWebhookToken(authorization, decrypt(p.webhookSecretEnc)); } catch { return false; }
}
export async function authorizeMerchantWebhook(id: string, authorization: string | null) {
  const payout = await db.payout.findUnique({ where: { id } });
  if (!webhookAuthorized(payout, authorization)) throw new WalletError("invalid_webhook", 401);
  return payout!.restaurantId;
}
export async function refreshMerchantPayout(restaurantId: string, id: string, callback?: { authorization: string | null; ticket: string | null }) {
  const payout = await db.payout.findUnique({ where: { id } });
  if (!payout || payout.restaurantId !== restaurantId) throw new WalletError("payout_not_found", 404);
  if (callback && !webhookAuthorized(payout, callback.authorization)) throw new WalletError("invalid_webhook", 401);
  if (!payout.walletAccountFingerprint || !payout.sourceMode || !payout.idempotencyKey || !payout.webhookSecretEnc) throw new WalletError("payout_legacy_unverified");
  if (["approved", "declined", "failed"].includes(payout.status)) return merchantPayoutDTO(payout);
  if (payout.status === "submitting" && !payout.initStartedAt && payout.submissionLeaseUntil && payout.submissionLeaseUntil.getTime() <= Date.now()) {
    const expired = await db.payout.updateMany({ where: { id, status: "submitting", initStartedAt: null, submissionLeaseUntil: { lte: new Date() } }, data: { status: "failed", responseText: "payout_not_sent", settledAt: new Date() } });
    if (expired.count) return merchantPayoutDTO(await db.payout.findUniqueOrThrow({ where: { id } }));
    return refreshMerchantPayout(restaurantId, id, callback);
  }
  const ticket = payout.ticketNumber ?? callback?.ticket;
  if (!ticket || !payout.initStartedAt) throw new WalletError("payout_status_unavailable");
  if (callback?.ticket && payout.ticketNumber && callback.ticket !== payout.ticketNumber) throw new WalletError("payout_status_mismatch");
  const context = await merchantWalletContext(restaurantId);
  if (context.fingerprint !== payout.walletAccountFingerprint || context.credentials.mode !== payout.sourceMode || context.currency !== payout.currency) throw new WalletError("account_changed");
  const verified = await queryPayout(context.credentials, ticket);
  if (verified.ticketNumber !== ticket || !merchantStatusMatches(payout, verified)) throw new WalletError("payout_status_mismatch");
  const status = terminalStatus(verified.transactionStatus);
  if (!status) throw new WalletError("payout_status_unavailable", 502);
  const currentContext = await merchantWalletContext(restaurantId);
  if (currentContext.fingerprint !== context.fingerprint || currentContext.currency !== payout.currency) throw new WalletError("account_changed");
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`merchant-wallet:${restaurantId}`}))::text`;
    await tx.$queryRaw`SELECT "id" FROM "Payout" WHERE "id" = ${id} FOR UPDATE`;
    const current = await tx.payout.findUniqueOrThrow({ where: { id } });
    if (!merchantStatusMatches(current, verified) || current.walletAccountFingerprint !== context.fingerprint || current.sourceMode !== context.credentials.mode) throw new WalletError("payout_status_mismatch");
    if (["approved", "declined", "failed"].includes(current.status)) return;
    const duplicate = await tx.payout.findFirst({ where: { restaurantId, id: { not: id }, walletAccountFingerprint: context.fingerprint,
      OR: [{ ticketNumber: verified.ticketNumber }, { providerRef: verified.transactionReference }] }, select: { id: true } });
    if (duplicate) throw new WalletError("payout_status_mismatch");
    if (current.status === status && current.ticketNumber === verified.ticketNumber && current.providerRef === verified.transactionReference) return;
    await tx.payout.update({ where: { id }, data: { status, ticketNumber: verified.ticketNumber, providerRef: verified.transactionReference, responseText: null,
      ...(status === "initialized" ? {} : { providerVerifiedAt: new Date(), settledAt: new Date() }) } });
    await tx.auditEvent.create({ data: { restaurantId, actorEmail: "system", actorRole: "system", kind: "wallet.payout.status", targetType: "payout", targetId: id, summary: "Kushki", diff: { after: { status } } } });
  });
  return merchantPayoutDTO(await db.payout.findUniqueOrThrow({ where: { id } }));
}
