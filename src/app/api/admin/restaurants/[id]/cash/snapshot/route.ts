import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { buildCashSnapshot } from "@/lib/cashBox";
import { resolveShiftPolicy } from "@/lib/staffPolicies";

/** Snapshot de caja en vivo de un comercio, desde el admin de plataforma. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "platform_admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const tenant = await db.restaurant.findUnique({
    where: { id },
    select: { id: true, shiftPolicy: true },
  });
  if (!tenant) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const snapshot = await buildCashSnapshot(
    id,
    resolveShiftPolicy(tenant.shiftPolicy),
  );
  return NextResponse.json(snapshot);
}
