// Horarios y costo laboral (ERP Fase C1) — LÓGICA PURA, sin DB.
//
// El costo de un turno usa los minutos REALES cuando está punchado
// (checkInAt + checkOutAt) y los planeados en cualquier otro caso —
// mejor estimar la nómina de un turno pasado sin punch que reportar $0;
// el desglose siempre dice cuánto es real y cuánto estimado. Sin tarifa
// el turno cuesta 0 con flag `missingRate` (nunca se inventa).

export const MIN_SHIFT_MINUTES = 15;
export const MAX_SHIFT_MINUTES = 960; // 16 h — cubre nocturnos largos

/** start 0-1439, end > start, duración 15 min – 16 h. */
export function validShiftRange(startMinutes: number, endMinutes: number): boolean {
  return (
    Number.isInteger(startMinutes) &&
    Number.isInteger(endMinutes) &&
    startMinutes >= 0 &&
    startMinutes <= 1439 &&
    endMinutes > startMinutes &&
    endMinutes - startMinutes >= MIN_SHIFT_MINUTES &&
    endMinutes - startMinutes <= MAX_SHIFT_MINUTES
  );
}

export type ShiftCost = {
  minutes: number;
  costCents: number;
  /**
   * "actual" = punch completo; "planned" = rango planeado;
   * "absent" (C2) = turno pasado sin check-in en modo estricto — falta,
   * cuesta 0.
   */
  source: "actual" | "planned" | "absent";
  missingRate: boolean;
  /** C2 — parte del costo que es recargo festivo/dominical. */
  surchargeCents: number;
};

/**
 * Contexto C2 (opcional — sin él, comportamiento C1 exacto):
 * - recargo: % sobre la hora ordinaria si el DÍA en que EMPIEZA el turno
 *   es festivo (holidayPct) o domingo no festivo (sundayPct).
 * - estricto: turno ya terminado (según plan) sin check-in ⇒ falta ($0).
 */
export type ShiftCostContext = {
  isHoliday?: boolean;
  isSunday?: boolean;
  holidayPct?: number;
  sundayPct?: number;
  strict?: boolean;
  /** Reloj del caller — para decidir si el turno planeado ya terminó. */
  now?: Date;
  /** date del turno (medianoche UTC) — requerido para la regla estricta. */
  shiftDate?: Date;
};

export function shiftCost(
  shift: {
    startMinutes: number;
    endMinutes: number;
    checkInAt: Date | null;
    checkOutAt: Date | null;
    hourlyRateCents: number | null;
  },
  ctx: ShiftCostContext = {},
): ShiftCost {
  let minutes = shift.endMinutes - shift.startMinutes;
  let source: ShiftCost["source"] = "planned";
  if (shift.checkInAt && shift.checkOutAt) {
    const actual = Math.round(
      (shift.checkOutAt.getTime() - shift.checkInAt.getTime()) / 60_000,
    );
    // Punch incoherente (salida antes de la entrada) cae a planeado.
    if (actual > 0) {
      minutes = actual;
      source = "actual";
    }
  }

  // C2 — falta: sin check-in y el turno planeado ya terminó (estricto).
  if (
    source === "planned" &&
    ctx.strict &&
    !shift.checkInAt &&
    ctx.now &&
    ctx.shiftDate &&
    ctx.shiftDate.getTime() + shift.endMinutes * 60_000 < ctx.now.getTime()
  ) {
    return {
      minutes: 0,
      costCents: 0,
      source: "absent",
      missingRate: shift.hourlyRateCents == null,
      surchargeCents: 0,
    };
  }

  const missingRate = shift.hourlyRateCents == null;
  const baseCents = missingRate
    ? 0
    : Math.round((minutes * shift.hourlyRateCents!) / 60);
  // Recargo (C2): festivo manda sobre domingo (no se acumulan).
  const pct = ctx.isHoliday
    ? (ctx.holidayPct ?? 0)
    : ctx.isSunday
      ? (ctx.sundayPct ?? 0)
      : 0;
  const surchargeCents = pct > 0 ? Math.round((baseCents * pct) / 100) : 0;
  return {
    minutes,
    costCents: baseCents + surchargeCents,
    source,
    missingRate,
    surchargeCents,
  };
}

