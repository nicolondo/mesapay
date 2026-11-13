import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import { env } from "@/lib/env";
import { WalletError } from "@/lib/platformWallet/errors";
import { merchantWalletContext, merchantWalletLock } from "./context";
import { merchantBanks, tokenizeMerchantPayout, initializePayout, definiteInitRejection } from "./provider";
import { merchantPayloadFingerprint, merchantPayoutSchema } from "./validation";
import { merchantPayoutDTO } from "./dto";
import { readOwnDestination, ownDestinationFingerprint } from "./ownDestination";

type Actor = { id: string; email: string; role: string };
async function latest(id: string) {
  const row = await db.payout.findUnique({ where: { id } });
  if (!row) throw new WalletError("payout_not_found", 404);
  return merchantPayoutDTO(row);
}
async function failBeforeInit(id: string, code: string) {
  await db.payout.updateMany({ where: { id, status: "submitting", initStartedAt: null }, data: { status: "failed", responseText: code, settledAt: new Date() } });
  return latest(id);
}
function normalizeBank(name: string) {
  return name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\bbanco\b/g, "").replace(/[^a-z0-9]/g, "");
}

export async function submitMerchantPayout(restaurantId: string, raw: unknown, actor: Actor) {
  const parsed = merchantPayoutSchema.safeParse(raw);
  if (!parsed.success) throw new WalletError("invalid_payload", 400);
  const input = parsed.data;
  if (input.restaurantId !== restaurantId) throw new WalletError("tenant_changed");
  const fingerprint = merchantPayloadFingerprint(input);
  const reservation = await db.$transaction(async (tx) => {
    await merchantWalletLock(tx, restaurantId);
    const existing = await tx.payout.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) {
      if (existing.restaurantId !== restaurantId || existing.payloadFingerprint !== fingerprint) throw new WalletError("idempotency_conflict");
      return { payout: existing };
    }
    if (await tx.payout.findFirst({ where: { restaurantId, status: { in: ["submitting", "unknown"] } }, select: { id: true } })) throw new WalletError("payout_in_progress");
    const context = await merchantWalletContext(restaurantId);
    if (!input.destination && ownDestinationFingerprint(context.bankInfo) !== input.ownDestinationFingerprint) throw new WalletError("own_destination_changed");
    const destination = input.destination ?? readOwnDestination(context.bankInfo);
    const payout = await tx.payout.create({ data: {
      restaurantId, idempotencyKey: input.idempotencyKey, payloadFingerprint: fingerprint,
      walletAccountFingerprint: context.fingerprint, sourceMode: context.credentials.mode,
      amountCents: input.amountCents, currency: context.currency, toOwnAccount: !input.destination,
      bankName: destination.bankName, bankId: input.destination?.bankId ?? null, accountType: destination.accountType,
      accountLast4: destination.accountNumber.slice(-4), holderName: destination.holderName,
      status: "submitting", reference: `mp-${randomUUID()}`, createdByEmail: actor.email,
      submissionLeaseUntil: new Date(Date.now() + 120_000), webhookSecretEnc: encrypt(randomBytes(32).toString("hex")),
    } });
    await tx.auditEvent.create({ data: { restaurantId, actorUserId: actor.id, actorEmail: actor.email, actorRole: actor.role,
      kind: "wallet.payout.submit", targetType: "payout", targetId: payout.id, summary: "Kushki", diff: { after: { amountCents: input.amountCents, currency: context.currency } } } });
    return { payout, context, destination };
  });
  const { payout } = reservation;
  if (!reservation.context || !reservation.destination) return merchantPayoutDTO(payout);
  const { context } = reservation;
  let destination = reservation.destination;
  let callbackUrl: string;
  let secret: string;
  try {
    secret = decrypt(payout.webhookSecretEnc!);
    const base = new URL(env.APP_PUBLIC_BASE_URL ?? "https://mesapay.co");
    if (base.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(base.hostname)) throw new WalletError("credentials_unavailable", 503);
    const callback = new URL("/api/webhooks/kushki-payout", base); callback.searchParams.set("payoutId", payout.id); callbackUrl = callback.toString();
    const banks = await merchantBanks(context.credentials);
    const want = normalizeBank(destination.bankName);
    const exact = banks.filter((b) => normalizeBank(b.name) === want);
    const matches = input.destination ? banks.filter((b) => b.id === destination.bankId) : exact.length ? exact
      : banks.filter((b) => { const name = normalizeBank(b.name); return !!name && !!want && (name.includes(want) || want.includes(name)); });
    if (matches.length !== 1) throw new WalletError("invalid_bank", 400);
    destination = { ...destination, bankId: matches[0].id, bankName: matches[0].name };
    await db.payout.updateMany({ where: { id: payout.id, status: "submitting", initStartedAt: null }, data: { bankId: destination.bankId, bankName: destination.bankName } });
  } catch (error) { return failBeforeInit(payout.id, error instanceof WalletError ? error.code : "payout_preparation_failed"); }
  let token: string;
  try { token = await tokenizeMerchantPayout(context.credentials, { amountCents: input.amountCents, currency: context.currency, reference: payout.reference!, destination }); }
  catch { return failBeforeInit(payout.id, "payout_token_failed"); }
  try {
    const current = await merchantWalletContext(restaurantId);
    if (current.fingerprint !== context.fingerprint || current.currency !== context.currency) throw new WalletError("account_changed");
    if (!input.destination && ownDestinationFingerprint(current.bankInfo) !== input.ownDestinationFingerprint) throw new WalletError("own_destination_changed");
  } catch (error) { return failBeforeInit(payout.id, error instanceof WalletError ? error.code : "credentials_unavailable"); }
  const now = new Date();
  const claimed = await db.payout.updateMany({ where: { id: payout.id, status: "submitting", initStartedAt: null, submissionLeaseUntil: { gt: now } }, data: { initStartedAt: now } });
  if (!claimed.count) return latest(payout.id);
  try {
    const result = await initializePayout(context.credentials, { token, amountCents: input.amountCents, reference: payout.reference!, webhookUrl: callbackUrl, webhookSecret: secret });
    await db.payout.updateMany({ where: { id: payout.id, status: "submitting" }, data: { status: "initialized", ...result, responseText: null } });
  } catch (error) {
    const rejected = definiteInitRejection(error);
    await db.payout.updateMany({ where: { id: payout.id, status: "submitting" }, data: { status: rejected ? "failed" : "unknown",
      responseText: rejected ? "payout_rejected" : "payout_unknown", ...(rejected ? { settledAt: new Date() } : {}) } });
  }
  return latest(payout.id);
}
