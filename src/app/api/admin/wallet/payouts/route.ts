import { z } from "zod";
import { db } from "@/lib/db";
import { adminWalletApi, walletJson, walletResponse } from "@/lib/platformWallet/api";
import { submitPlatformPayout, payoutDTO } from "@/lib/platformWallet/service";
import { WalletError } from "@/lib/platformWallet/errors";
export const GET = adminWalletApi(async (req) => {
  const params = new URL(req.url).searchParams;
  const key = params.get("idempotencyKey");
  if (key !== null) {
    if (!z.string().uuid().safeParse(key).success) throw new WalletError("invalid_payload", 400);
    const payout = await db.platformPayout.findUnique({ where: { idempotencyKey: key }, include: { account: true } });
    return walletResponse({ payouts: payout ? [payoutDTO(payout)] : [], nextCursor: null });
  }
  const cursor = params.get("cursor");
  if (cursor && (cursor.length > 100 || !await db.platformPayout.findUnique({ where: { id: cursor }, select: { id: true } }))) throw new WalletError("invalid_cursor", 400);
  const rows = await db.platformPayout.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 21,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), include: { account: true } });
  return walletResponse({ payouts: rows.slice(0, 20).map(payoutDTO), nextCursor: rows.length > 20 ? rows[19].id : null });
});
export const POST = adminWalletApi(async (req, actor) => walletResponse({ payout: await submitPlatformPayout(await walletJson(req), actor) }));
