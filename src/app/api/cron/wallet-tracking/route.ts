import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { secureApi } from "@/lib/secureApi";
import { runWalletTrackingBatch } from "@/lib/walletTracking/service";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const POST = secureApi(async (req: Request) => {
  const expected = process.env.CRON_SECRET ?? "";
  const supplied = req.headers.get("x-cron-secret") ?? "";
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  const headers = { "Cache-Control": "no-store" };
  if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  try {
    return NextResponse.json({ ok: true, ...await runWalletTrackingBatch() }, { headers });
  } catch {
    return NextResponse.json({ error: "tracking_unavailable" }, { status: 503, headers });
  }
});
