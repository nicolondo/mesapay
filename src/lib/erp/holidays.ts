// Festivos por país (ERP Fase C2) — LÓGICA PURA, sin DB.
//
// CO: Ley 51 de 1983 ("Ley Emiliani") — fijos, trasladables al lunes
// siguiente y los dependientes de Pascua (calculada, no tabulada).
// MX: feriados obligatorios de la LFT (fijos + lunes móviles). Otros
// países: lista vacía hasta habilitarlos.
//
// Todo en fechas UTC "YYYY-MM-DD" — el mismo eje que StaffShift.date.

/** Domingo de Pascua (gregoriano) — algoritmo anónimo/Meeus. */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=marzo, 4=abril
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const DAY = 24 * 60 * 60 * 1000;

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY);
}

/** Regla Emiliani: si no cae lunes, se corre al lunes SIGUIENTE. */
function nextMondayIfNotMonday(d: Date): Date {
  const dow = d.getUTCDay(); // 0=domingo … 1=lunes
  if (dow === 1) return d;
  return addDays(d, ((8 - dow) % 7) || 7);
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fixed(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

/** N-ésimo lunes de un mes (1-based). */
function nthMonday(year: number, month: number, n: number): Date {
  const first = fixed(year, month, 1);
  const dow = first.getUTCDay();
  const firstMonday = addDays(first, (8 - dow) % 7);
  return addDays(firstMonday, (n - 1) * 7);
}

function colombia(year: number): Date[] {
  const easter = easterSunday(year);
  return [
    // Fijos (no se trasladan)
    fixed(year, 1, 1), // Año Nuevo
    fixed(year, 5, 1), // Día del Trabajo
    fixed(year, 7, 20), // Independencia
    fixed(year, 8, 7), // Batalla de Boyacá
    fixed(year, 12, 8), // Inmaculada Concepción
    fixed(year, 12, 25), // Navidad
    // Semana Santa (no se trasladan)
    addDays(easter, -3), // Jueves Santo
    addDays(easter, -2), // Viernes Santo
    // Trasladables al lunes siguiente (Emiliani)
    nextMondayIfNotMonday(fixed(year, 1, 6)), // Reyes Magos
    nextMondayIfNotMonday(fixed(year, 3, 19)), // San José
    nextMondayIfNotMonday(fixed(year, 6, 29)), // San Pedro y San Pablo
    nextMondayIfNotMonday(fixed(year, 8, 15)), // Asunción de la Virgen
    nextMondayIfNotMonday(fixed(year, 10, 12)), // Día de la Raza
    nextMondayIfNotMonday(fixed(year, 11, 1)), // Todos los Santos
    nextMondayIfNotMonday(fixed(year, 11, 11)), // Independencia de Cartagena
    // Dependientes de Pascua, trasladables (jueves/viernes → lunes)
    nextMondayIfNotMonday(addDays(easter, 39)), // Ascensión → E+43
    nextMondayIfNotMonday(addDays(easter, 60)), // Corpus Christi → E+64
    nextMondayIfNotMonday(addDays(easter, 68)), // Sagrado Corazón → E+71
  ];
}

function mexico(year: number): Date[] {
  const days = [
    fixed(year, 1, 1), // Año Nuevo
    nthMonday(year, 2, 1), // Día de la Constitución (1er lunes feb)
    nthMonday(year, 3, 3), // Natalicio de Benito Juárez (3er lunes mar)
    fixed(year, 5, 1), // Día del Trabajo
    fixed(year, 9, 16), // Independencia
    nthMonday(year, 11, 3), // Revolución (3er lunes nov)
    fixed(year, 12, 25), // Navidad
  ];
  // Transmisión del Poder Ejecutivo Federal: 1 oct cada 6 años (2024, 2030…).
  if ((year - 2024) % 6 === 0 && year >= 2024) days.push(fixed(year, 10, 1));
  return days;
}

/** Festivos del año como Set de "YYYY-MM-DD". País desconocido ⇒ vacío. */
export function holidaysForYear(
  country: string | null | undefined,
  year: number,
): Set<string> {
  const c = (country ?? "").toUpperCase();
  const list =
    c === "CO" ? colombia(year) : c === "MX" ? mexico(year) : [];
  return new Set(list.map(iso));
}

/** ¿La fecha (UTC) es festivo en el país? */
export function isHoliday(
  country: string | null | undefined,
  date: Date,
): boolean {
  return holidaysForYear(country, date.getUTCFullYear()).has(iso(date));
}

export function isSunday(date: Date): boolean {
  return date.getUTCDay() === 0;
}
