"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { CONTACT } from "./contact";

/** Botón compartir: Web Share API nativa con fallback a copiar el enlace. */
export function ShareButton() {
  const t = useTranslations("card");
  const [copied, setCopied] = useState(false);

  async function share() {
    const data = {
      title: `${CONTACT.fullName} — ${CONTACT.org}`,
      text: t("shareText"),
      url: CONTACT.cardUrl,
    };
    if (navigator.share) {
      try {
        await navigator.share(data);
        return;
      } catch {
        // usuario canceló — no hacer nada
        return;
      }
    }
    try {
      await navigator.clipboard.writeText(CONTACT.cardUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* clipboard no disponible */
    }
  }

  return (
    <button
      type="button"
      onClick={share}
      className="w-full h-11 rounded-full border border-hairline bg-paper text-ink text-sm font-medium hover:bg-ivory transition-colors"
    >
      {copied ? t("shareCopied") : t("shareBtn")}
    </button>
  );
}
