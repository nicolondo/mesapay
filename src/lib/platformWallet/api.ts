import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { secureApi } from "@/lib/secureApi";
import { rateLimit } from "@/lib/rateLimit";
import { WalletError } from "./errors";
import type { WalletActor } from "./config";

export function walletResponse(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
export function adminWalletApi<Args extends unknown[]>(handler: (req: Request, actor: WalletActor, ...args: Args) => Promise<Response>) {
  return secureApi(async (req: Request, ...args: Args) => {
    const session = await auth();
    if (!session?.user?.id || session.user.role !== "platform_admin") return walletResponse({ error: "unauthorized" }, 401);
    if (!await rateLimit(`platform-wallet:${session.user.id}:${new URL(req.url).pathname}`, req.method === "GET" ? 60 : 30, 60)) return walletResponse({ error: "rate_limited" }, 429);
    try { return await handler(req, { id: session.user.id, email: session.user.email ?? "" }, ...args); }
    catch (error) {
      if (error instanceof WalletError) return walletResponse({ error: error.code }, error.status);
      throw error;
    }
  });
}
/** Read bounded bodies, including chunked requests without Content-Length. */
export async function walletJson(req: Request, maxBytes = 16_384): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) throw new WalletError("invalid_payload", 400);
  let count = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > maxBytes) { await reader.cancel(); throw new WalletError("invalid_payload", 413); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof WalletError) throw error;
    throw new WalletError("invalid_payload", 400);
  } finally { reader.releaseLock(); }
}
