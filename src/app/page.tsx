import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { Faq, getLandingFaqs } from "@/components/landing/Faq";
import { FinalCta } from "@/components/landing/FinalCta";
import { Flow } from "@/components/landing/Flow";
import { Hero } from "@/components/landing/Hero";
import { Onboarding } from "@/components/landing/Onboarding";
import { Pains } from "@/components/landing/Pains";
import { Plans } from "@/components/landing/Plans";
import { ProductTour } from "@/components/landing/ProductTour";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { SiteHeader } from "@/components/landing/SiteHeader";
import { CONTACT_EMAIL, SECTION } from "@/components/landing/links";

export const dynamic = "force-dynamic";

const SITE_URL = "https://mesapay.co";
const OG_LOCALE: Record<string, string> = {
  es: "es_CO",
  en: "en_US",
  pt: "pt_BR",
};

/**
 * Metadatos de la landing en el idioma del visitante. Reemplazan los
 * genéricos del layout (que todavía hablan de "carta digital") sólo para
 * mesapay.co/; el resto de páginas sigue heredando los del layout.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("landing.meta");
  const locale = await getLocale();
  return {
    title: { absolute: t("title") },
    description: t("description"),
    alternates: { canonical: "/" },
    openGraph: {
      type: "website",
      siteName: "MESAPAY",
      url: SITE_URL,
      locale: OG_LOCALE[locale] ?? "es_CO",
      title: t("ogTitle"),
      description: t("ogDescription"),
      images: [
        { url: "/og.png", width: 1200, height: 630, alt: t("ogImageAlt") },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: t("ogTitle"),
      description: t("ogDescription"),
      images: ["/og.png"],
    },
  };
}

/**
 * mesapay.co — la página principal presenta el ERP completo (mismo mensaje
 * que la presentación comercial pública) con capturas reales del producto.
 * Todo es Server Component; el único JS de cliente es el `Reveal` de las
 * animaciones al hacer scroll y el selector de idioma del pie.
 */
export default async function Landing() {
  // Staff that landed here while logged in — typically because their
  // PWA's start_url is "/" and iOS reopened the app from the home
  // screen — get bounced to their proper dashboard. Without this
  // they'd see the marketing landing every time they re-launched
  // the saved app, which feels broken.
  //
  // Customers stay on the landing as before. Sign-out always
  // redirects to /signin, so a fresh open after logout lands at the
  // login form (not here) until the next session begins.
  const session = await auth();
  const role = session?.user?.role;
  if (role === "mesero") redirect("/mesero/salon");
  if (role === "kitchen") redirect("/cocina");
  if (role === "bar") redirect("/bar");
  if (role === "terminal") redirect("/terminal");
  if (role === "operator") redirect("/operator");
  if (role === "platform_admin") redirect("/admin");

  return (
    <div className="flex flex-1 flex-col bg-bone text-ink">
      {/* Sin JS, los bloques con Reveal quedarían invisibles: se muestran. */}
      <noscript>
        <style>{".reveal{opacity:1!important;transform:none!important}"}</style>
      </noscript>
      <SeoJsonLd />
      <SiteHeader />
      <main id={SECTION.content} className="flex-1">
        <Hero />
        <Pains />
        <ProductTour />
        <Flow />
        <Onboarding />
        <Plans />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}

/* ---------------- SEO: datos estructurados ---------------- */

async function SeoJsonLd() {
  const t = await getTranslations("landing.meta");
  const faqs = await getLandingFaqs();
  const data = [
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "MESAPAY",
      url: SITE_URL,
      logo: `${SITE_URL}/og.png`,
      email: CONTACT_EMAIL,
    },
    {
      // Sin `offers`: los precios no se publican (mensualidad por local
      // según mesas y sedes, se cotiza en la demo).
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "MESAPAY",
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      url: SITE_URL,
      description: t("appDescription"),
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faqs.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    },
  ];
  return (
    <script
      type="application/ld+json"
      // `<` escapado: ningún texto del catálogo puede cerrar el <script>.
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, "\\u003c"),
      }}
    />
  );
}
