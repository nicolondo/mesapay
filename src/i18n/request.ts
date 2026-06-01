import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { isLocale, LOCALE_COOKIE, matchLocale, type Locale } from "./config";

/**
 * Config de next-intl por request (modo "without i18n routing").
 *
 * Orden de resolución del idioma:
 *   1. Cookie MESAPAY_LOCALE (preferencia explícita del usuario).
 *   2. Header Accept-Language del navegador (primera visita).
 *   3. Default (es).
 *
 * Devuelve también los mensajes del catálogo correspondiente. Al correr
 * sólo en el server, el tamaño de los catálogos no infla el bundle del
 * cliente (next-intl reenvía sólo lo necesario vía NextIntlClientProvider).
 */
export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get(LOCALE_COOKIE)?.value;

  let locale: Locale;
  if (isLocale(cookieLocale)) {
    locale = cookieLocale;
  } else {
    const headerStore = await headers();
    locale = matchLocale(headerStore.get("accept-language"));
  }

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
