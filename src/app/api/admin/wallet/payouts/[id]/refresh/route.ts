import { z } from "zod";
import { adminWalletApi, walletResponse, walletJson } from "@/lib/platformWallet/api";
import { refreshPlatformPayout } from "@/lib/platformWallet/status";
import { WalletError } from "@/lib/platformWallet/errors";
export const POST = adminWalletApi(async (req, _actor, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const parsed = z.object({ ticketNumber: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional() }).strict().safeParse(req.body ? await walletJson(req) : {});
  if (!parsed.success) throw new WalletError("invalid_payload", 400);
  return walletResponse({ payout: await refreshPlatformPayout(id, undefined, parsed.data.ticketNumber) });
});
