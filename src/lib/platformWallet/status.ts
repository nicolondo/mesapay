import "server-only";
import { db } from "@/lib/db";
import { credentials, webhookSecret } from "./config";
import { WalletError } from "./errors";
import { queryPayout } from "./provider";
import { statusMatches, terminalStatus, verifyWebhookToken } from "./validation";
import { payoutDTO } from "./service";

export async function authorizePlatformWebhook(id: string, authorization: string | null) {
  const payout = await db.platformPayout.findUnique({ where: { id }, include: { account: true } });
  if (!payout || !verifyWebhookToken(authorization, webhookSecret(payout.account))) throw new WalletError("invalid_webhook", 401);
}

export async function refreshPlatformPayout(id: string, callback?: { authorization: string | null; ticket: string | null }, manualTicket?: string) {
  const payout = await db.platformPayout.findUnique({ where: { id }, include: { account: true } });
  if (!payout) throw new WalletError(callback ? "invalid_webhook" : "payout_not_found", callback ? 401 : 404);
  if (callback && !verifyWebhookToken(callback.authorization, webhookSecret(payout.account))) throw new WalletError("invalid_webhook", 401);
  if (["approved", "declined", "failed"].includes(payout.status)) return payoutDTO(payout);
  if (payout.status === "submitting" && !payout.initStartedAt && payout.submissionLeaseUntil.getTime() <= Date.now()) {
    const expired = await db.platformPayout.updateMany({ where: { id, status: "submitting", initStartedAt: null,
      submissionLeaseUntil: { lte: new Date() } }, data: { status: "failed", errorCode: "payout_not_sent", settledAt: new Date() } });
    if (expired.count) return payoutDTO(await db.platformPayout.findUniqueOrThrow({ where: { id }, include: { account: true } }));
    // Another worker claimed init at the same time; its state must be re-read.
    return refreshPlatformPayout(id, callback, manualTicket);
  }
  const ticket = payout.ticketNumber ?? callback?.ticket ?? manualTicket;
  if (!ticket) throw new WalletError("payout_status_unavailable");
  if (callback?.ticket && payout.ticketNumber && callback.ticket !== payout.ticketNumber) throw new WalletError("payout_status_mismatch");
  if (manualTicket && payout.ticketNumber && manualTicket !== payout.ticketNumber) throw new WalletError("payout_status_mismatch");
  const verified = await queryPayout(credentials(payout.account), ticket);
  if (verified.ticketNumber !== ticket || !statusMatches(payout, verified)) throw new WalletError("payout_status_mismatch");
  const status = terminalStatus(verified.transactionStatus);
  if (!status) throw new WalletError("payout_status_unavailable", 502);
  await db.$transaction(async (tx) => {
    // Init may have persisted identifiers during the remote GET. Lock/re-read
    // and compare again so the only final callback cannot be acknowledged lost.
    await tx.$queryRaw`SELECT "id" FROM "PlatformPayout" WHERE "id" = ${id} FOR UPDATE`;
    const current = await tx.platformPayout.findUniqueOrThrow({ where: { id } });
    if (!statusMatches(current, verified)) throw new WalletError("payout_status_mismatch");
    if (["approved", "declined", "failed"].includes(current.status)) return;
    await tx.platformPayout.update({
      where: { id },
      data: { status, ticketNumber: verified.ticketNumber, providerRef: verified.transactionReference, errorCode: null,
        ...(status === "initialized" ? {} : { settledAt: new Date() }) },
    });
    await tx.auditEvent.create({ data: { actorEmail: "system", actorRole: "system", kind: "platform.wallet.payout.status", targetType: "platform_payout", targetId: id, summary: "Kushki", diff: { after: { status } } } });
  });
  const final = await db.platformPayout.findUniqueOrThrow({ where: { id }, include: { account: true } });
  return payoutDTO(final);
}
