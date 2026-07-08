"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney, localeTag, pesosToCents } from "@/lib/format";

/* ───────────────────────────── Tipos ───────────────────────────────── */
// Espejo de GET /api/operator/employees y GET /api/operator/staff-shifts
// (C1 · D6). El costo de cada turno ya viene calculado del server (real
// si está punchado, planeado si no — D4); acá nunca se recalcula.

type UserRef = { id: string; name: string | null; email: string };

type EmployeeDto = {
  id: string;
  name: string;
  position: string;
  /** null = sin tarifa: los turnos cuestan 0 con badge (D1). */
  hourlyRateCents: number | null;
  active: boolean;
  userId: string | null;
  user: UserRef | null;
};

type TeamPayload = { employees: EmployeeDto[]; positions: string[] };

type ShiftDto = {
  id: string;
  employeeId: string;
  /** ISO — medianoche UTC del día al que pertenece el turno (D2). */
  date: string;
  startMinutes: number;
  /** > 1439 = cruza medianoche (18:00→02:00 es 1080→1560). */
  endMinutes: number;
  note: string | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  employee: {
    id: string;
    name: string;
    position: string;
    hourlyRateCents: number | null;
    active: boolean;
  };
  cost: {
    minutes: number;
    costCents: number;
    source: "actual" | "planned";
    missingRate: boolean;
  };
};

type WeekPayload = {
  shifts: ShiftDto[];
  totals: {
    shifts: number;
    minutes: number;
    costCents: number;
    actualCents: number;
    missingRateShifts: number;
  };
};

/* ─────────────────────────── Helpers ───────────────────────────────── */

