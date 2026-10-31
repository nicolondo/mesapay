import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { runDailyAccounting } from "@/lib/erp/autoJournalDaily";

export const dynamic = "force-dynamic";

/**
 * Asientos contables automáticos: regenera los asientos-resumen de los meses
 * ABIERTOS de cada comercio con el módulo de contabilidad (no suspendido),
 * uno por uno y con tope de tiempo. Idempotente: el motor borra y recrea por
 * mes y fuente, no toca los comprobantes manuales ni los meses cerrados, y
 * el lock por comercio impide que se pise con el botón del Diario o con
 * otra corrida. Ver `src/lib/erp/autoJournal.ts`.
 *
 * Auth y verbo iguales a los otros crons (x-cron-secret + POST). Lo dispara
 * el timer docs/cron/mesapay-accounting-daily.timer a las 05:30 hora de
 * Colombia. Devuelve el resumen para que el timer lo loguee.
 */
async function POSTHandler(req: Request) {
  const secret = req.headers.get("x-cron-secret");
  const expected = process.env.CRON_SECRET ?? "";
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const summary = await runDailyAccounting();
  return NextResponse.json({ ok: true, ...summary });
}

export const POST = secureApi(POSTHandler);
