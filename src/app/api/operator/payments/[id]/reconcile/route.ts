import { z } from "zod";
import { NextResponse } from "next/server";
import { getActiveContext } from "@/lib/activeRestaurant";
import { OPERATOR_ROLES } from "@/lib/staffAccess";
import { secureApi } from "@/lib/secureApi";
import { reconcilePayment } from "@/lib/payments/reconciliation";

const schema = z.object({
  outcome: z.enum(["approved", "declined", "refunded", "not_refunded", "reviewed"]),
  providerRef: z.string().trim().min(3).max(200),
  evidence: z.string().trim().min(15).max(1000),
  verifiedWithProvider: z.literal(true),
});
async function POSTHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getActiveContext();
  if (!ctx?.restaurantId || !OPERATOR_ROLES.includes(ctx.session.user.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  const { id } = await params;
  const result = await reconcilePayment({ ...parsed.data, paymentId: id, restaurantId: ctx.restaurantId, actor: ctx.session.user });
  return NextResponse.json({ ok: true, alreadyResolved: result.alreadyResolved });
}
export const POST = secureApi(POSTHandler);
