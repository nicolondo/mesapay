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

export async function GET() {
  try {
    // SELECT 1 — cheapest round-trip that proves the connection pool
    // can talk to Postgres. If the schema is mid-migration this still
    // returns OK (we want green to be marked healthy as soon as it
    // can serve requests, which is the moment its Prisma client is
    // initialised).
    await db.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
