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
        "relative inline-flex items-center gap-1.5 h-9 rounded-full border border-ink/40 bg-ink/[0.045] px-3 shadow-sm cursor-pointer select-none hover:bg-ink/[0.08] transition-colors " +
        (pending ? "opacity-60 " : "") +
        (className ?? "")
      }
    >
      {/* Nombre completo donde hay espacio (desktop) para que se lea
          claramente como selector de idioma; en móvil cae al código. */}
      <span className="text-[12px] tracking-wide text-ink leading-none">
        <span className="hidden sm:inline font-medium">
          {localeNames[active]}
        </span>
        <span className="sm:hidden font-mono font-semibold">
          {SHORT[active] ?? "ES"}
        </span>
      </span>
      <span aria-hidden className="text-[9px] text-ink/60 leading-none">
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
