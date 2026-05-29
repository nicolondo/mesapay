/**
 * Lógica central del módulo de reservas. Igual que paymentMethods /
 * menuTags, el restaurante guarda un blob JSON (Restaurant.reservationConfig)
 * y este helper lo parsea con defaults sensatos.
 *
 * Diseño de slots:
 *   - Cada día de la semana tiene cero o más "turnos" (ej. almuerzo
 *     12:00–15:00, cena 19:00–23:00).
 *   - El sistema divide cada turno en slots de `slotMinutes` (default 90).
 *     Para almuerzo 12–15 con slots de 90min: 12:00, 13:30 → 2 slots.
 *   - Una reserva ocupa un slot completo de una mesa específica.
 *
 * Zona horaria: TODO en America/Bogota. startsAt/endsAt se guardan en
 * UTC pero se construyen e interpretan en hora local de Colombia
 * (UTC-5, sin DST — Colombia no cambia hora).
 */

export const BOGOTA_OFFSET_HOURS = -5;

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = domingo

/** Un turno dentro de un día: rango horario "HH:MM"–"HH:MM". */
export type Shift = {
  /** "12:00" — inicio del turno en hora local. */
  start: string;
  /** "15:00" — fin del turno (último slot empieza antes de esto). */
  end: string;
};

export type ReservationConfig = {
  /** Turnos por día de la semana. Índice = Weekday (0=dom..6=sáb). */
  shiftsByDay: Record<Weekday, Shift[]>;
  /** Duración de cada slot en minutos. También es cuánto dura la mesa
   *  ocupada por una reserva. */
  slotMinutes: number;
  /** Si true, las reservas nuevas quedan "confirmed" automáticamente.
   *  Si false, quedan "pending" hasta que el operador confirme. */
  autoConfirm: boolean;
  /** Anticipación mínima en horas: no se puede reservar para dentro de
   *  menos de X horas (default 1 = no reservas para "ya"). */
  minNoticeHours: number;
  /** Cuántos días hacia adelante se puede reservar (default 30). */
  maxAdvanceDays: number;
  /** Mensaje libre que se muestra al diner en la página de reserva
   *  (políticas, "tolerancia 15 min", etc). Opcional. */
  policyNote?: string;
};

/**
 * Default razonable: martes a domingo, almuerzo + cena, slots de 90min,
 * auto-confirm on, 1h de anticipación, hasta 30 días. Lunes cerrado
 * (típico en Colombia). El operador ajusta desde /operator/settings/reservas.
 */
export const DEFAULT_RESERVATION_CONFIG: ReservationConfig = {
  shiftsByDay: {
    0: [{ start: "12:00", end: "16:00" }], // domingo: solo almuerzo
    1: [], // lunes cerrado
    2: [
      { start: "12:00", end: "15:00" },
      { start: "19:00", end: "22:30" },
    ],
    3: [
      { start: "12:00", end: "15:00" },
      { start: "19:00", end: "22:30" },
    ],
    4: [
      { start: "12:00", end: "15:00" },
      { start: "19:00", end: "22:30" },
    ],
    5: [
      { start: "12:00", end: "15:00" },
      { start: "19:00", end: "23:30" },
    ],
    6: [
      { start: "12:00", end: "16:00" },
      { start: "19:00", end: "23:30" },
    ],
  },
  slotMinutes: 90,
  autoConfirm: true,
  minNoticeHours: 1,
  maxAdvanceDays: 30,
};

const WEEKDAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

function isValidHHMM(s: unknown): s is string {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function parseShifts(raw: unknown): Shift[] {
  if (!Array.isArray(raw)) return [];
  const out: Shift[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      isValidHHMM((item as Shift).start) &&
      isValidHHMM((item as Shift).end) &&
      (item as Shift).start < (item as Shift).end
    ) {
      out.push({ start: (item as Shift).start, end: (item as Shift).end });
    }
  }
  return out;
}

/**
 * Parsea el blob JSON de la DB a una config tipada. Cualquier cosa
 * malformada cae al default — nunca tira, así el módulo no rompe el
 * checkout si la config quedó corrupta.
 */
