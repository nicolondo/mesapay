import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["staff"];

/**
 * Roster del kiosko (C2 · D1): empleados activos con sus descriptores
 * faciales para el match LOCAL en el navegador. Solo tras el gate staff
 * — los descriptores son dato sensible y no salen de acá.
 */
export async function GET() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const employees = await db.employee.findMany({
    where: { restaurantId: ctx.restaurantId, active: true },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      position: true,
      faceDescriptors: true,
      faceConsentAt: true,
    },
  });
  return NextResponse.json({
    employees: employees.map((e) => ({
      id: e.id,
      name: e.name,
      position: e.position,
      // Sin consentimiento vigente no se expone el descriptor.
      faceDescriptors: e.faceConsentAt ? e.faceDescriptors : null,
    })),
  });
}
