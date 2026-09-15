import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { sweepDianEmissions } from "@/lib/dian/sweep";

export const dynamic = "force-dynamic";

/**
 * Barrido de emisión a la DIAN (red de seguridad de la emisión
 * automática). Toma los DianDocument en `to_send` (y los `error`
 * reintentables, con backoff) y los emite uno por uno; ver
 * `src/lib/dian/sweep.ts`. Idempotente: el reclamo por estado impide que
 * dos barridos —o un barrido y el intento inmediato del cobro— emitan el
 * mismo documento.
 *
 * Auth y verbo iguales a los otros crons (x-cron-secret + POST). Lo
 * dispara un systemd timer cada pocos minutos (ver docs/cron/). Devuelve
 * el resumen para que el timer lo loguee.
 */
async function POSTHandler(req: Request) {
  const secret = req.headers.get("x-cron-secret");
  const expected = process.env.CRON_SECRET ?? "";
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const summary = await sweepDianEmissions();
  return NextResponse.json({ ok: true, ...summary });
}

export const POST = secureApi(POSTHandler);
