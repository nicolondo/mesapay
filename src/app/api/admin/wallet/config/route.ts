import { adminWalletApi, walletJson, walletResponse } from "@/lib/platformWallet/api";
import { readWalletConfig, saveWalletConfig } from "@/lib/platformWallet/config";
export const GET = adminWalletApi(async () => walletResponse(await readWalletConfig()));
export const PUT = adminWalletApi(async (req, actor) => walletResponse(await saveWalletConfig(await walletJson(req), actor)));
