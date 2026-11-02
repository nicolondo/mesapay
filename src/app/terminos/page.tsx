import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { LegalDocumentView } from "@/components/legal/LegalDocumentView";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("legal");
  return {
    title: t("termsTitle"),
    description: t("termsDescription"),
    alternates: { canonical: "/terminos" },
    robots: { index: true, follow: true },
  };
}

/**
 * Términos de servicio. Pública: no exige sesión ni comercio, y el
 * middleware la sirve igual en el subdominio de un comercio. El texto vive
 * en `src/content/legal/terminos.ts`.
 */
export default async function TerminosPage() {
  const locale = (await getLocale()) as Locale;
  return <LegalDocumentView id="terminos" locale={locale} />;
}
