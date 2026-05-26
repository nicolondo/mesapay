import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auditLog";

/**
 * Platform-admin edits to a restaurant's profile. Today only the name
 * is editable — the slug lives in every printed QR code and changing
 * it would silently break tables, so we keep that immutable from this
 * surface. If we ever need a "rebrand + reissue QRs" flow it deserves
 * its own UI with explicit confirmation, not an inline rename.
 *
 * groupId también se acepta: cuando el admin reasigna un comercio a
 * otro grupo (o lo saca de un grupo). Al cambiar de grupo limpiamos
 * legalEntityId porque las razones sociales pertenecen al grupo
 * anterior y referenciarlas desde otro grupo violaría el scope.
 */
const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  tagline: z.string().trim().max(120).nullable().optional(),
  groupId: z.string().trim().min(1).nullable().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "platform_admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const existing = await db.restaurant.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      groupId: true,
      legalEntityId: true,
    },
  });
  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Si pasan groupId: validar que el grupo destino existe (o null
  // para "sacar del grupo") antes de tocar nada.
  const groupChange = parsed.data.groupId !== undefined;
  let nextGroupName: string | null = null;
  let previousGroupName: string | null = null;
  if (groupChange) {
    if (parsed.data.groupId !== null) {
      const target = await db.group.findUnique({
        where: { id: parsed.data.groupId },
        select: { id: true, name: true },
      });
      if (!target) {
        return NextResponse.json(
          { error: "group_not_found" },
          { status: 400 },
        );
      }
      nextGroupName = target.name;
    }
    if (existing.groupId) {
      const prev = await db.group.findUnique({
        where: { id: existing.groupId },
        select: { name: true },
      });
      previousGroupName = prev?.name ?? null;
    }
  }

  await db.restaurant.update({
    where: { id },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.tagline !== undefined
        ? { tagline: parsed.data.tagline }
        : {}),
      ...(groupChange
        ? {
            groupId: parsed.data.groupId,
            // Las razones sociales (LegalEntity) pertenecen a un grupo
            // específico. Si el comercio cambia de grupo, el
            // legalEntityId previo deja de ser válido — lo limpiamos.
            // El nuevo group_admin asignará una RS del nuevo grupo.
            legalEntityId: null,
          }
        : {}),
    },
  });

  if (groupChange) {
    await recordAuditEvent({
      kind: "restaurant.group.update",
      restaurantId: id,
      target: { type: "restaurant", id },
      summary:
        parsed.data.groupId === null
          ? `Sacó ${existing.name} del grupo ${previousGroupName ?? ""}`.trim()
          : previousGroupName
            ? `Movió ${existing.name} de ${previousGroupName} a ${nextGroupName}`
            : `Asignó ${existing.name} al grupo ${nextGroupName}`,
      diff: {
        before: { groupId: existing.groupId, legalEntityId: existing.legalEntityId },
        after: { groupId: parsed.data.groupId, legalEntityId: null },
      },
    });
  }

  return NextResponse.json({ ok: true });
}
