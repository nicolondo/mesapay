import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { runDailyBackups } from "@/lib/backups";

export const dynamic = "force-dynamic";

/**
 * Copia de seguridad automática diaria de TODOS los comercios + purga de
 * las vencidas (7 días). Idempotente: un comercio con una copia `auto` de
 * las últimas 20 h se salta, así que correrlo dos veces no duplica.
 *
 * Auth y verbo iguales a los otros crons (x-cron-secret + POST). Lo dispara
 * el timer docs/cron/mesapay-backups-daily.timer a las 04:00.
 */
async function POSTHandler(req: Request) {
  const secret = req.headers.get("x-cron-secret");
  const expected = process.env.CRON_SECRET ?? "";
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runDailyBackups();
  return NextResponse.json({ ok: true, ...result });
}

export const POST = secureApi(POSTHandler);
