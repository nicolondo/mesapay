import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { recordAuditEvent } from "@/lib/auditLog";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  taxId: z.string().trim().min(1).max(40).optional(),
  address: z.string().trim().max(240).nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  dianResolution: z.string().trim().max(160).nullable().optional(),
  dianResolutionFrom: z.number().int().min(0).nullable().optional(),
  dianResolutionTo: z.number().int().min(0).nullable().optional(),
  dianResolutionDate: z.string().nullable().optional(),
  invoicePrefix: z.string().trim().max(10).nullable().optional(),
  invoiceNextNumber: z.number().int().min(1).optional(),
});

async function requireGroupAdminAndEntity(id: string) {
  const session = await auth();
  if (
    !session?.user ||
    session.user.role !== "group_admin" ||
    !session.user.groupId
  ) {
    return { error: "forbidden" as const, status: 403 };
  }
  const entity = await db.legalEntity.findUnique({ where: { id } });
  if (!entity) {
    return { error: "not_found" as const, status: 404 };
  }
  if (entity.groupId !== session.user.groupId) {
    // Razón social de otro grupo — no exponer existencia.
    return { error: "not_found" as const, status: 404 };
  }
  return { session, entity } as const;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await requireGroupAdminAndEntity(id);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const body = await req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: "invalid", message: first?.message ?? "Datos inválidos" },
      { status: 400 },
    );
  }
  const data = parsed.data;
  const updated = await db.legalEntity.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.taxId !== undefined && { taxId: data.taxId }),
      ...(data.address !== undefined && { address: data.address }),
      ...(data.city !== undefined && { city: data.city }),
      ...(data.phone !== undefined && { phone: data.phone }),
      ...(data.dianResolution !== undefined && {
        dianResolution: data.dianResolution,
      }),
      ...(data.dianResolutionFrom !== undefined && {
        dianResolutionFrom: data.dianResolutionFrom,
      }),
      ...(data.dianResolutionTo !== undefined && {
        dianResolutionTo: data.dianResolutionTo,
      }),
      ...(data.dianResolutionDate !== undefined && {
        dianResolutionDate: data.dianResolutionDate
          ? new Date(data.dianResolutionDate)
          : null,
      }),
      ...(data.invoicePrefix !== undefined && {
        invoicePrefix: data.invoicePrefix,
      }),
      ...(data.invoiceNextNumber !== undefined && {
        invoiceNextNumber: data.invoiceNextNumber,
      }),
    },
  });
  await recordAuditEvent({
    kind: "group.legal_entity.update",
    restaurantId: null,
    target: { type: "legal_entity", id: updated.id },
    summary: `Editó razón social ${updated.name}`,
    diff: { before: auth.entity as unknown as Record<string, unknown>, after: data as Record<string, unknown> },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await requireGroupAdminAndEntity(id);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  // ¿Está asignada a algún restaurante? Si sí, no borrar — el
  // usuario debe desasignarla primero.
  const count = await db.restaurant.count({
    where: { legalEntityId: id },
  });
  if (count > 0) {
    return NextResponse.json(
      {
        error: "in_use",
        message: `No se puede borrar — ${count} ${count === 1 ? "restaurante usa" : "restaurantes usan"} esta razón social.`,
      },
      { status: 409 },
    );
  }
  await db.legalEntity.delete({ where: { id } });
  await recordAuditEvent({
    kind: "group.legal_entity.delete",
    restaurantId: null,
    target: { type: "legal_entity", id },
    summary: `Borró razón social ${result.entity.name}`,
  });
  return NextResponse.json({ ok: true });
}
