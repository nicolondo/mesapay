// Fecha y hora FISCAL colombiana de los documentos DIAN.
//
// Un documento electrónico declara CUÁNDO se emitió en tres lugares que
// tienen que decir lo mismo: `cbc:IssueDate` + `cbc:IssueTime` del XML,
// la cadena del CUFE/CUDE (FecFac + HorFac, Anexo Técnico 1.9) y el
// `xades:SigningTime` de la firma. Todos en hora legal colombiana.
//
// Antes cada uno se armaba por su lado y la fecha salía del día UTC
// (`now.toISOString().slice(0, 10)`) con la hora de Bogotá: de 7 p. m. a
// medianoche la factura declaraba el DÍA SIGUIENTE (y el 30 de septiembre
// por la noche, octubre: otro período de IVA/INC). La firma, a su vez,
// tomaba el reloj UTC y le pegaba "-05:00", o sea cinco horas en el
// futuro. Este archivo es el único lugar donde se decide la fecha fiscal.
//
// Colombia está en UTC−5 todo el año (sin horario de verano desde 1993),
// así que el cálculo es aritmético, como en `@/lib/bogota`: no depende de
// la zona horaria del servidor ni de los datos ICU de Node (el
// `toLocaleTimeString` de antes podía devolver "24:30:00" a las 00:30 con
// algunas versiones de ICU).
import { addDaysIso } from "@/lib/bogota";

/** Desfase de Colombia respecto de UTC, fijo. */
const BOGOTA_OFFSET_MS = -5 * 60 * 60 * 1000;

/** Sufijo de zona que llevan IssueTime y SigningTime. */
export const DIAN_UTC_OFFSET = "-05:00";

export type DianDateTime = {
  /** "YYYY-MM-DD": el día calendario en Colombia. */
  date: string;
  /** "HH:MM:SS-05:00": la hora en Colombia, con el desfase explícito. */
  time: string;
};

/**
 * Fecha y hora de emisión que declara un documento DIAN emitido en el
 * instante `at`. `date` va a `cbc:IssueDate` y `time` a `cbc:IssueTime`, y
 * los dos al CUFE: por eso salen JUNTOS del mismo instante — si se
 * calcularan por separado podrían caer a lados distintos de la medianoche.
 *
 * Los segundos se truncan (nunca se redondean): 20:59:59.999 es "20:59:59".
 */
export function dianIssueDateTime(at: Date): DianDateTime {
  const ms = at.getTime();
  if (Number.isNaN(ms)) {
    throw new RangeError("dianIssueDateTime: fecha inválida");
  }
  // El reloj de pared de Bogotá leído como si fuera UTC.
  const wall = new Date(ms + BOGOTA_OFFSET_MS).toISOString();
  return {
    date: wall.slice(0, 10),
    time: `${wall.slice(11, 19)}${DIAN_UTC_OFFSET}`,
  };
}

/**
 * `xades:SigningTime` para el instante `at`: "YYYY-MM-DDTHH:MM:SS-05:00".
 * Se pasa el MISMO `at` de la emisión para que la firma y el IssueDate
 * declaren el mismo día aunque el envío cruce la medianoche.
 */
export function dianSigningTime(at: Date): string {
  const { date, time } = dianIssueDateTime(at);
  return `${date}T${time}`;
}

/**
 * Vencimiento "YYYY-MM-DD" = fecha de emisión DECLARADA + `days` días
 * calendario. `issueDate` tiene que ser la fecha colombiana (la de
 * `dianIssueDateTime`), nunca la UTC. Plazo negativo ⇒ vence el mismo día.
 */
export function dianDueDate(issueDate: string, days: number): string {
  return addDaysIso(issueDate, Math.max(0, Math.trunc(days)));
}
