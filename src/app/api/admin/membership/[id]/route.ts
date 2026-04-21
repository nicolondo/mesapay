import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { extendOneMonth } from "@/lib/membership";

const planSchema = z.object({
  action: z.literal("set_plan"),
  plan: z.enum(["trial", "basic", "pro"]),
  monthlyPriceCents: z.number().int().min(0).max(10_000_000),
});

const suspendSchema = z.object({
  action: z.literal("set_suspended"),
  suspended: z.boolean(),
});

const paymentSchema = z.object({
  action: z.literal("record_payment"),
  amountCents: z.number().int().min(0).max(100_000_000),
  method: z.enum(["manual_cash", "manual_transfer", "wompi"]),
  note: z.string().trim().max(240).optional(),
});

const bodySchema = z.discriminatedUnion("action", [
  planSchema,
  suspendSchema,
  paymentSchema,
]);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "platform_admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const rest = await db.restaurant.findUnique({ where: { id } });
  if (!rest) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  if (parsed.data.action === "set_plan") {
    await db.restaurant.update({
      where: { id },
      data: {
        plan: parsed.data.plan,
        monthlyPriceCents: parsed.data.monthlyPriceCents,
      },
    });
    return NextResponse.json({ ok: true });
  }

  if (parsed.data.action === "set_suspended") {
    await db.restaurant.update({
      where: { id },
      data: { suspended: parsed.data.suspended },
    });
    return NextResponse.json({ ok: true });
  }

  // record_payment
  const { periodStart, periodEnd } = extendOneMonth(rest.periodEndsAt ?? null);
  await db.$transaction([
    db.membershipPayment.create({
      data: {
        restaurantId: id,
        amountCents: parsed.data.amountCents,
        method: parsed.data.method,
        note: parsed.data.note ?? null,
        periodStart,
        periodEnd,
        recordedByEmail: session.user.email,
      },
    }),
    db.restaurant.update({
      where: { id },
      data: {
        periodEndsAt: periodEnd,
        // Auto-unsuspend on fresh payment.
        suspended: false,
      },
    }),
  ]);

  return NextResponse.json({ ok: true });
}
