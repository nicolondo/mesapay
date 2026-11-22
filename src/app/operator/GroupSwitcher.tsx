"use client";

import { useTransition } from "react";
import { useTranslations } from "next-intl";

/**
 * Dropdown chico en el header del operator que permite a un
 * group_admin (o platform_admin viendo un restaurante grupado)
 * saltar a otro local del grupo sin volver a /group.
 *
 * Recibe la server action por prop — el form submitta vía
 * onChange. Mientras procesa, deshabilita el select. Después del
 * redirect del server action, Next.js re-renderea con el contexto
 * nuevo.
 */
export function GroupSwitcher({
  siblings,
  action,
}: {
  siblings: { id: string; name: string }[];
  action: (formData: FormData) => void | Promise<void>;
}) {
  const t = useTranslations("operator");
  const [pending, startTx] = useTransition();
  if (siblings.length === 0) return null;
  return (
    <form action={action} className="min-w-0 inline-flex items-center gap-1.5">
      {/* En pantallas angostas la etiqueta se oculta: el placeholder del select
          ya dice qué hace, y la franja de impersonación debe ser una línea. */}
      <label className="hidden md:inline font-mono text-[10px] tracking-wider uppercase opacity-80">
        {t("switchTo")}
      </label>
      <select
        name="restaurantId"
        defaultValue=""
        disabled={pending}
        onChange={(e) => {
          const form = e.currentTarget.form;
          if (!form) return;
          startTx(() => {
            form.requestSubmit();
          });
        }}
        className="min-w-[3.5rem] max-w-[9rem] bg-bone text-ink text-xs font-medium px-2 py-1 rounded-md border border-bone/40 cursor-pointer disabled:opacity-60"
      >
        <option value="" disabled>
          {pending ? t("loading") : t("chooseLocal")}
        </option>
        {siblings.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
    </form>
  );
}
