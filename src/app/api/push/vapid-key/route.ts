import { NextResponse } from "next/server";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

// Public endpoint — the VAPID public key is meant to be exposed to
// browsers anyway (the service worker passes it to PushManager.subscribe).
// We expose via API rather than NEXT_PUBLIC_ env so the client doesn't
// have to know its own bundle constants and so we can rotate at runtime.
export async function GET() {
  const pub = env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!pub) {
    return NextResponse.json(
      { error: "push_not_configured" },
      { status: 503 },
    );
  }
  return NextResponse.json({ publicKey: pub });
}
