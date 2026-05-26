import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getActiveGroupShellContext } from "@/lib/activeRestaurant";
import { recordAuditEvent } from "@/lib/auditLog";

/**
 * CRUD de razones sociales del grupo. Solo group_admin con
 * groupId valido. Plataforma admin podria querer editarlas vía
 * /admin/* en el futuro, pero por ahora la operación vive en el
 * scope del grupo.
 *
 * Schemas: name + taxId mínimos. DIAN/dirección opcionales — se
 * pueden completar después o nunca (algunos grupos no facturan).
 */

const createSchema = z.object({
  name: z.string().trim().min(1).max(160),
  taxId: z.string().trim().min(1).max(40),
  address: z.string().trim().max(240).optional().nullable(),
  city: z.string().trim().max(80).optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
  dianResolution: z.string().trim().max(160).optional().nullable(),
  dianResolutionFrom: z.number().int().min(0).optional().nullable(),
  dianResolutionTo: z.number().int().min(0).optional().nullable(),
  dianResolutionDate: z.string().optional().nullable(),
  invoicePrefix: z.string().trim().max(10).optional().nullable(),
  invoiceNextNumber: z.number().int().min(1).optional(),
});

// Acepta group_admin (de su grupo) o platform_admin impersonando.
// El helper devuelve null si ninguno aplica.
async function requireGroupShell() {
  return getActiveGroupShellContext();
}

export async function GET() {
  const ctx = await requireGroupShell();
  if (!ctx) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const list = await db.legalEntity.findMany({
    where: { groupId: ctx.groupId },
    orderBy: { name: "asc" },
    include: { _count: { select: { restaurants: true } } },
  });
  return NextResponse.json({ items: list });
}

export async function POST(req: Request) {
  const ctx = await requireGroupShell();
  if (!ctx) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: "invalid", message: first?.message ?? "Datos inválidos" },
      { status: 400 },
    );
  }
  const data = parsed.data;
  const created = await db.legalEntity.create({
    data: {
      groupId: ctx.groupId,
      name: data.name,
      taxId: data.taxId,
      address: data.address ?? null,
      city: data.city ?? null,
      phone: data.phone ?? null,
      dianResolution: data.dianResolution ?? null,
      dianResolutionFrom: data.dianResolutionFrom ?? null,
      dianResolutionTo: data.dianResolutionTo ?? null,
      dianResolutionDate: data.dianResolutionDate
        ? new Date(data.dianResolutionDate)
        : null,
      invoicePrefix: data.invoicePrefix ?? null,
      invoiceNextNumber: data.invoiceNextNumber ?? 1,
    },
  });
  await recordAuditEvent({
    kind: "group.legal_entity.create",
    restaurantId: null,
    target: { type: "legal_entity", id: created.id },
    summary: `Creó razón social ${created.name} (${created.taxId})`,
  });
  return NextResponse.json({ ok: true, id: created.id });
}
