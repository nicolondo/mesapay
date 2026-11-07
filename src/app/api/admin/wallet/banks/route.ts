import { adminWalletApi, walletResponse } from "@/lib/platformWallet/api";
import { activeAccount, credentials } from "@/lib/platformWallet/config";
import { walletBanks } from "@/lib/platformWallet/provider";
export const GET = adminWalletApi(async () => {
  const account = await activeAccount();
  return walletResponse({ accountId: account.id, banks: await walletBanks(credentials(account)) });
});
