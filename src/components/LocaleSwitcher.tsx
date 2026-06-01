"use client";

import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { locales, localeNames, type Locale } from "@/i18n/config";
import { setLocale } from "@/i18n/actions";

/**
 * Selector de idioma. Persiste la elección en cookie (server action) y
 * refresca la ruta para re-renderizar con el catálogo nuevo. Los textos
 * visibles salen de `localeNames` (datos), no hardcodeados en JSX, así
 * que pasa el guardarraíl de i18n.
 */
export function LocaleSwitcher({ className }: { className?: string }) {
  const active = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <select
      aria-label="Language"
      value={active}
      disabled={pending}
      onChange={(e) => {
        const next = e.target.value as Locale;
        startTransition(async () => {
          await setLocale(next);
          router.refresh();
        });
      }}
      className={
        className ??
        "rounded-lg border border-ink/15 bg-white px-2 py-1 text-sm text-ink disabled:opacity-50"
      }
    >
      {locales.map((l) => (
        <option key={l} value={l}>
          {localeNames[l]}
        </option>
      ))}
    </select>
  );
}
