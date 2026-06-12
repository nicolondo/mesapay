import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ShareButton } from "./CardActions";
import { CONTACT } from "./contact";

export const metadata: Metadata = {
  title: "Nicolás Londoño — MESAPAY",
  description:
    "Gerente General de MESAPAY. Pide y paga desde la mesa con un QR — sin app.",
  openGraph: {
    type: "profile",
    title: "Nicolás Londoño — MESAPAY",
    description:
      "Gerente General de MESAPAY. Pide y paga desde la mesa con un QR — sin app.",
    url: CONTACT.cardUrl,
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
};

export default async function NicolasCardPage() {
  const t = await getTranslations("card");
  const waUrl = `https://wa.me/${CONTACT.waDigits}?text=${encodeURIComponent(t("waPrefill"))}`;

  return (
    <main className="min-h-dvh bg-bone flex flex-col items-center px-5 py-10">
      <div className="w-full max-w-sm">
        {/* Wordmark */}
        <div className="text-center mb-6">
          <div className="font-mono text-[11px] tracking-[0.35em] uppercase text-terracotta">
            {CONTACT.org}
          </div>
        </div>

        {/* Tarjeta */}
        <div className="rounded-3xl border border-hairline bg-paper overflow-hidden shadow-sm">
          {/* Franja superior de marca */}
          <div className="h-2 bg-terracotta" aria-hidden />

          <div className="px-6 pt-8 pb-6 text-center">
            <div className="w-20 h-20 mx-auto rounded-full bg-ink text-bone flex items-center justify-center font-display text-3xl">
              {CONTACT.initials}
            </div>
            <h1 className="font-display text-3xl mt-4 text-ink">
              {CONTACT.fullName}
            </h1>
            <p className="text-sm text-muted mt-1">
              {t("role")} · {CONTACT.org}
            </p>
            <p className="text-[13px] text-muted-2 mt-3 leading-relaxed">
              {t("tagline")}
            </p>
          </div>

          {/* Datos */}
          <div className="px-6 pb-2">
            <div className="rounded-2xl bg-ivory border border-hairline divide-y divide-hairline">
              <a href={`tel:${CONTACT.phoneE164}`} className="flex items-center justify-between px-4 py-3">
                <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
                  {t("phoneLabel")}
                </span>
                <span className="text-sm text-ink font-mono tracking-tight">
                  {CONTACT.phoneDisplay}
                </span>
              </a>
              <a href={`mailto:${CONTACT.email}`} className="flex items-center justify-between px-4 py-3">
                <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
                  {t("emailLabel")}
                </span>
                <span className="text-sm text-ink">{CONTACT.email}</span>
              </a>
              <a href={CONTACT.site} className="flex items-center justify-between px-4 py-3">
                <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
                  {t("webLabel")}
                </span>
                <span className="text-sm text-terracotta font-medium">
                  {CONTACT.siteDisplay}
                </span>
              </a>
            </div>
          </div>

          {/* Acciones */}
          <div className="p-6 space-y-2.5">
            <a
              href={waUrl}
              className="flex items-center justify-center gap-2 w-full h-12 rounded-full bg-[#25D366] text-white font-medium"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5" aria-hidden>
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
              </svg>
              {t("waBtn")}
            </a>
            <a
              href="/api/vcard/nicolas"
              className="flex items-center justify-center gap-2 w-full h-12 rounded-full bg-ink text-bone font-medium"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4" aria-hidden>
                <path d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" />
              </svg>
              {t("saveContact")}
            </a>
            <ShareButton />
          </div>
        </div>

        {/* Pie */}
        <div className="text-center mt-6">
          <a href={CONTACT.site} className="text-sm text-terracotta font-medium hover:underline">
            {t("knowMesapay")}
          </a>
          <p className="font-mono text-[10px] tracking-[0.2em] uppercase text-muted-2 mt-3">
            {CONTACT.siteDisplay}
          </p>
        </div>
      </div>
    </main>
  );
}
