import "server-only";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import { getBillingCredentials } from "@/lib/platformConfig";
import type { PlatformWalletAccount, Prisma } from "@prisma/client";
import { configSchema } from "./validation";
import { WalletError } from "./errors";
import type { WalletConfigDTO, WalletAccountDTO } from "./contracts";

export type WalletActor = { id: string; email: string };
export async function walletLock(tx: Prisma.TransactionClient) {
  // Serializes account changes and reservations across workers/releases.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('mesapay-platform-wallet'))::text`;
}
export function accountDTO(account: PlatformWalletAccount): WalletAccountDTO {
  return { id: account.id, label: account.label, mode: account.mode, publicKey: account.publicKey, hasPrivateKey: !!account.privateKeyEnc, createdAt: account.createdAt.toISOString() };
}
export async function activeAccount() {
  const config = await db.platformConfig.findUnique({ where: { id: "singleton" }, include: { platformWalletAccount: true } });
  if (!config?.platformWalletAccount) throw new WalletError("wallet_not_configured");
  return config.platformWalletAccount;
}
export function credentials(account: PlatformWalletAccount) {
  try {
    const privateKey = decrypt(account.privateKeyEnc);
    if (!privateKey) throw new Error("missing");
    return { mode: account.mode, publicKey: account.publicKey, privateKey };
  } catch { throw new WalletError("credentials_unavailable", 503); }
}
export function webhookSecret(account: PlatformWalletAccount) {
  try { return decrypt(account.webhookSecretEnc); }
  catch { throw new WalletError("credentials_unavailable", 503); }
}
export async function readWalletConfig(): Promise<WalletConfigDTO> {
  const [config, billing] = await Promise.all([
    db.platformConfig.findUnique({ where: { id: "singleton" }, include: { platformWalletAccount: true } }),
    getBillingCredentials(),
  ]);
  return { account: config?.platformWalletAccount ? accountDTO(config.platformWalletAccount) : null, billingConfigured: !!(billing.publicKey && billing.privateKey) };
}
export async function saveWalletConfig(input: unknown, actor: WalletActor): Promise<WalletConfigDTO> {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw new WalletError("invalid_payload", 400);
  const value = parsed.data;
  await db.$transaction(async (tx) => {
    await walletLock(tx);
    const current = await tx.platformConfig.findUnique({ where: { id: "singleton" }, include: { platformWalletAccount: true } });
    const old = current?.platformWalletAccount;
    const unchangedPair = old?.publicKey === value.publicKey && old.mode === value.mode;
    if (!value.privateKey && !unchangedPair) throw new WalletError("private_key_required", 400);
    let privateKeyEnc: string;
    let webhookSecretEnc: string;
    try {
      privateKeyEnc = value.privateKey ? encrypt(value.privateKey) : old!.privateKeyEnc;
      // Validate preserved ciphertext: never silently carry unreadable credentials.
      if (!value.privateKey) credentials(old!);
      webhookSecretEnc = encrypt(randomBytes(32).toString("hex"));
    } catch { throw new WalletError("credentials_unavailable", 503); }
    const account = await tx.platformWalletAccount.create({ data: { label: value.label, mode: value.mode, publicKey: value.publicKey,
      privateKeyEnc, webhookSecretEnc, createdById: actor.id, createdByEmail: actor.email } });
    await tx.platformConfig.upsert({ where: { id: "singleton" }, create: { id: "singleton", platformWalletAccountId: account.id, updatedById: actor.id }, update: { platformWalletAccountId: account.id, updatedById: actor.id } });
    await tx.auditEvent.create({ data: { actorUserId: actor.id, actorEmail: actor.email, actorRole: "platform_admin", kind: "platform.wallet.account.update", targetType: "platform_wallet_account", targetId: account.id, summary: "Kushki", diff: { after: { accountId: account.id, mode: account.mode } } } });
  });
  return readWalletConfig();
}
