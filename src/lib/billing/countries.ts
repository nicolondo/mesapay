import { db } from "@/lib/db";

/**
 * Países donde opera la plataforma. Fuente única (modelo CrmCountry):
 * gobierna las opciones de país al crear/editar restaurantes Y la moneda
 * de cobro (suscripción + pagos de comensales). Server-only (usa Prisma).
 */

export type Currency = "COP" | "MXN";

export type EnabledCountry = {
  code: string; // ISO-2
  name: string;
  currency: Currency;
};

// Fallback cuando no hay ningún país habilitado en config: evita dejar
// la creación de restaurantes sin opciones (lockout). Son los dos
// mercados de arranque.
const FALLBACK: EnabledCountry[] = [
  { code: "CO", name: "Colombia", currency: "COP" },
  { code: "MX", name: "México", currency: "MXN" },
];

/** Normaliza el string crudo de DB a una moneda soportada (default COP). */
export function coerceCurrency(raw: string | null | undefined): Currency {
  return raw?.trim().toUpperCase() === "MXN" ? "MXN" : "COP";
}

/**
 * Países habilitados (con su moneda) para poblar los selectores de
 * creación/edición de restaurante. Si no hay ninguno habilitado en
 * config, devuelve el fallback CO/MX para no bloquear el alta.
 */
export async function getEnabledCountries(): Promise<EnabledCountry[]> {
  const rows = await db.crmCountry.findMany({
    where: { enabled: true },
    select: { code: true, name: true, currency: true },
    orderBy: { name: "asc" },
  });
  if (rows.length === 0) return FALLBACK;
  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    currency: coerceCurrency(r.currency),
  }));
}

/**
 * Moneda de cobro del país (ISO-2). Lee la config; si el país no está
 * configurado cae al default histórico (MX→MXN, resto→COP).
 */
export async function getCurrencyForCountry(
  country: string | null | undefined,
): Promise<Currency> {
  const code = country?.trim().toUpperCase();
  if (!code) return "COP";
  const row = await db.crmCountry.findUnique({
    where: { code },
    select: { currency: true },
  });
  if (row?.currency) return coerceCurrency(row.currency);
  return code === "MX" ? "MXN" : "COP";
}

/** ¿Está el país habilitado para crear restaurantes? (respeta el fallback) */
export async function isCountryEnabled(
  country: string | null | undefined,
): Promise<boolean> {
  const code = country?.trim().toUpperCase();
  if (!code) return false;
  const enabled = await getEnabledCountries();
  return enabled.some((c) => c.code === code);
}
