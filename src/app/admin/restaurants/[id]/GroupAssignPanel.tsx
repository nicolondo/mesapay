"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * Panel para asignar/reasignar/desvincular el grupo del restaurante.
 *
 * Diseño UX: dropdown con todas las opciones + "Sin grupo". El user
 * selecciona y se habilita un botón "Guardar" — preferimos confirmación
 * explícita porque mover un comercio entre grupos también limpia
 * legalEntityId (las RS son del grupo viejo) y queremos que el admin
 * vea ese cambio antes de aceptar.
 */
export function GroupAssignPanel({
  restaurantId,
  initialGroupId,
  groups,
  currentLegalEntityName,
}: {
  restaurantId: string;
  initialGroupId: string | null;
  groups: { id: string; name: string; slug: string }[];
  currentLegalEntityName: string | null;
}) {
  const t = useTranslations("opAdmin");
  const router = useRouter();
  const [selected, setSelected] = useState<string>(initialGroupId ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const dirty = selected !== (initialGroupId ?? "");
  const initialGroup = groups.find((g) => g.id === initialGroupId) ?? null;
  const nextGroup = groups.find((g) => g.id === selected) ?? null;
  // Aviso visible cuando hay LegalEntity y el cambio implica limpiarla.
  const willClearLegalEntity = dirty && currentLegalEntityName !== null;

  async function save() {
    setErr(null);
    setBusy(true);
    const res = await fetch(`/api/admin/restaurants/${restaurantId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        groupId: selected === "" ? null : selected,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? t("saveError"));
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-4 mb-4">
      <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-3">
        {t("groupTitle")}
      </div>
      <div className="text-sm mb-3">
        {initialGroup ? (
          <>
            {t("groupBelongsTo")} <strong>{initialGroup.name}</strong>{" "}
            <span className="font-mono text-[11px] text-op-muted">
              /{initialGroup.slug}
            </span>
          </>
        ) : (
          <span className="text-op-muted">{t("groupNone")}</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta min-w-[14rem]"
        >
          <option value="">{t("groupNoneOption")}</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {t("groupOption", { name: g.name, slug: g.slug })}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || busy}
          className="mp-btn mp-btn--primary mp-btn--sm"
        >
          {busy ? t("saving") : t("save")}
        </button>
        {dirty && (
          <button
            type="button"
            onClick={() => {
              setSelected(initialGroupId ?? "");
              setErr(null);
            }}
            disabled={busy}
            className="mp-btn mp-btn--ghost mp-btn--sm"
          >
            {t("cancel")}
          </button>
        )}
      </div>

      {willClearLegalEntity && (
        <div className="mt-3 text-[11px] text-[#7F5A1F] bg-[#C98A2E]/10 border border-[#C98A2E]/30 rounded-lg px-3 py-2">
          <span aria-hidden>{"⚠"}</span>{" "}
          {t.rich("groupWillClearLegalEntity", {
            name: currentLegalEntityName,
            strong: (chunks) => <strong>{chunks}</strong>,
            code: (chunks) => <span className="font-mono">{chunks}</span>,
          })}
        </div>
      )}
      {dirty && !willClearLegalEntity && nextGroup && (
        <div className="mt-3 text-[11px] text-op-muted">
          {t.rich("groupWillAssign", {
            name: nextGroup.name,
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </div>
      )}
      {dirty && !willClearLegalEntity && !nextGroup && initialGroup && (
        <div className="mt-3 text-[11px] text-op-muted">
          {t("groupWillRemove")}
        </div>
      )}
      {err && (
        <div className="mt-3 text-xs text-danger">{err}</div>
      )}
    </div>
  );
}
