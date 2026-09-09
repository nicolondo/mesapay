import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * Health check for the blue/green deploy script. We accept "alive" if
 * the Node process is up AND we can round-trip a trivial query to
 * Postgres. The activate.sh script polls this endpoint after starting
 * the inactive color and waits for 200 before swapping nginx traffic.
 *
 * Kept cheap on purpose — no auth, no real work — so the check can
 * fire every second during the wait window without warming up state
 * or polluting logs.
 */
export const dynamic = "force-dynamic";

async function GETHandler() {
  try {
    // Readiness requires the new columns and the database financial guard.
    await db.$queryRaw`SELECT "requestKey", "refundReservedCents" FROM "Payment" LIMIT 0`;
    await db.$queryRaw`SELECT "sessionVersion" FROM "User" LIMIT 0`;
    await db.$queryRaw`SELECT "stockConsumptionRetryAt" FROM "Order" LIMIT 0`;
    await db.$queryRaw`SELECT key FROM "FinancialOperation" LIMIT 0`;
    await db.$queryRaw`SELECT key FROM "RateLimitBucket" LIMIT 0`;
    const triggers = await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM pg_trigger WHERE tgname IN ('reserve_payment', 'revoke_sessions', 'order_event') AND tgenabled <> 'D'`;
    if (Number(triggers[0]?.count) !== 3) throw new Error("schema_not_ready");
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}

export const GET = secureApi(GETHandler);
