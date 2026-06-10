import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auditLog";
import { fmtCOP } from "@/lib/format";
import type { CommissionStatus, Prisma } from "@prisma/client";

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const session = await auth();
  if (session?.user?.role !== "platform_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const statusParam = searchParams.get("status") ?? undefined;
  const salesRepUserId = searchParams.get("salesRepUserId") ?? undefined;
  const monthParam = searchParams.get("month") ?? undefined; // "YYYY-MM"

  // Build status filter.
  const statusFilter: CommissionStatus | undefined =
    statusParam === "pending" ||
    statusParam === "paid" ||
    statusParam === "reversed"
      ? (statusParam as CommissionStatus)
      : undefined;

  // Build date range from month param.
  let createdAtFilter: Prisma.CommissionEntryWhereInput["createdAt"] = undefined;
  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    const [year, month] = monthParam.split("-").map(Number);
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 1));
    createdAtFilter = { gte: start, lt: end };
  }

  const where: Prisma.CommissionEntryWhereInput = {
    ...(statusFilter !== undefined && { status: statusFilter }),
    ...(salesRepUserId && { salesRepUserId }),
    ...(createdAtFilter !== undefined && { createdAt: createdAtFilter }),
  };

  const [entries, aggregate] = await Promise.all([
    db.commissionEntry.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 500,
      include: {
        restaurant: { select: { id: true, name: true, slug: true } },
        salesRep: { select: { id: true, email: true, name: true } },
        membershipPayment: { select: { periodStart: true, periodEnd: true } },
      },
    }),
    db.commissionEntry.groupBy({
      by: ["status"],
      where,
      _sum: { amountCents: true },
    }),
  ]);

  // Build totals.
  let pendingCents = 0;
  let paidCents = 0;
  for (const row of aggregate) {
    if (row.status === "pending") pendingCents = row._sum?.amountCents ?? 0;
    if (row.status === "paid") paidCents = row._sum?.amountCents ?? 0;
  }

  return NextResponse.json({ entries, totals: { pendingCents, paidCents } });
}

// ── POST ─────────────────────────────────────────────────────────────────────

const markPaidSchema = z.object({
  action: z.literal("mark_paid"),
  ids: z.array(z.string().min(1)).min(1).max(200),
  paidNote: z.string().max(240).optional(),
});

const reverseSchema = z.object({
  action: z.literal("reverse"),
  ids: z.array(z.string().min(1)).min(1).max(200),
});

const bodySchema = z.discriminatedUnion("action", [markPaidSchema, reverseSchema]);

export async function POST(req: Request) {
  const session = await auth();
  if (session?.user?.role !== "platform_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const body = parsed.data;

  if (body.action === "mark_paid") {
    const { ids, paidNote } = body;

    // Fetch matching pending entries for amount total and audit summary.
    const entries = await db.commissionEntry.findMany({
      where: { id: { in: ids }, status: "pending" },
      select: { id: true, amountCents: true },
    });

    const result = await db.commissionEntry.updateMany({
      where: { id: { in: ids }, status: "pending" },
      data: {
        status: "paid",
        paidAt: new Date(),
        ...(paidNote !== undefined && { paidNote }),
      },
    });

    const totalCents = entries.reduce((s, e) => s + e.amountCents, 0);
    const summary = `Marcó ${result.count} comisión(es) como pagadas · total ${fmtCOP(totalCents)}${paidNote ? ` · nota: ${paidNote}` : ""}`;

    await recordAuditEvent({
      kind: "commission.mark_paid",
      restaurantId: null,
      summary,
    });

    return NextResponse.json({ ok: true, updated: result.count });
  }

  // action === "reverse"
  const { ids } = body;

  const entries = await db.commissionEntry.findMany({
    where: { id: { in: ids }, status: { in: ["pending", "paid"] } },
    select: { id: true, amountCents: true },
  });

  const result = await db.commissionEntry.updateMany({
    where: { id: { in: ids }, status: { in: ["pending", "paid"] } },
    data: { status: "reversed" },
  });

  const totalCents = entries.reduce((s, e) => s + e.amountCents, 0);
  const summary = `Reversó ${result.count} comisión(es) · total ${fmtCOP(totalCents)}`;

  await recordAuditEvent({
    kind: "commission.reverse",
    restaurantId: null,
    summary,
  });

  return NextResponse.json({ ok: true, updated: result.count });
}