export function resolveReservationConfig(stored: unknown): ReservationConfig {
  if (!stored || typeof stored !== "object") {
    return DEFAULT_RESERVATION_CONFIG;
  }
  const o = stored as Record<string, unknown>;

  const shiftsByDay = {} as Record<Weekday, Shift[]>;
  const rawShifts =
    o.shiftsByDay && typeof o.shiftsByDay === "object"
      ? (o.shiftsByDay as Record<string, unknown>)
      : {};
  for (const d of WEEKDAYS) {
    shiftsByDay[d] = parseShifts(rawShifts[String(d)]);
  }
  // Si ningún día tiene turnos (config vacía), caemos al default para
  // no dejar el restaurante sin slots por accidente.
  const anyShift = WEEKDAYS.some((d) => shiftsByDay[d].length > 0);

  const slotMinutes =
    typeof o.slotMinutes === "number" && o.slotMinutes >= 30 && o.slotMinutes <= 240
      ? Math.round(o.slotMinutes)
      : DEFAULT_RESERVATION_CONFIG.slotMinutes;

  const minNoticeHours =
    typeof o.minNoticeHours === "number" && o.minNoticeHours >= 0 && o.minNoticeHours <= 168
      ? o.minNoticeHours
      : DEFAULT_RESERVATION_CONFIG.minNoticeHours;

  const maxAdvanceDays =
    typeof o.maxAdvanceDays === "number" && o.maxAdvanceDays >= 1 && o.maxAdvanceDays <= 365
      ? Math.round(o.maxAdvanceDays)
      : DEFAULT_RESERVATION_CONFIG.maxAdvanceDays;

  return {
    shiftsByDay: anyShift ? shiftsByDay : DEFAULT_RESERVATION_CONFIG.shiftsByDay,
    slotMinutes,
    autoConfirm:
      typeof o.autoConfirm === "boolean"
        ? o.autoConfirm
        : DEFAULT_RESERVATION_CONFIG.autoConfirm,
    minNoticeHours,
    maxAdvanceDays,
    policyNote:
      typeof o.policyNote === "string" && o.policyNote.trim()
        ? o.policyNote.trim().slice(0, 500)
        : undefined,
  };
}

/** "HH:MM" → minutos desde medianoche. */
function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export type Slot = {
  /** "HH:MM" hora local del inicio del slot. */
  label: string;
  /** Minutos desde medianoche (para ordenar / comparar). */
  startMinutes: number;
};

/**
 * Lista los slots disponibles para un día de la semana dado, según los
 * turnos configurados. Devuelve sólo los horarios de inicio — la
 * duración es config.slotMinutes.
 *
 * Ej: turno 12:00–15:00 con slotMinutes=90 → [12:00, 13:30].
 * El último slot debe TERMINAR dentro del turno (13:30+90=15:00 ✓;
 * 15:00 no entra porque 15:00+90 > 15:00).
 */
export function slotsForDay(
  config: ReservationConfig,
  weekday: Weekday,
): Slot[] {
  const shifts = config.shiftsByDay[weekday] ?? [];
  const slots: Slot[] = [];
  for (const shift of shifts) {
    const startM = hhmmToMinutes(shift.start);
    const endM = hhmmToMinutes(shift.end);
    for (let m = startM; m + config.slotMinutes <= endM; m += config.slotMinutes) {
      const h = Math.floor(m / 60);
      const min = m % 60;
      slots.push({
        label: `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`,
        startMinutes: m,
      });
    }
  }
  return slots;
}

/**
 * Construye el par {startsAt, endsAt} en UTC para una reserva dado un
 * día calendario (YYYY-MM-DD en hora Bogotá) + slot.
 *
 * Colombia es UTC-5 fijo (sin DST). Para una hora local L, el UTC es
 * L + 5h. Construimos la fecha como si fuera UTC y le sumamos el offset.
 */
export function slotToUtcRange(
  dateLocal: string, // "2026-06-15"
  slot: Slot,
  slotMinutes: number,
): { startsAt: Date; endsAt: Date } {
  const [y, mo, d] = dateLocal.split("-").map(Number);
  const localStartMs = Date.UTC(
    y,
    mo - 1,
    d,
    Math.floor(slot.startMinutes / 60),
    slot.startMinutes % 60,
  );
  // localStartMs representa la hora "como UTC". La hora real UTC es esa
  // + 5h porque Bogotá va 5h atrás de UTC.
  const startUtcMs = localStartMs - BOGOTA_OFFSET_HOURS * 60 * 60 * 1000;
  const startsAt = new Date(startUtcMs);
  const endsAt = new Date(startUtcMs + slotMinutes * 60 * 1000);
  return { startsAt, endsAt };
}

/**
 * Genera un confirmation code legible y suficientemente único. Formato
 * MP-XXXXXX con A-Z2-9 (sin O/0/I/1 para evitar confusión al dictarlo
 * por teléfono). Random — el caller debe garantizar unicidad contra
 * la DB (el campo tiene @unique, retry si choca).
 */
export function generateConfirmationCode(): string {
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `MP-${code}`;
}
