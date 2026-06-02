/**
 * Traductor para emails y otros render fuera del scope de un request.
 *
 * `getTranslations`/`useTranslations` de next-intl dependen del request
 * config (que en MESAPAY lee la cookie MESAPAY_LOCALE). Pero un email se
 * renderiza en el idioma del DESTINATARIO — que puede no coincidir con
 * quien dispara el envío (p. ej. el operador cobra en caja y el correo
 * sale para el comensal). Por eso resolvemos el idioma explícitamente y
 * cargamos el catálogo a mano con `createTranslator` (API pura de
 * next-intl, sin contexto de request).
 *
 * Uso:
 *   const { t, locale } = await getEmailTranslator(order.locale, "emailInvoice");
 *   const subject = t("subject", { name });
 */
import { createTranslator } from "next-intl";
import { defaultLocale, isLocale, type Locale } from "@/i18n/config";

type Translator = ReturnType<typeof createTranslator>;

export async function getEmailTranslator(
  localeInput: string | null | undefined,
  namespace: string,
): Promise<{ t: Translator; locale: Locale }> {
  const locale: Locale = isLocale(localeInput) ? localeInput : defaultLocale;
  const messages = (await import(`../../messages/${locale}.json`)).default;
  const t = createTranslator({ locale, messages, namespace });
  return { t, locale };
}
