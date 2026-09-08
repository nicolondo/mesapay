/**
 * Rango de fechas para los reportes por cliente. Por defecto, el MES EN
 * CURSO — que es lo que pide el feature.
 *
 * Funciones puras (sin DB, sin `now` implícito en las que importan) para
 * poder probarlas.
 */

/** ISO `YYYY-MM-DD`. */
export type IsoDate = string;

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(v: string | null | undefined): v is IsoDate {
  return !!v && ISO_RE.test(v);
}

/**
 * Primer y último día del mes al que pertenece `ref`.
 *
 * Se trabaja en la zona del comercio (America/Bogota, como el resto de los
 * reportes) para que "este mes" signifique lo mismo que en el cierre de
 * turno y no se corra un día por UTC.
 */
export function currentMonthRange(
  ref: Date = new Date(),
  timeZone = "America/Bogota",
): { from: IsoDate; to: IsoDate } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ref); // en-CA da YYYY-MM-DD
  const [y, m] = parts.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return {
    from: `${y}-${mm}-01`,
    to: `${y}-${mm}-${String(lastDay).padStart(2, "0")}`,
  };
}

/**
 * Convierte el rango ISO a los límites `Date` que usa la consulta.
 * `to` es INCLUSIVO: el usuario que escribe 31 de marzo espera ver lo del
 * 31 de marzo, no quedarse en la medianoche del 30.
 */
export function isoRangeToDates(
  from: IsoDate,
  to: IsoDate,
  timeZone = "America/Bogota",
): { gte: Date; lt: Date } {
  // Bogotá es UTC-5 todo el año (sin horario de verano), así que el
  // corrimiento es constante y no hace falta una librería de zonas.
  const offset = timeZone === "America/Bogota" ? "-05:00" : "+00:00";
  const gte = new Date(`${from}T00:00:00${offset}`);
  const toDate = new Date(`${to}T00:00:00${offset}`);
  const lt = new Date(toDate.getTime() + 24 * 60 * 60 * 1000);
  return { gte, lt };
}

/**
 * Resuelve el rango efectivo a partir de lo que venga en la URL, cayendo
 * al mes en curso cuando falta o viene mal formado.
 */
export function resolveRange(
  from: string | undefined,
  to: string | undefined,
  ref: Date = new Date(),
): { from: IsoDate; to: IsoDate } {
  const fallback = currentMonthRange(ref);
  const f = isIsoDate(from) ? from : fallback.from;
  const t = isIsoDate(to) ? to : fallback.to;
  // Rango invertido (el usuario tecleó al revés): se ordena en vez de
  // devolver una lista vacía sin explicación.
  return f <= t ? { from: f, to: t } : { from: t, to: f };
}

/**
 * Where de la consulta "qué consumió este cliente" — la ÚNICA forma en que
 * se debe armar.
 *
 * Existe como función aparte, y no inline en la página, por una razón
 * concreta: `email` es único en toda la plataforma, así que un mismo
 * comensal puede tener facturas de varios restaurantes MESAPAY. Si alguien
 * olvidara el `restaurantId` en el where, el restaurante A vería lo que esa
 * persona gastó en el B — una fuga de datos entre clientes de la
 * plataforma. Acá el filtro no es opcional: es un parámetro obligatorio, y
 * hay un test que verifica que siempre sale en el resultado.
 */
export function customerOrdersWhere(args: {
  restaurantId: string;
  customerId: string;
  from: IsoDate;
  to: IsoDate;
  timeZone?: string;
}): {
  restaurantId: string;
  customerId: string;
  status: "paid";
  paidAt: { gte: Date; lt: Date };
} {
  const { gte, lt } = isoRangeToDates(args.from, args.to, args.timeZone);
  return {
    restaurantId: args.restaurantId,
    customerId: args.customerId,
    status: "paid",
    paidAt: { gte, lt },
  };
}
