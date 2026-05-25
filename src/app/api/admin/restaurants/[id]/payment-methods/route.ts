import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import {
  PAYMENT_METHOD_SLUGS,
  resolveEnabledPaymentMethods,
  type PaymentMethodSlug,
} from "@/lib/paymentMethods";

export const dynamic = "force-dynamic";

const slugSchema = z.enum(PAYMENT_METHOD_SLUGS as [PaymentMethodSlug, ...PaymentMethodSlug[]]);

const putBody = z.object({
  // Whole-list replace — matches the toggle UX on the admin card.
  methods: z.array(slugSchema),
});

function guard(role?: string) {
  return role === "platform_admin";
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const r = await db.restaurant.findUnique({
    where: { id },
    select: { enabledPaymentMethods: true },
  });
  if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({
    methods: resolveEnabledPaymentMethods(r.enabledPaymentMethods),
  });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const body = await req.json().catch(() => null);
  const parsed = putBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  // De-dupe defensively in case the client sends repeats.
  const methods = Array.from(new Set(parsed.data.methods));

  const updated = await db.restaurant.update({
    where: { id },
    data: { enabledPaymentMethods: methods as unknown as object },
    select: { enabledPaymentMethods: true },
  });

  return NextResponse.json({
    ok: true,
    methods: resolveEnabledPaymentMethods(updated.enabledPaymentMethods),
  });
}