// ── Plantilla semanal (C2) ──────────────────────────────────────────────────

export type WeeklyTemplate = Array<{
  /** 0 = lunes … 6 = domingo (eje del planner). */
  weekday: number;
  ranges: Array<{ startMinutes: number; endMinutes: number }>;
}>;

/** Turnos candidatos de la plantilla para la semana del lunes dado. */
export function templateShiftsForWeek(
  template: WeeklyTemplate,
  monday: Date,
): Array<{ date: Date; startMinutes: number; endMinutes: number }> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const out: Array<{ date: Date; startMinutes: number; endMinutes: number }> = [];
  for (const day of template) {
    if (!Number.isInteger(day.weekday) || day.weekday < 0 || day.weekday > 6) continue;
    for (const r of day.ranges.slice(0, 2)) {
      if (!validShiftRange(r.startMinutes, r.endMinutes)) continue;
      out.push({
        date: new Date(monday.getTime() + day.weekday * DAY_MS),
        startMinutes: r.startMinutes,
        endMinutes: r.endMinutes,
      });
    }
  }
  return out;
}

/** Solape de rangos del mismo empleado/día ([start, end) — turno partido OK). */
export function hasOverlap(
  existing: Array<{ startMinutes: number; endMinutes: number }>,
  candidate: { startMinutes: number; endMinutes: number },
): boolean {
  return existing.some(
    (e) =>
      e.startMinutes < candidate.endMinutes &&
      candidate.startMinutes < e.endMinutes,
  );
}

/** [lunes, lunes+7d) en UTC para un "YYYY-MM-DD" que DEBE ser lunes. */
export function weekRange(mondayIso: string): { from: Date; to: Date } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(mondayIso);
  if (!m) return null;
  const from = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(from.getTime())) return null;
  const y = from.getUTCFullYear();
  if (y < 2020 || y > 2100) return null;
  if (from.getUTCDay() !== 1) return null; // 1 = lunes
  const to = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { from, to };
}

export type PlanShift = {
  employeeId: string;
  date: Date;
  startMinutes: number;
  endMinutes: number;
  note: string | null;
};

/**
 * "Copiar semana anterior" (pura): replica cada turno a la misma
 * posición relativa lunes→domingo de la semana destino, saltando los
 * que solaparían con turnos ya existentes del mismo empleado/día (o con
 * otros ya copiados en esta misma pasada).
 */
export function copyWeekPlan(
  fromShifts: PlanShift[],
  fromMonday: Date,
  toMonday: Date,
  existingToShifts: Array<Omit<PlanShift, "note">>,
): { toCreate: PlanShift[]; skipped: number } {
  const DAY = 24 * 60 * 60 * 1000;
  const byKey = new Map<string, Array<{ startMinutes: number; endMinutes: number }>>();
  const key = (employeeId: string, date: Date) =>
    `${employeeId}:${date.toISOString().slice(0, 10)}`;
  for (const e of existingToShifts) {
    const k = key(e.employeeId, e.date);
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(e);
  }

  const toCreate: PlanShift[] = [];
  let skipped = 0;
  for (const s of fromShifts) {
    const offsetDays = Math.round((s.date.getTime() - fromMonday.getTime()) / DAY);
    if (offsetDays < 0 || offsetDays > 6) {
      skipped++;
      continue;
    }
    const targetDate = new Date(toMonday.getTime() + offsetDays * DAY);
    const k = key(s.employeeId, targetDate);
    const taken = byKey.get(k) ?? [];
    if (hasOverlap(taken, s)) {
      skipped++;
      continue;
    }
    taken.push({ startMinutes: s.startMinutes, endMinutes: s.endMinutes });
    byKey.set(k, taken);
    toCreate.push({ ...s, date: targetDate });
  }
  return { toCreate, skipped };
}
