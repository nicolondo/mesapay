"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * Form mini para asignar un restaurante existente (sin grupo) al
 * grupo actual. Reusa PATCH /api/admin/restaurants/[id] con
 * { groupId } — el endpoint ya valida scope + audit log.
 *
 * El listado de candidatos viene del server (solo restaurantes con
 * groupId=null) para no exponer la lista completa al cliente.
 */
export function AddRestaurantToGroup({
  groupId,
  candidates,
}: {
  groupId: string;
  candidates: { id: string; name: string; slug: string }[];
}) {
  const t = useTranslations("opAdminGroups");
  const router = useRouter();
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (candidates.length === 0) {
    return (
      <div className="text-[11px] text-op-muted">
        {t("noUngrouped")}
      </div>
    );
  }

  async function add() {
    if (!selected) return;
    setErr(null);
    setBusy(true);
    const res = await fetch(`/api/admin/restaurants/${selected}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ groupId }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? t("assignFailed"));
      return;
    }
    setSelected("");
    startTransition(() => router.refresh());
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta min-w-[14rem]"
      >
        <option value="">{t("chooseUngrouped")}</option>
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>
            {t("candidateOption", { name: c.name, slug: c.slug })}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={add}
        disabled={!selected || busy}
        className="h-10 px-4 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
      >
        {busy ? t("assigning") : t("assignToGroup")}
      </button>
      {err && <div className="text-xs text-danger basis-full">{err}</div>}
    </div>
  );
}
