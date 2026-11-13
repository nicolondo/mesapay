import { adminWalletApi, walletResponse } from "@/lib/platformWallet/api";
import { activeAccount, credentials } from "@/lib/platformWallet/config";
import { walletBalance } from "@/lib/platformWallet/provider";
export const GET = adminWalletApi(async () => {
  const account = await activeAccount();
  const balance = await walletBalance(credentials(account));
  return walletResponse({ accountId: account.id, ...balance, currency: "COP", queriedAt: new Date().toISOString() });
});
