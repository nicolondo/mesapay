import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { toCsv } from "@/lib/erp/accounting";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["staff"];

/** "YYYY-MM-DD" → medianoche UTC, o null. */
function parseDay(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** minutos desde medianoche → "HH:MM" (mod 1440 para nocturnos). */
function hhmm(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

const TZ: Record<string, string> = {
  CO: "America/Bogota",
  MX: "America/Mexico_City",
};

/** Hora local del punch (zona del país) → "HH:MM", "" si null. */
function punchTime(d: Date | null, country: string | null): string {
  if (!d) return "";
  return d.toLocaleTimeString("es-CO", {
    timeZone: TZ[country ?? ""] ?? "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Export CSV de asistencia por rango de fechas (?from=YYYY-MM-DD&to=…,
 * ambos inclusive). Una fila por turno: empleado, planeado, punch real,
 * horas, estado y método. UTF-8 con BOM (Excel muestra bien los acentos).
 */
export async function GET(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const from = parseDay(searchParams.get("from") ?? "");
  const to = parseDay(searchParams.get("to") ?? "");
  if (!from || !to || from > to) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const t = await getTranslations("opErp");

  const shifts = await db.staffShift.findMany({
    where: {
      restaurantId: ctx.restaurantId,
      date: { gte: from, lte: to },
    },
    orderBy: [{ date: "asc" }, { startMinutes: "asc" }],
    include: { employee: { select: { name: true, position: true } } },
  });

  const status = (s: (typeof shifts)[number]): string => {
    if (s.autoClosed) return t("attStatusAutoClosed");
    if (s.checkInAt && s.checkOutAt) return t("attStatusPresent");
    if (s.checkInAt) return t("attStatusNoCheckout");
    return t("attStatusAbsent");
  };
  const hours = (s: (typeof shifts)[number]): string => {
    const mins =
      s.checkInAt && s.checkOutAt
        ? Math.max(0, Math.round((s.checkOutAt.getTime() - s.checkInAt.getTime()) / 60000))
        : s.endMinutes - s.startMinutes;
    return (mins / 60).toFixed(2);
  };

  const csv = toCsv(
    [
      t("csvDate"),
      t("attCsvEmployee"),
      t("attCsvPosition"),
      t("attCsvPlannedStart"),
      t("attCsvPlannedEnd"),
      t("attCsvCheckIn"),
      t("attCsvCheckOut"),
      t("attCsvHours"),
      t("attCsvStatus"),
      t("attCsvMethodIn"),
      t("attCsvMethodOut"),
    ],
    shifts.map((s) => [
      s.date.toISOString().slice(0, 10),
      s.employee.name,
      s.employee.position,
      hhmm(s.startMinutes),
      hhmm(s.endMinutes),
      punchTime(s.checkInAt, ctx.country),
      punchTime(s.checkOutAt, ctx.country),
      hours(s),
      status(s),
      s.checkInMethod ?? "",
      s.checkOutMethod ?? "",
    ]),
  );

  const fromIso = searchParams.get("from");
  const toIso = searchParams.get("to");
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="mesapay-asistencia-${fromIso}_${toIso}.csv"`,
    },
  });
}
