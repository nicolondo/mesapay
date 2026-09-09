import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { dianConfigStatus, emisorView, resolveEmisor } from "@/lib/dian/config";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

/**
 * SIN gate de módulo a propósito. La resolución de numeración manda el
 * prefijo y el consecutivo del comprobante IMPRESO, que existe con o sin
 * facturación electrónica. Antes estos campos se editaban en Identidad
 * (sin gate); si acá exigiéramos `einvoicing`, un comercio que sólo
 * imprime tirilla se quedaría sin poder tocar su propio consecutivo — le
 * pasó a DELIRIO, con 1.257 facturas emitidas y sin el módulo. El
 * certificado, las credenciales y la habilitación sí siguen gateados.
 */
const GATE: ModuleSlug[] = [];

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
  // Fecha del acto administrativo — sólo sale impresa en el comprobante,
  // no va al XML. Venía de Identidad.
  resolutionDate: day,
  // Próximo consecutivo a emitir. Venía de Identidad; vive acá porque el
  // rango autorizado que lo acota está en esta misma pantalla.
  invoiceNextNumber: z.number().int().min(1).max(2_000_000_000).optional(),
  // Descarta el texto libre legacy de la resolución. Acción EXPLÍCITA del
  // operador: nunca lo borramos solos porque puede ser el único lugar
  // donde quedó su número real.
  discardLegacyResolution: z.boolean().optional(),
});

/**
 * Carga de la resolución de numeración DIAN del EMISOR (la razón social
 * del grupo si existe, si no el propio restaurante — mismo criterio que
 * resolveEmisor).
 *
 * Es la ÚNICA superficie de escritura de estos datos. Antes se pedían
 * repartidos entre Identidad (texto libre + rango + fecha + prefijo +
 * consecutivo) y esta pantalla (número + vigencia), y los dos números
 * podían diferir sin que nadie lo notara: Son & Melona tenía
 * 18764094877213 cargado en Identidad mientras el XML mandaba
 * 18760000001.
 */
async function PATCHHandler(req: Request) {
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
  if (b.resolutionDate !== undefined) {
    data.dianResolutionDate = b.resolutionDate
      ? new Date(`${b.resolutionDate}T00:00:00.000Z`)
      : null;
  }
  if (b.discardLegacyResolution) data.dianResolution = null;

  if (emisor.ref.kind === "legalEntity") {
    await db.legalEntity.update({ where: { id: emisor.ref.id }, data });
  } else {
    await db.restaurant.update({ where: { id: emisor.ref.id }, data });
  }

  // El consecutivo va SIEMPRE al Restaurant, aunque el emisor sea un
  // LegalEntity: es la fila que `simpleInvoice.ts` incrementa al emitir.
  // Escribirlo en el LegalEntity dejaría el contador real intacto y el
  // operador creería que lo movió.
  if (b.invoiceNextNumber !== undefined) {
    await db.restaurant.update({
      where: { id: ctx.restaurantId },
      data: { invoiceNextNumber: b.invoiceNextNumber },
    });
  }

  const { emisor: fresh, status } = await dianConfigStatus(ctx.restaurantId);
  return NextResponse.json({
    status,
    emisor: fresh ? emisorView(fresh) : null,
  });
}

export const PATCH = secureApi(PATCHHandler);
