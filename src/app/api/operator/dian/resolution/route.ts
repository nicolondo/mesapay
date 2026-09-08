import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { dianConfigStatus, emisorView, resolveEmisor } from "@/lib/dian/config";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["einvoicing"];

const day = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .optional();

const patchSchema = z.object({
  // Número pelado del acto administrativo ("18760000001"), sin texto.
  resolutionNumber: z.string().trim().max(40).nullable().optional(),
  invoicePrefix: z.string().trim().toUpperCase().max(10).nullable().optional(),
  resolutionFrom: z.number().int().nonnegative().max(999_999_999).nullable().optional(),
  resolutionTo: z.number().int().nonnegative().max(999_999_999).nullable().optional(),
  resolutionValidFrom: day,
  resolutionValidTo: day,
});

/**
 * Carga de la resolución de numeración DIAN del EMISOR (la razón social
 * del grupo si existe, si no el propio restaurante — mismo criterio que
 * resolveEmisor).
 *
 * Existe porque estos datos no tenían superficie completa: el número de
 * resolución se guardaba dentro de un texto libre pensado para la tirilla
 * y la vigencia del rango no se guardaba en ninguna parte, así que el XML
 * mandaba la fecha de hoy y la DIAN rechazaba (FAB05b, FAB07b, FAB08b).
 */
export async function PATCH(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const emisor = await resolveEmisor(ctx.restaurantId);
  if (!emisor) return NextResponse.json({ error: "no_emisor" }, { status: 400 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;

  if (
    b.resolutionFrom != null &&
    b.resolutionTo != null &&
    b.resolutionTo < b.resolutionFrom
  ) {
    return NextResponse.json({ error: "range_inverted" }, { status: 400 });
  }
  if (
    b.resolutionValidFrom &&
    b.resolutionValidTo &&
    b.resolutionValidTo < b.resolutionValidFrom
  ) {
    return NextResponse.json({ error: "dates_inverted" }, { status: 400 });
  }

  const data: Record<string, unknown> = {};
  if (b.resolutionNumber !== undefined) {
    data.dianResolutionNumber = b.resolutionNumber || null;
  }
  if (b.invoicePrefix !== undefined) data.invoicePrefix = b.invoicePrefix || null;
  if (b.resolutionFrom !== undefined) data.dianResolutionFrom = b.resolutionFrom;
  if (b.resolutionTo !== undefined) data.dianResolutionTo = b.resolutionTo;
  if (b.resolutionValidFrom !== undefined) {
    data.dianResolutionValidFrom = b.resolutionValidFrom
      ? new Date(`${b.resolutionValidFrom}T00:00:00.000Z`)
      : null;
  }
  if (b.resolutionValidTo !== undefined) {
    data.dianResolutionValidTo = b.resolutionValidTo
      ? new Date(`${b.resolutionValidTo}T00:00:00.000Z`)
      : null;
  }

  if (emisor.ref.kind === "legalEntity") {
    await db.legalEntity.update({ where: { id: emisor.ref.id }, data });
  } else {
    await db.restaurant.update({ where: { id: emisor.ref.id }, data });
  }

  const { emisor: fresh, status } = await dianConfigStatus(ctx.restaurantId);
  return NextResponse.json({
    status,
    emisor: fresh ? emisorView(fresh) : null,
  });
}
