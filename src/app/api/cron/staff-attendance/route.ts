import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules";

export const dynamic = "force-dynamic";

/**
 * Cron diario de asistencia (C2 · D4): auto-cierre de olvidos de
 * check-out — turnos de días YA TERMINADOS con entrada y sin salida se
 * cierran a su hora planeada (`date + endMinutes`), marcados autoClosed.
 * Las FALTAS no se persisten (derivadas al leer, modo estricto).
 * Idempotente: autoClosed=true no se re-visita.
 */
export async function POST(req: Request) {
  const secret = req.headers.get("x-cron-secret");
  const expected = process.env.CRON_SECRET ?? "";
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Corte: turnos cuyo día terminó hace ≥ un día completo en cualquier
  // zona horaria razonable (date < hoyUTC − 1d cubre nocturnos y el
  // desfase device-local vs UTC sin cerrar turnos aún en curso).
  const now = new Date();
  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const cutoff = new Date(todayUtc.getTime() - 24 * 60 * 60 * 1000);

  const open = await db.staffShift.findMany({
    where: {
      date: { lt: cutoff },
      checkInAt: { not: null },
      checkOutAt: null,
      autoClosed: false,
    },
    select: {
      id: true,
      date: true,
      endMinutes: true,
      checkInAt: true,
      restaurant: { select: { enabledModules: true } },
    },
    take: 500,
    orderBy: { date: "asc" },
  });

  let closed = 0;
  for (const s of open) {
    if (!isModuleEnabled(s.restaurant.enabledModules, "staff")) continue;
    const plannedEnd = new Date(s.date.getTime() + s.endMinutes * 60_000);
    // Nunca cerrar ANTES de la entrada real (entrada tardía tras el fin
    // planeado): mínimo entrada + 1 min para no fabricar un punch inválido.
    const checkOutAt =
      s.checkInAt && plannedEnd <= s.checkInAt
        ? new Date(s.checkInAt.getTime() + 60_000)
        : plannedEnd;
    await db.staffShift.update({
      where: { id: s.id },
      data: { checkOutAt, autoClosed: true, checkOutMethod: "auto" },
    });
    closed++;
  }

  return NextResponse.json({ scanned: open.length, closed });
}
