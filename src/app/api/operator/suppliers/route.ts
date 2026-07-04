import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { normalizePhone } from "@/lib/crm/phone";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["purchasing"];

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  taxId: z.string().trim().max(40).nullable().optional(),
  contactName: z.string().trim().max(120).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().email().nullable().optional().or(z.literal("")),
  address: z.string().trim().max(300).nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export async function GET() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const suppliers = await db.supplier.findMany({
    where: { restaurantId: ctx.restaurantId },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: { _count: { select: { items: true } } },
  });
  return NextResponse.json({ suppliers });
}

export async function POST(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;
  const dup = await db.supplier.findUnique({
    where: {
      restaurantId_name: { restaurantId: ctx.restaurantId, name: b.name },
    },
    select: { id: true },
  });
  if (dup) {
    return NextResponse.json({ error: "name_taken" }, { status: 409 });
  }
  const supplier = await db.supplier.create({
    data: {
      restaurantId: ctx.restaurantId,
      name: b.name,
      taxId: b.taxId || null,
      contactName: b.contactName || null,
      // Mismo normalizador E.164 del CRM, con el país del comercio.
      phone: b.phone ? normalizePhone(b.phone, ctx.country ?? "CO") : null,
      email: b.email || null,
      address: b.address || null,
      paymentTermsDays: b.paymentTermsDays ?? null,
      notes: b.notes || null,
    },
  });
  return NextResponse.json({ supplier }, { status: 201 });
}
