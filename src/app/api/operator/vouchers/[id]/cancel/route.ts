import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";
import { cancelVoucher } from "@/lib/vouchers/issue";

export const dynamic = "force-dynamic";

/** Cancela UN bono sin uso. El de otro comercio responde 404. */
const GATE: ModuleSlug[] = ["vouchers"];

const STATUS: Record<string, number> = {
  not_found: 404,
  used: 409,
  not_active: 409,
};

async function POSTHandler(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const result = await cancelVoucher({ restaurantId: ctx.restaurantId, voucherId: id });
  if (result !== "ok") {
    return NextResponse.json({ error: result }, { status: STATUS[result] ?? 400 });
  }
  return NextResponse.json({ ok: true });
}

export const POST = secureApi(POSTHandler);
