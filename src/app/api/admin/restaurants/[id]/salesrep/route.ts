import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auditLog";

const schema = z.object({
  salesRepUserId: z.string().min(1).nullable(),
  salesRepCommissionBps: z.number().int().min(0).max(5000).nullable(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (session?.user?.role !== "platform_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const restaurant = await db.restaurant.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      salesRepUserId: true,
      salesRepCommissionBps: true,
    },
  });
  if (!restaurant) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { salesRepUserId, salesRepCommissionBps } = parsed.data;

  // Validate that the user exists and has role=comercial (when not null).
  let repEmail: string | null = null;
  let repName: string | null = null;
  if (salesRepUserId !== null) {
    const rep = await db.user.findUnique({
      where: { id: salesRepUserId },
      select: { id: true, email: true, name: true, role: true },
    });
    if (!rep) {
      return NextResponse.json({ error: "user_not_found" }, { status: 400 });
    }
    if (rep.role !== "comercial") {
      return NextResponse.json({ error: "not_comercial" }, { status: 400 });
    }
    repEmail = rep.email;
    repName = rep.name;
  }

  const before = {
    salesRepUserId: restaurant.salesRepUserId,
    salesRepCommissionBps: restaurant.salesRepCommissionBps,
  };

  await db.restaurant.update({
    where: { id },
    data: { salesRepUserId, salesRepCommissionBps },
  });

  const after = { salesRepUserId, salesRepCommissionBps };

  const isAssign = salesRepUserId !== null;
  const repLabel = repName ?? repEmail ?? salesRepUserId ?? "—";
  const bpsLabel =
    salesRepCommissionBps !== null
      ? `${salesRepCommissionBps} bps (${(salesRepCommissionBps / 100).toFixed(2)}%)`
      : "tasa por defecto";

  const summary = isAssign
    ? `Asignó comercial ${repLabel} (${repEmail}) al comercio "${restaurant.name}" · comisión: ${bpsLabel}`
    : `Quitó comercial del comercio "${restaurant.name}"`;

  await recordAuditEvent({
    kind: isAssign ? "commission.salesrep.assign" : "commission.salesrep.unassign",
    restaurantId: id,
    target: { type: "restaurant", id },
    summary,
    diff: { before, after },
  });

  return NextResponse.json({ ok: true });
}
