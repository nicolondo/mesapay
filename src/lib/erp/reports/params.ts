/**
 * Validación de la query de los reportes (zod), compartida por las rutas
 * API y las páginas. Fechas `yyyy-mm-dd`; cuentas = dígitos (prefijo PUC).
 */
import { z } from "zod";
import { isIsoDate, resolveReportPeriod, todayIso, type ResolvedPeriod } from "./period";

const isoDate = z
  .string()
  .refine((v) => isIsoDate(v), { message: "date" });

const accountPrefix = z.string().regex(/^\d{1,10}$/);

/** `?desde&hasta&anio&format`, común a todos los reportes. */
export const baseReportQuery = z.object({
  desde: isoDate.optional(),
  hasta: isoDate.optional(),
  anio: z.string().regex(/^\d{4}$/).optional(),
  format: z.enum(["csv"]).optional(),
});

export const trialBalanceQuery = baseReportQuery.extend({
  nivel: z.enum(["1", "2", "4", "6"]).optional(),
  cta1: accountPrefix.optional(),
  cta2: accountPrefix.optional(),
});

export const generalLedgerQuery = baseReportQuery.extend({
  cuenta: accountPrefix.optional(),
});

export const dailyBookQuery = baseReportQuery.extend({
  modo: z.enum(["detallado", "resumido"]).optional(),
});

/** Cartera: `?vista=todas|cxc|cxp&hasta[&format=csv]` (sin `desde`: es un corte a una fecha). */
export const carteraQuery = z.object({
  vista: z.enum(["todas", "cxc", "cxp"]).optional(),
  hasta: isoDate.optional(),
  format: z.enum(["csv"]).optional(),
});

/** Extracto de cartera de un tercero: sólo la fecha de corte. */
export const carteraStatementQuery = z.object({
  hasta: isoDate.optional(),
});

/** Query string → objeto plano (las claves vacías se descartan). */
export function searchParamsToObject(sp: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of sp.entries()) if (v !== "") out[k] = v;
  return out;
}

/**
 * Período validado: `desde ≤ hasta`. Devuelve null si el rango está al
 * revés (la ruta responde 400 `invalid`).
 */
export function periodFromQuery(
  q: { desde?: string; hasta?: string; anio?: string },
  today: string = todayIso(),
): ResolvedPeriod | null {
  const period = resolveReportPeriod({ ...q, today });
  return period.desde <= period.hasta ? period : null;
}
