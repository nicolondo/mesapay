"use client";

import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { locales, localeNames, type Locale } from "@/i18n/config";
import { setLocale } from "@/i18n/actions";

/** Código corto que se muestra en la píldora (el detalle va en las opciones). */
const SHORT: Record<Locale, string> = { es: "ES", en: "EN", pt: "PT" };

/**
 * Selector de idioma. Se muestra como una píldora clara "🌐 ES" (alto
 * contraste, fácil de encontrar) con un <select> nativo transparente
 * encima que abre el picker del sistema. Persiste la elección en cookie
 * (server action) y refresca la ruta para re-renderizar con el catálogo
 * nuevo. Textos visibles desde datos (SHORT/localeNames) → pasa el
 * guardarraíl de i18n.
 */
export function LocaleSwitcher({ className }: { className?: string }) {
  const active = useLocale() as Locale;
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <label
      aria-label="Idioma / Language"
      className={
        "relative inline-flex items-center gap-1.5 h-9 rounded-full border border-ink/25 bg-paper px-3 cursor-pointer select-none " +
        (pending ? "opacity-60 " : "") +
        (className ?? "")
      }
    >
      <span aria-hidden className="text-[15px] leading-none">
        {"🌐"}
      </span>
      <span className="font-mono text-[11px] font-semibold tracking-wide text-ink">
        {SHORT[active] ?? "ES"}
      </span>
      <span aria-hidden className="text-[9px] text-muted leading-none">
        {"▾"}
      </span>
      <select
        value={active}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value as Locale;
          startTransition(async () => {
            await setLocale(next);
            router.refresh();
          });
        }}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
      >
        {locales.map((l) => (
          <option key={l} value={l}>
            {localeNames[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