/** "YYYY-MM-DD" ± n días — aritmética UTC (sin DST). */
function shiftDays(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Hoy (día local del dispositivo) como "YYYY-MM-DD". */
function todayIso(): string {
  const now = new Date();
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Lunes de la semana del día local, anclado en UTC (la API exige lunes). */
function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// Congelados al cargar el módulo — el render debe ser puro (regla
// react-hooks/purity, mismo criterio que NOW_MS en Contabilidad). La
// precisión "cambió el día a medianoche con el tab abierto" no importa.
const TODAY_ISO = todayIso();
const CURRENT_MONDAY = mondayOf(TODAY_ISO);
// Los punches se muestran y editan en la hora del dispositivo (que en la
// práctica es la del comercio): así el texto y el input datetime-local
// nunca se contradicen entre sí.
const DEVICE_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Los 7 días (ISO) de la semana que empieza en `monday`. */
function weekDays(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => shiftDays(monday, i));
}

/** "30 jun – 6 jul" — label del selector de semana (lunes a domingo). */
function weekLabel(monday: string, locale: Locale): string {
  const fmt = new Intl.DateTimeFormat(localeTag(locale), {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  return (
    fmt.format(new Date(`${monday}T00:00:00Z`)) +
    " – " +
    fmt.format(new Date(`${shiftDays(monday, 6)}T00:00:00Z`))
  );
}

/** "Lunes 30 jun" — encabezado de cada día del planner. */
function dayLabel(iso: string, locale: Locale): string {
  const label = new Intl.DateTimeFormat(localeTag(locale), {
    weekday: "long",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Minutos desde medianoche → "HH:MM" (>1439 = hora del día siguiente). */
function minutesToTime(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** "HH:MM" del input time → minutos desde medianoche. */
function timeToMinutes(v: string): number {
  const [h, m] = v.split(":").map(Number);
  return h * 60 + m;
}

function rangeLabel(s: { startMinutes: number; endMinutes: number }): string {
  return `${minutesToTime(s.startMinutes)}–${minutesToTime(s.endMinutes)}`;
}

/** Minutos → horas con 1 decimal máximo, localizado ("42,5"). */
function fmtHours(minutes: number, locale: Locale): string {
  return new Intl.NumberFormat(localeTag(locale), {
    maximumFractionDigits: 1,
  }).format(minutes / 60);
}

/** ISO → valor de input datetime-local en hora del dispositivo. */
function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Valor datetime-local → ISO UTC (con Z — lo exige el PATCH). */
function localInputToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Hora de un punch — "18:07" en la zona del dispositivo. */
function punchTime(iso: string, locale: Locale): string {
  return formatDate(iso, {
    locale,
    dateStyle: undefined,
    timeStyle: "short",
    timeZone: DEVICE_TZ,
  });
}

// Errores de la API de turnos → clave i18n (fallback errSaveFailed).
const SHIFT_ERROR_KEYS: Record<string, string> = {
  invalid: "errShiftInvalid",
  invalid_punch: "errPunchInvalid",
  shift_overlap: "errShiftOverlap",
  employee_not_found: "errEmployeeNotFound",
  employee_inactive: "errEmployeeInactive",
  not_found: "errShiftNotFound",
};

// Errores de la API de empleados.
const EMPLOYEE_ERROR_KEYS: Record<string, string> = {
  invalid: "errEmployeeInvalid",
  user_not_found: "errStaffUserNotFound",
  name_taken: "errEmployeeNameTaken",
  not_found: "errEmployeeNotFound",
};

type Tab = "week" | "today" | "team";

/* ───────────────────────────── Shell ───────────────────────────────── */

export function HorariosClient({
  currency,
  users,
}: {
  currency: string;
  /** Usuarios staff del comercio — select opcional del empleado (D1). */
  users: UserRef[];
}) {
  const t = useTranslations("opErp");

  const [tab, setTab] = useState<Tab>("week");
  const [monday, setMonday] = useState(CURRENT_MONDAY);
  // Caché por lunes de semana (patrón pnlCache de Contabilidad). Toda
  // mutación de turnos la tira completa: un copy-week toca otra semana y
  // un punch cambia el costo — el tab re-fetchea al verse.
  const [weekCache, setWeekCache] = useState<Record<string, WeekPayload>>({});
  const [team, setTeam] = useState<TeamPayload | null>(null);
  const [teamErr, setTeamErr] = useState(false);
  const [teamSeq, setTeamSeq] = useState(0);

  // Sheets en el shell: el de turno se abre desde Semana Y desde Hoy
  // (mismo formulario; "Turno extra" llega con la fecha fija de hoy).
  const [shiftSheet, setShiftSheet] = useState<{
    shift: ShiftDto | null;
    fixedDate?: string;
  } | null>(null);
  const [employeeSheet, setEmployeeSheet] = useState<EmployeeDto | "new" | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/operator/employees");
        if (!r.ok) throw new Error("load_failed");
        const j = (await r.json()) as TeamPayload;
        if (cancelled) return;
        setTeam(j);
        setTeamErr(false);
      } catch {
        if (!cancelled) setTeamErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamSeq]);

  const activeEmployees = useMemo(
    () => (team?.employees ?? []).filter((e) => e.active),
    [team],
  );

  function handleShiftChanged() {
    setShiftSheet(null);
    setWeekCache({});
  }

  function handleEmployeeChanged() {
    setEmployeeSheet(null);
    setTeamSeq((s) => s + 1);
    // La tarifa/estado del empleado cambia el costo de los turnos ya
    // cargados — la caché de semanas también se invalida.
    setWeekCache({});
  }

  return (
    <div className="space-y-4">
      {/* Segmentos Semana / Hoy / Equipo */}
      <div className="inline-flex rounded-full border border-op-border bg-op-surface overflow-hidden">
        {(
          [
            ["week", t("staffTabWeek")],
            ["today", t("staffTabToday")],
            ["team", t("staffTabTeam")],
          ] as [Tab, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={
              "min-h-[44px] px-5 text-xs font-medium transition-colors " +
              (tab === value ? "bg-ink text-bone" : "text-op-muted hover:text-ink")
            }
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "week" ? (
        <WeekTab
          monday={monday}
          setMonday={setMonday}
          currency={currency}
          cache={weekCache}
          setCache={setWeekCache}
          onInvalidate={() => setWeekCache({})}
          onNew={(date) => setShiftSheet({ shift: null, fixedDate: date })}
          onEdit={(shift) => setShiftSheet({ shift })}
        />
      ) : tab === "today" ? (
        <TodayTab
          currency={currency}
          cache={weekCache}
          setCache={setWeekCache}
          onMutated={() => setWeekCache({})}
          onEdit={(shift) => setShiftSheet({ shift })}
          onExtra={() => setShiftSheet({ shift: null, fixedDate: TODAY_ISO })}
        />
      ) : (
        <TeamTab
          currency={currency}
          team={team}
          teamErr={teamErr}
          onNew={() => setEmployeeSheet("new")}
          onEdit={(e) => setEmployeeSheet(e)}
        />
      )}

      {shiftSheet !== null && (
        <ShiftSheet
          shift={shiftSheet.shift}
          fixedDate={shiftSheet.fixedDate}
          defaultDate={
            weekDays(monday).includes(TODAY_ISO) ? TODAY_ISO : monday
          }
          employees={activeEmployees}
          onClose={() => setShiftSheet(null)}
          onChanged={handleShiftChanged}
        />
      )}

      {employeeSheet !== null && (
        <EmployeeSheet
          employee={employeeSheet === "new" ? null : employeeSheet}
          positions={team?.positions ?? []}
          users={users}
          currency={currency}
          onClose={() => setEmployeeSheet(null)}
          onChanged={handleEmployeeChanged}
        />
      )}
    </div>
  );
}

/* ─────────────────────── Fetch semanal compartido ──────────────────── */

/**
 * Carga (con caché por lunes) la semana pedida. Semana y Hoy comparten
 * la misma caché del shell: Hoy es la semana actual filtrada al día — un
 * solo endpoint, cero fetch propio (decisión "lo más simple" del spec).
 */
function useWeek(
  monday: string,
  cache: Record<string, WeekPayload>,
  setCache: React.Dispatch<React.SetStateAction<Record<string, WeekPayload>>>,
): { data: WeekPayload | undefined; loadErr: boolean } {
  const [loadErr, setLoadErr] = useState(false);
  const data = cache[monday];

  useEffect(() => {
    if (cache[monday]) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/operator/staff-shifts?week=${monday}`);
        if (!r.ok) throw new Error("load_failed");
        const j = (await r.json()) as WeekPayload;
        if (cancelled) return;
        setCache((c) => ({ ...c, [monday]: j }));
        setLoadErr(false);
      } catch {
        if (!cancelled) setLoadErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [monday, cache, setCache]);

  return { data, loadErr };
}

/* ──────────────────────── Tab Semana (D6.1) ────────────────────────── */

function WeekTab({
  monday,
  setMonday,
  currency,
  cache,
  setCache,
  onInvalidate,
  onNew,
  onEdit,
}: {
  monday: string;
  setMonday: React.Dispatch<React.SetStateAction<string>>;
  currency: string;
  cache: Record<string, WeekPayload>;
  setCache: React.Dispatch<React.SetStateAction<Record<string, WeekPayload>>>;
  onInvalidate: () => void;
  onNew: (date?: string) => void;
  onEdit: (shift: ShiftDto) => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const { data, loadErr } = useWeek(monday, cache, setCache);
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  const money = (cents: number) => formatMoney(cents, { currency, locale });

  const byDay = useMemo(() => {
    const m = new Map<string, ShiftDto[]>();
    for (const s of data?.shifts ?? []) {
      const k = s.date.slice(0, 10);
      (m.get(k) ?? m.set(k, []).get(k)!).push(s);
    }
    return m;
  }, [data]);

  async function copyPrevWeek() {
    if (!window.confirm(t("staffConfirmCopyWeek"))) return;
    setCopyMsg(null);
    setCopyBusy(true);
    const r = await fetch("/api/operator/staff-shifts/copy-week", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fromWeek: shiftDays(monday, -7), toWeek: monday }),
    });
    setCopyBusy(false);
    if (!r.ok) {
      setCopyMsg(t("errSaveFailed"));
      return;
    }
    const j = (await r.json()) as { copied: number; skipped: number };
    setCopyMsg(t("staffCopyWeekResult", { copied: j.copied, skipped: j.skipped }));
    onInvalidate();
  }

  return (
    <div className="space-y-4">
      {/* Selector ◀ "30 jun – 6 jul" ▶ (lunes a domingo) */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setMonday((m) => shiftDays(m, -7))}
          aria-label={t("staffWeekPrev")}
          className="min-h-[44px] min-w-[44px] rounded-full border border-op-border bg-op-surface text-sm text-op-muted hover:text-ink hover:bg-op-bg"
        >
          {"◀"}
        </button>
        <div className="text-sm font-medium">{weekLabel(monday, locale)}</div>
        <button
          type="button"
          onClick={() => setMonday((m) => shiftDays(m, 7))}
          aria-label={t("staffWeekNext")}
          className="min-h-[44px] min-w-[44px] rounded-full border border-op-border bg-op-surface text-sm text-op-muted hover:text-ink hover:bg-op-bg"
        >
          {"▶"}
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onNew()}
          className="flex-1 min-h-[44px] rounded-full bg-ink text-bone text-sm font-medium hover:bg-ink/90"
        >
          {t("shiftNew")}
        </button>
        <button
          type="button"
          onClick={copyPrevWeek}
          disabled={copyBusy}
          className="min-h-[44px] px-4 rounded-full border border-op-border bg-op-surface text-sm font-medium hover:bg-op-bg disabled:opacity-40"
        >
          {copyBusy ? t("saving") : t("staffCopyWeek")}
        </button>
      </div>
      {copyMsg && <div className="text-[11px] text-op-muted">{copyMsg}</div>}

      {loadErr ? (
        <div className="text-xs text-danger">{t("errLoadFailed")}</div>
      ) : data === undefined ? (
        <div className="py-6 text-center text-sm text-op-muted">
          {t("loading")}
        </div>
      ) : (
        <>
          {/* Totales de la semana: costo, horas y cuánto ya es real */}
          <div className="rounded-2xl border border-op-border bg-op-surface px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                {t("staffWeekTotal")}
              </span>
              <span className="font-display text-2xl tabular-nums">
                {money(data.totals.costCents)}
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-3 flex-wrap text-[11px] text-op-muted">
              <span className="tabular-nums">
                {t("staffWeekHours", {
                  hours: fmtHours(data.totals.minutes, locale),
                })}
              </span>
              <span className="tabular-nums">
                {t("staffWeekActual", { amount: money(data.totals.actualCents) })}
              </span>
            </div>
            {data.totals.missingRateShifts > 0 && (
              <div className="mt-1 text-[11px] text-[#7F5A1F]">
                {t("laborMissingRateShifts", {
                  count: data.totals.missingRateShifts,
                })}
              </div>
            )}
          </div>

          {data.shifts.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center">
              <div className="font-display text-lg mb-1">
                {t("staffWeekEmptyTitle")}
              </div>
              <p className="text-sm text-op-muted">{t("staffWeekEmptyBody")}</p>
            </div>
          ) : (
            weekDays(monday).map((day) => {
              const shifts = byDay.get(day) ?? [];
              const subtotal = shifts.reduce(
                (a, s) => a + s.cost.costCents,
                0,
              );
              return (
                <section
                  key={day}
                  className="bg-op-surface border border-op-border rounded-2xl overflow-hidden"
                >
                  <div className="px-4 py-2 bg-op-bg/50 border-b border-op-border flex items-center justify-between gap-3">
                    <span className="text-xs font-medium">
                      {dayLabel(day, locale)}
                    </span>
                    {shifts.length > 0 && (
                      <span className="text-[11px] text-op-muted tabular-nums shrink-0">
                        {money(subtotal)}
                      </span>
                    )}
                  </div>
                  {shifts.length === 0 ? (
                    <div className="px-4 py-2.5 text-[11px] text-op-muted">
                      {t("staffDayNoShifts")}
                    </div>
                  ) : (
                    shifts.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => onEdit(s)}
                        className="w-full text-left px-4 py-2.5 border-b border-op-border last:border-b-0 hover:bg-op-bg"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-sm font-medium truncate">
                                {s.employee.name}
                              </span>
                              {s.cost.source === "actual" && (
                                <span className="px-2 h-5 inline-flex items-center rounded-full bg-ok/10 text-[#1E5339] text-[10px] font-medium shrink-0">
                                  {t("shiftAttendedBadge")}
                                </span>
                              )}
                              {s.cost.missingRate && (
                                <span className="px-2 h-5 inline-flex items-center rounded-full bg-[#C98A2E]/10 text-[#7F5A1F] text-[10px] font-medium shrink-0">
                                  {t("staffNoRate")}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-op-muted mt-0.5 truncate">
                              {[s.employee.position, rangeLabel(s), s.note]
                                .filter(Boolean)
                                .join(" · ")}
                            </div>
                          </div>
                          <div className="text-sm font-medium tabular-nums shrink-0">
                            {money(s.cost.costCents)}
                          </div>
                        </div>
                      </button>
                    ))
                  )}
                </section>
              );
            })
          )}
        </>
      )}
    </div>
  );
}

/* ───────────────────────── Tab Hoy (D6.2) ──────────────────────────── */

/**
 * Board de asistencia: los turnos de HOY (semana actual filtrada al día)
 * con botones grandes Entró/Salió que punchan con la hora del server.
 * Tap en la fila → mismo sheet del planner (que además edita los tiempos
 * reales a mano).
 */
function TodayTab({
  currency,
  cache,
  setCache,
  onMutated,
  onEdit,
  onExtra,
}: {
  currency: string;
  cache: Record<string, WeekPayload>;
  setCache: React.Dispatch<React.SetStateAction<Record<string, WeekPayload>>>;
  onMutated: () => void;
  onEdit: (shift: ShiftDto) => void;
  onExtra: () => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const { data, loadErr } = useWeek(CURRENT_MONDAY, cache, setCache);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const money = (cents: number) => formatMoney(cents, { currency, locale });

  const shifts = useMemo(
    () => (data?.shifts ?? []).filter((s) => s.date.slice(0, 10) === TODAY_ISO),
    [data],
  );

  async function punch(shift: ShiftDto, action: "check_in" | "check_out") {
    setErr(null);
    setBusyId(shift.id);
    const r = await fetch(`/api/operator/staff-shifts/${shift.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setBusyId(null);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const key = SHIFT_ERROR_KEYS[(j as { error?: string }).error ?? ""];
      setErr(key ? t(key) : t("errSaveFailed"));
      return;
    }
    onMutated();
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onExtra}
        className="w-full min-h-[44px] rounded-full bg-ink text-bone text-sm font-medium hover:bg-ink/90"
      >
        {t("shiftExtra")}
      </button>

      {/* Kiosko de marcación con cara (C2 · D1) — link discreto: es la
          pantalla que queda abierta en la tablet del local. */}
      <div className="text-center">
        <Link
          href="/operator/horarios/kiosko"
          className="inline-flex items-center min-h-[44px] px-3 text-[11px] font-medium text-op-muted hover:text-ink underline underline-offset-2"
        >
          {t("kioskOpenLink")}
        </Link>
      </div>

      {err && <div className="text-xs text-danger">{err}</div>}

      {loadErr ? (
        <div className="text-xs text-danger">{t("errLoadFailed")}</div>
      ) : data === undefined ? (
        <div className="py-6 text-center text-sm text-op-muted">
          {t("loading")}
        </div>
      ) : shifts.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center">
          <div className="font-display text-lg mb-1">
            {t("shiftTodayEmptyTitle")}
          </div>
          <p className="text-sm text-op-muted">{t("shiftTodayEmptyBody")}</p>
        </div>
      ) : (
        <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
          {shifts.map((s) => (
            <div
              key={s.id}
              className="px-4 py-3 border-b border-op-border last:border-b-0 flex items-center gap-3"
            >
              <button
                type="button"
                onClick={() => onEdit(s)}
                className="flex-1 min-w-0 text-left"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium truncate">
                    {s.employee.name}
                  </span>
                  {s.cost.missingRate && (
                    <span className="px-2 h-5 inline-flex items-center rounded-full bg-[#C98A2E]/10 text-[#7F5A1F] text-[10px] font-medium shrink-0">
                      {t("staffNoRate")}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-op-muted mt-0.5 truncate">
                  {s.employee.position +
                    " · " +
                    rangeLabel(s) +
                    " · " +
                    money(s.cost.costCents)}
                </div>
                {(s.checkInAt || s.checkOutAt) && (
                  <div className="text-[11px] text-[#1E5339] mt-0.5 truncate tabular-nums">
                    {[
                      s.checkInAt &&
                        t("shiftCheckInAt", {
                          time: punchTime(s.checkInAt, locale),
                        }),
                      s.checkOutAt &&
                        t("shiftCheckOutAt", {
                          time: punchTime(s.checkOutAt, locale),
                        }),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                )}
              </button>
              {!s.checkInAt ? (
                <button
                  type="button"
                  onClick={() => punch(s, "check_in")}
                  disabled={busyId !== null}
                  className="min-h-[48px] px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40 shrink-0"
                >
                  {busyId === s.id ? t("saving") : t("shiftCheckIn")}
                </button>
              ) : !s.checkOutAt ? (
                <button
                  type="button"
                  onClick={() => punch(s, "check_out")}
                  disabled={busyId !== null}
                  className="min-h-[48px] px-5 rounded-full border border-op-border bg-op-surface text-sm font-medium hover:bg-op-bg disabled:opacity-40 shrink-0"
                >
                  {busyId === s.id ? t("saving") : t("shiftCheckOut")}
                </button>
              ) : (
                <span className="px-2 h-5 inline-flex items-center rounded-full bg-ok/10 text-[#1E5339] text-[10px] font-medium shrink-0">
                  {t("shiftAttendedBadge")}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ──────────────────────── Tab Equipo (D6.3) ────────────────────────── */

function TeamTab({
  currency,
  team,
  teamErr,
  onNew,
  onEdit,
}: {
  currency: string;
  team: TeamPayload | null;
  teamErr: boolean;
  onNew: () => void;
  onEdit: (e: EmployeeDto) => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onNew}
        className="w-full min-h-[44px] rounded-full bg-ink text-bone text-sm font-medium hover:bg-ink/90"
      >
        {t("staffNewEmployee")}
      </button>

      {teamErr ? (
        <div className="text-xs text-danger">{t("errLoadFailed")}</div>
      ) : team === null ? (
        <div className="py-6 text-center text-sm text-op-muted">
          {t("loading")}
        </div>
      ) : team.employees.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center">
          <div className="font-display text-lg mb-1">
            {t("staffTeamEmptyTitle")}
          </div>
          <p className="text-sm text-op-muted">{t("staffTeamEmptyBody")}</p>
        </div>
      ) : (
        <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
          {team.employees.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => onEdit(e)}
              className={
                "w-full text-left px-4 py-2.5 border-b border-op-border last:border-b-0 hover:bg-op-bg" +
                (e.active ? "" : " opacity-50")
              }
            >
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium truncate">
                      {e.name}
                    </span>
                    {!e.active && (
                      <span className="px-2 h-5 inline-flex items-center rounded-full bg-paper text-op-muted text-[10px] font-medium shrink-0">
                        {t("staffInactiveBadge")}
                      </span>
                    )}
                    {e.user && (
                      <span className="px-2 h-5 inline-flex items-center rounded-full bg-paper text-op-muted text-[10px] font-medium truncate">
                        {e.user.name ?? e.user.email}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-op-muted mt-0.5 truncate">
                    {e.position}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  {e.hourlyRateCents !== null ? (
                    <div className="text-sm font-medium tabular-nums">
                      {t("staffRatePerHour", {
                        rate: formatMoney(e.hourlyRateCents, {
                          currency,
                          locale,
                        }),
                      })}
                    </div>
                  ) : (
                    <div className="text-[11px] text-op-muted">
                      {t("staffNoRate")}
                    </div>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ──────────────── Crear/editar turno (sheet) ───────────────────────── */

const MIN_SHIFT_MINUTES = 15;
const MAX_SHIFT_MINUTES = 960;

function ShiftSheet({
  shift,
  fixedDate,
  defaultDate,
  employees,
  onClose,
  onChanged,
}: {
  /** null = crear. */
  shift: ShiftDto | null;
  /** "Turno extra" desde Hoy: la fecha queda fija. */
  fixedDate?: string;
  /** Default al crear desde Semana: hoy si es visible, si no el lunes. */
  defaultDate: string;
  employees: EmployeeDto[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations("opErp");

  const [employeeId, setEmployeeId] = useState(shift?.employeeId ?? "");
  const [date, setDate] = useState(
    shift ? shift.date.slice(0, 10) : (fixedDate ?? defaultDate),
  );
  const [fromTime, setFromTime] = useState(
    shift ? minutesToTime(shift.startMinutes) : "",
  );
  const [toTime, setToTime] = useState(
    shift ? minutesToTime(shift.endMinutes) : "",
  );
  const [note, setNote] = useState(shift?.note ?? "");
  const [checkIn, setCheckIn] = useState(
    shift?.checkInAt ? isoToLocalInput(shift.checkInAt) : "",
  );
  const [checkOut, setCheckOut] = useState(
    shift?.checkOutAt ? isoToLocalInput(shift.checkOutAt) : "",
  );
  const [busy, setBusy] = useState(false);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // El turno puede ser de un empleado ya inactivo: se agrega como opción
  // para que el select no quede vacío al editar (patrón supplierOptions).
  const employeeOptions = useMemo(() => {
    if (shift && !employees.some((e) => e.id === shift.employeeId)) {
      return [
        {
          id: shift.employeeId,
          name: shift.employee.name,
          position: shift.employee.position,
        },
        ...employees,
      ];
    }
    return employees;
  }, [shift, employees]);

  // "Hasta" ≤ "desde" = cruza medianoche (+1440): 18:00→02:00 es
  // 1080→1560 y el turno pertenece al día en que empieza (D2).
  const parsed = useMemo(() => {
    if (!fromTime || !toTime) return null;
    const start = timeToMinutes(fromTime);
    let end = timeToMinutes(toTime);
    const nextDay = end <= start;
    if (nextDay) end += 1440;
    return { start, end, nextDay, minutes: end - start };
  }, [fromTime, toTime]);

  const rangeInvalid =
    parsed !== null &&
    (parsed.minutes < MIN_SHIFT_MINUTES || parsed.minutes > MAX_SHIFT_MINUTES);

  async function save() {
    setErr(null);
    if ((!shift && !employeeId) || !date || parsed === null) {
      setErr(t("errShiftInvalid"));
      return;
    }
    if (rangeInvalid) {
      setErr(t("errShiftRange"));
      return;
    }
    // Editar siempre manda los dos punches (valor o null): el form ES el
    // estado completo del registro real — sin parches parciales ambiguos.
    const body = shift
      ? {
          action: "edit",
          startMinutes: parsed.start,
          endMinutes: parsed.end,
          note: note.trim() || null,
          checkInAt: localInputToIso(checkIn),
          checkOutAt: localInputToIso(checkOut),
        }
      : {
          employeeId,
          date,
          startMinutes: parsed.start,
          endMinutes: parsed.end,
          note: note.trim() || null,
        };
    setBusy(true);
    const r = await fetch(
      shift
        ? `/api/operator/staff-shifts/${shift.id}`
        : "/api/operator/staff-shifts",
      {
        method: shift ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const key = SHIFT_ERROR_KEYS[(j as { error?: string }).error ?? ""];
      setErr(key ? t(key) : t("errSaveFailed"));
      return;
    }
    onChanged();
  }

  async function clearPunch() {
    if (!shift || !window.confirm(t("shiftConfirmClearPunch"))) return;
    setErr(null);
    setBusy(true);
    const r = await fetch(`/api/operator/staff-shifts/${shift.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "clear_punch" }),
    });
    setBusy(false);
    if (!r.ok) {
      setErr(t("errSaveFailed"));
      return;
    }
    onChanged();
  }

  async function remove() {
    if (!shift || !window.confirm(t("shiftConfirmDelete"))) return;
    setErr(null);
    setDeletingBusy(true);
    const r = await fetch(`/api/operator/staff-shifts/${shift.id}`, {
      method: "DELETE",
    });
    setDeletingBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const key = SHIFT_ERROR_KEYS[(j as { error?: string }).error ?? ""];
      setErr(key ? t(key) : t("errSaveFailed"));
      return;
    }
    onChanged();
  }

  const anyBusy = busy || deletingBusy;

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-xl bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[92dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <h2 className="font-display text-2xl">
            {shift ? t("shiftEdit") : t("shiftNew")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2"
            aria-label={t("cancel")}
          >
            {"✕"}
          </button>
        </div>

        <div className="space-y-3">
          {/* Empleado y fecha se fijan al crear — el PATCH de edición
              solo ajusta rango/nota/punches (contrato del API). */}
          <Field label={t("shiftFieldEmployee")} required>
            <select
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              disabled={shift !== null}
              className={inputCls + " disabled:opacity-60"}
            >
              <option value="">{t("shiftSelectEmployee")}</option>
              {employeeOptions.map((e) => (
                <option key={e.id} value={e.id}>
                  {`${e.name} — ${e.position}`}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t("fieldDate")} required>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              disabled={shift !== null || fixedDate !== undefined}
              className={inputCls + " disabled:opacity-60"}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t("shiftFieldFrom")} required>
              <input
                type="time"
                value={fromTime}
                onChange={(e) => setFromTime(e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field
              label={t("shiftFieldTo")}
              required
              hint={parsed?.nextDay ? t("shiftNextDayHint") : undefined}
            >
              <input
                type="time"
                value={toTime}
                onChange={(e) => setToTime(e.target.value)}
                className={inputCls}
              />
            </Field>
          </div>

          {rangeInvalid && (
            <div className="text-xs text-danger">{t("errShiftRange")}</div>
          )}

          <Field label={t("fieldNotes")}>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={300}
              className={inputCls}
            />
          </Field>

          {/* Asistencia real (solo editar): ajustar a mano los tiempos
              punchados — "llegó 7:12 y nadie marcó" (D3). */}
          {shift && (
            <div className="pt-2 border-t border-op-border space-y-3">
              <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                {t("shiftPunchTitle")}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label={t("shiftFieldCheckIn")}>
                  <input
                    type="datetime-local"
                    value={checkIn}
                    onChange={(e) => setCheckIn(e.target.value)}
                    className={inputCls}
                  />
                </Field>
                <Field label={t("shiftFieldCheckOut")}>
                  <input
                    type="datetime-local"
                    value={checkOut}
                    onChange={(e) => setCheckOut(e.target.value)}
                    className={inputCls}
                  />
                </Field>
              </div>
              {(shift.checkInAt || shift.checkOutAt) && (
                <button
                  type="button"
                  onClick={clearPunch}
                  disabled={anyBusy}
                  className="min-h-[44px] px-3 rounded-full text-[11px] font-medium text-danger hover:bg-danger/10 disabled:opacity-40"
                >
                  {t("shiftClearPunch")}
                </button>
              )}
            </div>
          )}

          {err && <div className="text-xs text-danger">{err}</div>}

          <div className="flex items-center gap-3 pt-1">
            {shift && (
              <button
                type="button"
                onClick={remove}
                disabled={anyBusy}
                className="min-h-[44px] px-3 rounded-full text-[11px] font-medium text-danger hover:bg-danger/10 disabled:opacity-40"
              >
                {deletingBusy ? t("deleting") : t("deleteItem")}
              </button>
            )}
            <div className="flex-1" />
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] px-4 rounded-full bg-op-bg border border-op-border text-sm font-medium hover:bg-op-surface"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={save}
              disabled={
                anyBusy ||
                (!shift && employeeId === "") ||
                date === "" ||
                fromTime === "" ||
                toTime === ""
              }
              className="min-h-[44px] px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
            >
              {busy ? t("saving") : t("save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────── Crear/editar empleado (sheet) ─────────────────────── */

/** Horas/mes del hint de tarifa (≈ jornada mensual de referencia, D6.3). */
const MONTHLY_HOURS = 230;

function EmployeeSheet({
  employee,
  positions,
  users,
  currency,
  onClose,
  onChanged,
}: {
  /** null = crear. */
  employee: EmployeeDto | null;
  positions: string[];
  users: UserRef[];
  currency: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;

  const [name, setName] = useState(employee?.name ?? "");
  const [position, setPosition] = useState(employee?.position ?? "");
  // Tarifa en unidades de moneda (pesos) — el API habla en centavos.
  const [rateRaw, setRateRaw] = useState(
    employee?.hourlyRateCents != null
      ? String(employee.hourlyRateCents / 100)
      : "",
  );
  const [userId, setUserId] = useState(employee?.userId ?? "");
  const [active, setActive] = useState(employee?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // El vínculo puede apuntar a un usuario que ya no sale en la lista del
  // server (p. ej. cambió de rol): se agrega para no perder la referencia.
  const userOptions = useMemo(() => {
    if (employee?.user && !users.some((u) => u.id === employee.user!.id)) {
      return [employee.user, ...users];
    }
    return users;
  }, [employee, users]);

  const rateCents = useMemo(() => {
    if (rateRaw.trim() === "") return null;
    const pesos = Number(rateRaw.replace(",", "."));
    return isFinite(pesos) && pesos > 0 ? pesosToCents(pesos) : null;
  }, [rateRaw]);

  async function save() {
    setErr(null);
    const nm = name.trim();
    const pos = position.trim();
    if (!nm || !pos) {
      setErr(t("errEmployeeInvalid"));
      return;
    }
    if (rateRaw.trim() !== "" && (rateCents === null || rateCents < 1)) {
      setErr(t("errAmountInvalid"));
      return;
    }
    // Desactivar vía toggle pide confirm — los turnos históricos quedan
    // (soft-delete, mismo criterio que insumos).
    if (
      employee &&
      employee.active &&
      !active &&
      !window.confirm(t("staffConfirmDeactivate"))
    ) {
      return;
    }
    const body = {
      name: nm,
      position: pos,
      hourlyRateCents: rateCents,
      userId: userId || null,
      ...(employee ? { active } : {}),
    };
    setBusy(true);
    const r = await fetch(
      employee
        ? `/api/operator/employees/${employee.id}`
        : "/api/operator/employees",
      {
        method: employee ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const key = EMPLOYEE_ERROR_KEYS[(j as { error?: string }).error ?? ""];
      setErr(key ? t(key) : t("errSaveFailed"));
      return;
    }
    onChanged();
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-xl bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[92dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <h2 className="font-display text-2xl">
            {employee ? t("staffEditEmployee") : t("staffNewEmployee")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2"
            aria-label={t("cancel")}
          >
            {"✕"}
          </button>
        </div>

        <div className="space-y-3">
          <Field label={t("fieldName")} required>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              className={inputCls}
            />
          </Field>

          <Field label={t("staffFieldPosition")} required>
            <input
              type="text"
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              placeholder={t("staffPositionPlaceholder")}
              maxLength={60}
              list="staff-positions"
              className={inputCls}
            />
            <datalist id="staff-positions">
              {positions.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </Field>

          <Field
            label={t("staffFieldRate")}
            hint={
              rateCents !== null
                ? t("staffRateHint", {
                    monthly: formatMoney(rateCents * MONTHLY_HOURS, {
                      currency,
                      locale,
                    }),
                  })
                : undefined
            }
          >
            <input
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={rateRaw}
              onChange={(e) => setRateRaw(e.target.value)}
              className={inputCls}
            />
          </Field>

          {userOptions.length > 0 && (
            <Field label={t("staffFieldUser")}>
              <select
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                className={inputCls}
              >
                <option value="">{t("staffUserNone")}</option>
                {userOptions.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name ? `${u.name} — ${u.email}` : u.email}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {employee && (
            <label className="flex items-center gap-2 min-h-[44px] cursor-pointer">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
                className="w-4 h-4 accent-ink"
              />
              <span className="text-sm">{t("staffActiveToggle")}</span>
            </label>
          )}

          {err && <div className="text-xs text-danger">{err}</div>}

          <div className="flex items-center gap-3 pt-1">
            <div className="flex-1" />
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] px-4 rounded-full bg-op-bg border border-op-border text-sm font-medium hover:bg-op-surface"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy || name.trim() === "" || position.trim() === ""}
              className="min-h-[44px] px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
            >
              {busy ? t("saving") : t("save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────── UI compartida ──────────────────────── */

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
        {label}
        {required && <span className="text-danger ml-1">{"*"}</span>}
      </div>
      {children}
      {hint && <div className="text-[10px] text-op-muted mt-1">{hint}</div>}
    </label>
  );
}

const inputCls =
  "w-full min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";
