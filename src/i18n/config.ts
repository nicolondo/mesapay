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
 * Resuelve el mejor idioma soportado a partir de un header Accept-Language
 * (p. ej. "pt-BR,pt;q=0.9,en;q=0.8"). Toma la primera preferencia cuyo
 * idioma base esté soportado; si ninguna lo está, cae al default.
 */
export function matchLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return defaultLocale;
  const ranked = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, q] = part.trim().split(";q=");
      return { base: tag.split("-")[0].toLowerCase(), q: q ? parseFloat(q) : 1 };
    })
    .sort((a, b) => b.q - a.q);
  for (const { base } of ranked) {
    if (isLocale(base)) return base;
  }
  return defaultLocale;
}
