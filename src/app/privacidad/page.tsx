import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { LegalDocumentView } from "@/components/legal/LegalDocumentView";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("legal");
  return {
    title: t("privacyTitle"),
    description: t("privacyDescription"),
    alternates: { canonical: "/privacidad" },
    robots: { index: true, follow: true },
  };
}

/**
 * Política de tratamiento de datos personales. Pública: no exige sesión ni
 * comercio, y el middleware la sirve igual en el subdominio de un comercio.
 * El texto vive en `src/content/legal/privacidad.ts`.
 */
export default async function PrivacidadPage() {
  const locale = (await getLocale()) as Locale;
  return <LegalDocumentView id="privacidad" locale={locale} />;
}
