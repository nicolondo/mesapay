import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["staff"];

/**
 * Punches pendientes de revisión de identidad: los que se hicieron MANUAL
 * con foto (la cámara funcionó pero el reconocimiento facial no matcheó).
 * El admin revisa que la foto concuerde con la persona.
 */
export async function GET() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const reviews = await db.staffShift.findMany({
    where: {
      restaurantId: ctx.restaurantId,
      reviewNeededAt: { not: null },
      reviewedAt: null,
    },
    orderBy: { reviewNeededAt: "desc" },
    take: 100,
    select: {
      id: true,
      date: true,
      reviewNeededAt: true,
      checkInAt: true,
      checkOutAt: true,
      checkInPhotoUrl: true,
      checkOutPhotoUrl: true,
      checkInMethod: true,
      checkOutMethod: true,
      employee: { select: { id: true, name: true, position: true } },
    },
  });
  return NextResponse.json({ reviews, count: reviews.length });
}
