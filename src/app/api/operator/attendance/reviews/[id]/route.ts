import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["staff"];

/** Marcar una revisión de identidad como revisada (la foto concuerda / el
 *  admin la verificó). Reclamo race-safe. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const session = await auth();
  const claimed = await db.staffShift.updateMany({
    where: {
      id,
      restaurantId: ctx.restaurantId,
      reviewNeededAt: { not: null },
      reviewedAt: null,
    },
    data: {
      reviewedAt: new Date(),
      reviewedByEmail: session?.user?.email ?? null,
    },
  });
  if (claimed.count === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
