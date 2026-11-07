import "server-only";
import { randomUUID } from "node:crypto";
import type { PlatformPayout, PlatformWalletAccount } from "@prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { credentials, webhookSecret, walletLock, type WalletActor } from "./config";
import { WalletError } from "./errors";
import { walletBalance, walletBanks, tokenizePayout, initializePayout, definiteInitRejection } from "./provider";
import { payoutSchema, payloadFingerprint, safeCents } from "./validation";
import type { PlatformPayoutDTO, WalletPayoutInput } from "./contracts";

export type PayoutWithAccount = PlatformPayout & { account: PlatformWalletAccount };
export function payoutDTO(p: PayoutWithAccount): PlatformPayoutDTO {
  return { id: p.id, idempotencyKey: p.idempotencyKey, accountId: p.accountId, accountLabel: p.account.label, mode: p.account.mode,
    amountCents: safeCents(p.amountCents), currency: "COP", bankName: p.bankName, accountType: p.accountType,
    accountLast4: p.accountLast4, holderName: p.holderName, description: p.description, status: p.status,
    ticketNumber: p.ticketNumber, providerRef: p.providerRef, reference: p.reference, errorCode: p.errorCode,
    createdAt: p.createdAt.toISOString(), settledAt: p.settledAt?.toISOString() ?? null };
}
async function reserve(input: WalletPayoutInput, actor: WalletActor) {
  const fingerprint = payloadFingerprint(input);
  return db.$transaction(async (tx) => {
    await walletLock(tx);
    const existing = await tx.platformPayout.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { account: true } });
    if (existing) {
      if (existing.payloadFingerprint !== fingerprint) throw new WalletError("idempotency_conflict");
      return { payout: existing, fresh: false };
    }
    const config = await tx.platformConfig.findUnique({ where: { id: "singleton" }, include: { platformWalletAccount: true } });
    if (!config?.platformWalletAccount) throw new WalletError("wallet_not_configured");
    if (config.platformWalletAccountId !== input.accountId) throw new WalletError("account_changed");
    // A possibly sent transfer blocks another submission even after a credential
    // rotation. Initialized transfers already have a provider receipt and debit.
    const uncertain = await tx.platformPayout.findFirst({ where: { status: { in: ["submitting", "unknown"] } }, select: { id: true } });
    if (uncertain) throw new WalletError("payout_in_progress");
    const payout = await tx.platformPayout.create({ data: {
      accountId: input.accountId, idempotencyKey: input.idempotencyKey, payloadFingerprint: fingerprint,
      amountCents: BigInt(input.amountCents), currency: "COP", bankId: input.destination.bankId,
      bankName: input.destination.bankId, accountType: input.destination.accountType, accountLast4: input.destination.accountNumber.slice(-4),
      holderName: input.destination.holderName, description: input.description || null, status: "submitting",
      reference: `mp-platform-${randomUUID()}`, createdById: actor.id, createdByEmail: actor.email,
      submissionLeaseUntil: new Date(Date.now() + 120_000),
    }, include: { account: true } });
    await tx.auditEvent.create({ data: { actorUserId: actor.id, actorEmail: actor.email, actorRole: "platform_admin", kind: "platform.wallet.payout.submit", targetType: "platform_payout", targetId: payout.id, summary: "Kushki", diff: { after: { accountId: input.accountId, amountCents: input.amountCents, currency: "COP" } } } });
    return { payout, fresh: true };
  });
}
async function latest(id: string) {
  const payout = await db.platformPayout.findUnique({ where: { id }, include: { account: true } });
  if (!payout) throw new WalletError("payout_not_found", 404);
  return payoutDTO(payout);
}
async function failBeforeInit(id: string, code: string) {
  await db.platformPayout.updateMany({ where: { id, status: "submitting" }, data: { status: "failed", errorCode: code, settledAt: new Date() } });
  return latest(id);
}
export async function submitPlatformPayout(raw: unknown, actor: WalletActor): Promise<PlatformPayoutDTO> {
  const parsed = payoutSchema.safeParse(raw);
  if (!parsed.success) throw new WalletError("invalid_payload", 400);
  const input = parsed.data;
  const { payout, fresh } = await reserve(input, actor);
  if (!fresh) return payoutDTO(payout);
  let account: ReturnType<typeof credentials>;
  let secret: string;
  let callbackUrl: string;
  try {
    account = credentials(payout.account); secret = webhookSecret(payout.account);
    const base = new URL(env.APP_PUBLIC_BASE_URL ?? "https://mesapay.co");
    if (base.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(base.hostname)) throw new WalletError("credentials_unavailable", 503);
    callbackUrl = new URL(`/api/webhooks/kushki-platform-payout/${payout.id}`, base).toString();
    const [balance, banks] = await Promise.all([walletBalance(account), walletBanks(account)]);
    if (balance.availableCents < input.amountCents) throw new WalletError("insufficient_funds");
    const bank = banks.find((entry) => entry.id === input.destination.bankId);
    if (!bank) throw new WalletError("invalid_bank", 400);
    await db.platformPayout.updateMany({ where: { id: payout.id, status: "submitting" }, data: { bankName: bank.name } });
  } catch (error) {
    return failBeforeInit(payout.id, error instanceof WalletError ? error.code : "credentials_unavailable");
  }
  let token: string;
  try { token = await tokenizePayout(account, input); }
  catch { return failBeforeInit(payout.id, "payout_token_failed"); }

  const now = new Date();
  const claimed = await db.platformPayout.updateMany({ where: { id: payout.id, status: "submitting", initStartedAt: null,
    submissionLeaseUntil: { gt: now } }, data: { initStartedAt: now } });
  if (!claimed.count) return latest(payout.id);
  try {
    const result = await initializePayout(account, { token, amountCents: input.amountCents,
      reference: payout.reference, webhookUrl: callbackUrl, webhookSecret: secret });
    // Callback may have settled this row while init was in flight. Never regress it.
    await db.platformPayout.updateMany({ where: { id: payout.id, status: "submitting" }, data: { status: "initialized", ...result, errorCode: null } });
  } catch (error) {
    const rejected = definiteInitRejection(error);
    await db.platformPayout.updateMany({ where: { id: payout.id, status: "submitting" }, data: {
      status: rejected ? "failed" : "unknown", errorCode: rejected ? "payout_rejected" : "payout_unknown", ...(rejected ? { settledAt: new Date() } : {}),
    } });
  }
  return latest(payout.id);
}
