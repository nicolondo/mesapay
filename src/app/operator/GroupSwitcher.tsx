"use client";

import { useTransition } from "react";

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
  const [pending, startTx] = useTransition();
  if (siblings.length === 0) return null;
  return (
    <form action={action} className="inline-flex items-center gap-1.5">
      <label className="font-mono text-[10px] tracking-wider uppercase opacity-80">
        Cambiar a:
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
        className="bg-bone text-ink text-xs font-medium px-2 py-1 rounded-md border border-bone/40 cursor-pointer disabled:opacity-60"
      >
        <option value="" disabled>
          {pending ? "Cargando…" : "Elegí local"}
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
