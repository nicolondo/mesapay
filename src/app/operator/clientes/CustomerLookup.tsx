"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

type Found = {
  id: string;
  name: string | null;
  email: string;
  cedula: string | null;
  discount: { percent: number; active: boolean; note: string | null } | null;
  /** Ya aparece en la lista de clientes de este restaurante. */
  inList: boolean;
};

/**
 * Buscador de comensal por cédula o correo EXACTOS, con la opción de
 * agregarlo a la lista de clientes del restaurante.
 *
 * Sirve para encontrar a alguien que todavía no ha comido acá (la identidad
 * es global) y abrirle su ficha. La búsqueda es exacta a propósito: un
 * "contiene" sobre correos convertiría esto en un directorio de comensales
 * de toda la plataforma.
 *
 * "Agregar a mis clientes" es la puerta para los comensales que ya existían
 * antes de que empezáramos a anotar de qué restaurante venían: el operador
 * los identifica acá (ya tenía que saberse la cédula o el correo) y el
 * vínculo queda guardado, así que la próxima vez los encuentra en la lista
 * sin buscar. Es un acto deliberado — no expone a nadie que el operador no
 * hubiera identificado ya.
 */
export function CustomerLookup() {
  const t = useTranslations("opCustomers");
  const router = useRouter();
  const [, startTx] = useTransition();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [found, setFound] = useState<Found | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFound(null);
    setNotFound(false);
    setErr(null);
    try {
      const res = await fetch(
        `/api/operator/customers?q=${encodeURIComponent(q)}`,
      );
      const j = await res.json().catch(() => ({}));
      if (j.customer) setFound(j.customer);
      else setNotFound(true);
    } finally {
      setBusy(false);
    }
  }

  async function addToList() {
    if (!found) return;
    setAdding(true);
    setErr(null);
    try {
      // El endpoint no recibe restaurantId: lo toma de la sesión.
      const res = await fetch(`/api/operator/customers/${found.id}/link`, {
        method: "POST",
      });
      if (!res.ok) {
        setErr(t("errGeneric"));
        return;
      }
      setFound({ ...found, inList: true });
      // La lista de abajo se rearma en el server, así que hay que
      // refrescarla para que la persona recién agregada aparezca.
      startTx(() => router.refresh());
    } catch {
      setErr(t("errGeneric"));
    } finally {
      setAdding(false);
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
        <>
          <button
            type="button"
            onClick={() => router.push(`/operator/clientes/${found.id}`)}
            className="mt-3 w-full text-left rounded-xl border border-hairline bg-ivory p-3 hover:border-terracotta"
          >
            <div className="font-display text-lg">
              {found.name ?? found.email}
            </div>
            <div className="font-mono text-[11px] text-muted">
              {found.cedula ?? found.email}
            </div>
            {found.discount && (
              <div className="font-mono text-[10px] tracking-wider uppercase text-terracotta mt-1">
                {t("discountBadge", { pct: found.discount.percent })}
              </div>
            )}
          </button>

          {found.inList ? (
            <div className="font-mono text-[10px] tracking-wider uppercase text-muted-2 mt-2">
              {t("alreadyInList")}
            </div>
          ) : (
            <button
              type="button"
              onClick={addToList}
              disabled={adding}
              className="mt-2 h-10 px-4 rounded-full border border-hairline text-sm font-medium disabled:opacity-60"
            >
              {adding ? t("addingToList") : t("addToList")}
            </button>
          )}
        </>
      )}

      {err && <div className="text-danger text-xs mt-3">{err}</div>}
    </div>
  );
}
