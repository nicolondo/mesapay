import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import {
  DianConfigError,
  documentErrors,
  loadDianConfig,
} from "@/lib/dian/config";
import { getStatusZip } from "@/lib/dian/soap";
import { transitionAfterPoll } from "@/lib/dian/documentState";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["einvoicing"];

/**
 * Consulta a la DIAN el estado de un documento que quedó `pending` y
 * aplica la transición.
 *
 * Este era el eslabón que faltaba: getStatusZip y transitionAfterPoll
 * existían pero no los llamaba nadie, así que un documento aceptado en la
 * DIAN se quedaba mostrando "en proceso" para siempre en la pantalla.
 *
 * El refresco es MANUAL a propósito (botón "Consultar estado"): la DIAN
 * procesa el set de pruebas en minutos, un cron sería martillar su API
 * para nada, y el operador consulta cuando le importa. Al aceptar, deja
 * la config en `enabled`.
 */
async function POSTHandler(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;

  const doc = await db.dianDocument.findUnique({
    where: { id },
    select: {
      id: true,
      restaurantId: true,
      state: true,
      cufe: true,
      trackId: true,
      errors: true,
    },
  });
  if (!doc || doc.restaurantId !== ctx.restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!doc.trackId) {
    // Sin ZipKey no hay nada que consultar: el envío nunca llegó.
    return NextResponse.json({ error: "no_track_id" }, { status: 400 });
  }

  let config;
  try {
    config = await loadDianConfig(ctx.restaurantId);
  } catch (err) {
    if (err instanceof DianConfigError) {
      return NextResponse.json({ error: err.code }, { status: 400 });
    }
    throw err;
  }

  const result = await getStatusZip(doc.trackId, {
    environment: config.environment,
    cert: config.cert,
  });
  const t = transitionAfterPoll(result, {
    cufe: doc.cufe,
    trackId: doc.trackId,
  });

  // Se persiste SIEMPRE la respuesta cruda y los errores: las reglas que
  // devuelve la DIAN son lo único que le dice al comercio qué corregir.
  const errors = t.errors.length ? t.errors : documentErrors(doc.errors);
  await db.dianDocument.update({
    where: { id: doc.id },
    data: {
      state: t.state,
      cufe: t.cufe ?? doc.cufe,
      trackId: t.trackId ?? doc.trackId,
      errors: errors.length ? errors : undefined,
      responseXml: result.raw ?? undefined,
    },
  });

  // Documento aceptado ⇒ el canal quedó probado de punta a punta.
  if (t.state === "accepted") {
    await db.dianConfig.update({
      where: { id: config.configId },
      data: { status: "enabled" },
    });
  }

  return NextResponse.json({
    document: {
      id: doc.id,
      state: t.state,
      cufe: t.cufe ?? doc.cufe,
      trackId: t.trackId ?? doc.trackId,
      errors,
      statusMessage: result.statusMessage ?? null,
    },
  });
}

export const POST = secureApi(POSTHandler);
