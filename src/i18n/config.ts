/**
 * Configuración central de i18n de MESAPAY.
 *
 * La app es trilingüe: español (default), inglés y portugués. NO usamos
 * el segmento de URL `/[lang]/` porque el routing ya entra por subdominio
 * (`resto.mesapay.co` → reescritura a `/t/slug` en middleware.ts). En vez
 * de eso el idioma vive en una cookie (`MESAPAY_LOCALE`) y, en la primera
 * visita sin cookie, se detecta del header `Accept-Language`.
 *
 * Idioma ≠ moneda. Un comensal brasileño leyendo en portugués en un
 * restaurante colombiano sigue pagando en COP. El idioma lo elige el
 * usuario; la moneda la define el país del restaurante (ver lib/format.ts).
 */
export const locales = ["es", "en", "pt"] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "es";

/** Cookie donde guardamos la preferencia de idioma del visitante. */
export const LOCALE_COOKIE = "MESAPAY_LOCALE";

/** Nombre nativo de cada idioma — para el selector. */
export const localeNames: Record<Locale, string> = {
  es: "Español",
  en: "English",
  pt: "Português",
};

export function isLocale(value: string | undefined | null): value is Locale {
  return !!value && (locales as readonly string[]).includes(value);
}

/**
 * Usa el idioma principal del dispositivo (mayor prioridad válida y no cero).
 * Las variantes regionales comparten idioma: pt-BR → pt. Si ese idioma no
 * está disponible, abre en español aunque el navegador sugiera otros idiomas.
 * En empates se conserva el orden del navegador. La elección manual guardada
 * tiene prioridad sobre esta detección (ver request.ts).
 */
export function matchLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return defaultLocale;
  const preferred = acceptLanguage.split(",").reduce<{ base: string; quality: number } | null>((best, part) => {
    const match = /^([a-z]{1,8}(?:-[a-z0-9]{1,8})*|\*)(?:\s*;\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?$/i.exec(part.trim());
    if (!match) return best;
    const quality = Number(match[2] ?? 1);
    if (quality === 0 || best && quality <= best.quality) return best;
    return { base: match[1].split("-")[0].toLowerCase(), quality };
  }, null);
  return isLocale(preferred?.base) ? preferred.base : defaultLocale;
}
