import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { normalizePhone } from "@/lib/crm/phone";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["purchasing"];

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  taxId: z.string().trim().max(40).nullable().optional(),
  contactName: z.string().trim().max(120).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().email().nullable().optional().or(z.literal("")),
  address: z.string().trim().max(300).nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  active: z.boolean().optional(),
});

async function loadOwned(id: string, restaurantId: string) {
  const s = await db.supplier.findUnique({ where: { id } });
  if (!s || s.restaurantId !== restaurantId) return null;
  return s;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const supplier = await db.supplier.findUnique({
    where: { id },
    include: {
      items: {
        include: {
          ingredient: {
            select: { id: true, name: true, measureKind: true, active: true },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!supplier || supplier.restaurantId !== ctx.restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ supplier });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const sup = await loadOwned(id, ctx.restaurantId);
  if (!sup) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;

  if (b.name !== undefined && b.name !== sup.name) {
    const dup = await db.supplier.findUnique({
      where: {
        restaurantId_name: { restaurantId: ctx.restaurantId, name: b.name },
      },
      select: { id: true },
    });
    if (dup) return NextResponse.json({ error: "name_taken" }, { status: 409 });
  }

  const updated = await db.supplier.update({
    where: { id },
    data: {
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.taxId !== undefined ? { taxId: b.taxId || null } : {}),
      ...(b.contactName !== undefined
        ? { contactName: b.contactName || null }
        : {}),
      ...(b.phone !== undefined
        ? { phone: b.phone ? normalizePhone(b.phone, ctx.country ?? "CO") : null }
        : {}),
      ...(b.email !== undefined ? { email: b.email || null } : {}),
      ...(b.address !== undefined ? { address: b.address || null } : {}),
      ...(b.paymentTermsDays !== undefined
        ? { paymentTermsDays: b.paymentTermsDays }
        : {}),
      ...(b.notes !== undefined ? { notes: b.notes || null } : {}),
      ...(b.active !== undefined ? { active: b.active } : {}),
    },
  });
  return NextResponse.json({ supplier: updated });
}

/** DELETE = soft-delete (active:false) — igual que insumos. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const sup = await loadOwned(id, ctx.restaurantId);
  if (!sup) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await db.supplier.update({ where: { id }, data: { active: false } });
  return NextResponse.json({ ok: true });
}
