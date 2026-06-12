import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { CONTACT } from "../contact";

export const metadata: Metadata = {
  title: "QR — Nicolás Londoño · MESAPAY",
  robots: { index: false },
};

/**
 * Modo presentación: Nicolás abre esta página y muestra el QR — quien lo
 * escanea cae en /nicolas con la tarjeta completa (guardar contacto,
 * WhatsApp, etc.).
 */
export default async function NicolasQrPage() {
  const t = await getTranslations("card");

  return (
    <main className="min-h-dvh bg-bone flex flex-col items-center justify-center px-5 py-10">
      <div className="w-full max-w-sm text-center">
        <div className="font-mono text-[11px] tracking-[0.35em] uppercase text-terracotta mb-6">
          {CONTACT.org}
        </div>

        <div className="rounded-3xl border border-hairline bg-paper p-7 shadow-sm">
          <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-muted mb-5">
            {t("qrLabel")}
          </div>
          <div className="mx-auto w-fit rounded-2xl bg-white p-4 border border-hairline">
            <Image
              src="/card/nicolas-qr.svg"
              alt={t("qrAlt")}
              width={260}
              height={260}
              priority
              unoptimized
            />
          </div>
          <h1 className="font-display text-2xl mt-6 text-ink">
            {CONTACT.fullName}
          </h1>
          <p className="text-sm text-muted mt-1">
            {t("role")} · {CONTACT.org}
          </p>
          <p className="text-[13px] text-muted-2 mt-4">{t("qrHint")}</p>
          <p className="font-mono text-[11px] tracking-wider text-terracotta mt-2">
            {CONTACT.cardUrlDisplay}
          </p>
        </div>

        <Link
          href="/nicolas"
          className="inline-block mt-6 text-sm text-terracotta font-medium hover:underline"
        >
          {t("viewCard")}
        </Link>
      </div>
    </main>
  );
}
