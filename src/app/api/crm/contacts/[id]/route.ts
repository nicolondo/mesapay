import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCrmContext } from "@/lib/crm/access";
import { normalizePhone } from "@/lib/crm/phone";

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  phone: z.string().max(40).nullable().optional(),
  email: z.string().email().nullable().optional().or(z.literal("")),
  role: z.string().max(100).nullable().optional(),
  isPrimary: z.boolean().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

// ── Helper: resolve contact + scope check ────────────────────────────────────

async function getContactInScope(
  contactId: string,
  visibleUserIds: string[] | null,
) {
  const contact = await db.crmContact.findUnique({
    where: { id: contactId },
    include: {
      lead: { select: { id: true, assignedToUserId: true, countryCode: true } },
    },
  });
  if (!contact) return null;
  if (
    visibleUserIds !== null &&
    !visibleUserIds.includes(contact.lead.assignedToUserId)
  ) {
    return null;
  }
  return contact;
}

// ── PATCH /api/crm/contacts/[id] ─────────────────────────────────────────────

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const contact = await getContactInScope(id, ctx.visibleUserIds);
  if (!contact) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const body = parsed.data;
  const countryCode = ctx.countryCode ?? contact.lead.countryCode;

  // Normalize phone if provided.
  const phone =
    body.phone !== undefined
      ? body.phone === null
        ? null
        : normalizePhone(body.phone, countryCode)
      : undefined;

  const isPrimary = body.isPrimary;

  await db.$transaction(async (tx) => {
    // If setting as primary, unset others in the same lead.
    if (isPrimary) {
      await tx.crmContact.updateMany({
        where: { leadId: contact.leadId, id: { not: id } },
        data: { isPrimary: false },
      });
    }

    const update: Record<string, unknown> = {};
    if (body.name !== undefined) update.name = body.name;
    if (phone !== undefined) update.phone = phone;
    if (body.email !== undefined) update.email = body.email || null;
    if (body.role !== undefined) update.role = body.role;
    if (isPrimary !== undefined) update.isPrimary = isPrimary;
    if (body.notes !== undefined) update.notes = body.notes;

    await tx.crmContact.update({ where: { id }, data: update });
  });

  return NextResponse.json({ ok: true });
}

// ── DELETE /api/crm/contacts/[id] ────────────────────────────────────────────

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const contact = await getContactInScope(id, ctx.visibleUserIds);
  if (!contact) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await db.crmContact.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
