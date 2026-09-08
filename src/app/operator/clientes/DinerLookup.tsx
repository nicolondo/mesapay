"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

type Found = {
  id: string;
  name: string | null;
  email: string;
  cedula: string | null;
  discount: { percent: number; active: boolean; note: string | null } | null;
};

/**
 * Buscador de comensal por cédula o correo EXACTOS, entre los de ESTE
 * comercio.
 *
 * Sigue existiendo aunque la lista de abajo ya muestre a todos: con cientos
 * de comensales, teclear la cédula es más rápido que buscar en la lista.
 * Lo que cambió es el alcance — antes encontraba a cualquiera de la
 * plataforma (la identidad era global) y hoy solo a los registrados acá.
 */
export function DinerLookup() {
  const t = useTranslations("opCustomers");
  const router = useRouter();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<Found | null>(null);
  const [notFound, setNotFound] = useState(false);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFound(null);
    setNotFound(false);
    try {
      const res = await fetch(
        `/api/operator/diners?q=${encodeURIComponent(q)}`,
      );
      const j = await res.json().catch(() => ({}));
      if (j.diner) setFound(j.diner);
      else setNotFound(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-hairline bg-paper p-5">
      <form onSubmit={search} className="flex gap-2 flex-wrap">
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("searchPlaceholder")}
          className="flex-1 min-w-[200px] h-10 px-3 rounded-lg border border-hairline bg-ivory focus:outline-none focus:border-terracotta"
        />
        <button
          type="submit"
          disabled={busy || q.trim().length === 0}
          className="h-10 px-4 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
        >
          {busy ? t("searching") : t("search")}
        </button>
      </form>

      {notFound && (
        <div className="text-sm text-muted mt-3">{t("searchNotFound")}</div>
      )}

      {found && (
        <button
          type="button"
          onClick={() => router.push(`/operator/clientes/${found.id}`)}
          className="mt-3 w-full text-left rounded-xl border border-hairline bg-ivory p-3 hover:border-terracotta"
        >
          <div className="font-display text-lg">{found.name ?? found.email}</div>
          <div className="font-mono text-[11px] text-muted">
            {found.cedula ?? found.email}
          </div>
          {found.discount && (
            <div className="font-mono text-[10px] tracking-wider uppercase text-terracotta mt-1">
              {t("discountBadge", { pct: found.discount.percent })}
            </div>
          )}
        </button>
      )}
    </div>
  );
}
