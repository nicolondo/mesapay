"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

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
      setErr(j.error ?? "No pudimos guardar el cambio.");
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-4 mb-4">
      <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-3">
        Grupo
      </div>
      <div className="text-sm mb-3">
        {initialGroup ? (
          <>
            Pertenece a <strong>{initialGroup.name}</strong>{" "}
            <span className="font-mono text-[11px] text-op-muted">
              /{initialGroup.slug}
            </span>
          </>
        ) : (
          <span className="text-op-muted">Sin grupo asignado.</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta min-w-[14rem]"
        >
          <option value="">Sin grupo</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} (/{g.slug})
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || busy}
          className="h-10 px-4 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
        >
          {busy ? "Guardando…" : "Guardar"}
        </button>
        {dirty && (
          <button
            type="button"
            onClick={() => {
              setSelected(initialGroupId ?? "");
              setErr(null);
            }}
            disabled={busy}
            className="h-10 px-3 rounded-full text-sm text-op-muted hover:text-op-text"
          >
            Cancelar
          </button>
        )}
      </div>

      {willClearLegalEntity && (
        <div className="mt-3 text-[11px] text-[#7F5A1F] bg-[#C98A2E]/10 border border-[#C98A2E]/30 rounded-lg px-3 py-2">
          ⚠ El comercio tiene asignada la razón social{" "}
          <strong>{currentLegalEntityName}</strong> del grupo actual. Al
          cambiar de grupo esa razón se desvincula y deberá asignarse una
          del grupo destino desde{" "}
          <span className="font-mono">/operator/settings/identidad</span>.
        </div>
      )}
      {dirty && !willClearLegalEntity && nextGroup && (
        <div className="mt-3 text-[11px] text-op-muted">
          Se asignará a <strong>{nextGroup.name}</strong>. El group_admin
          de ese grupo podrá ver este restaurante desde /group.
        </div>
      )}
      {dirty && !willClearLegalEntity && !nextGroup && initialGroup && (
        <div className="mt-3 text-[11px] text-op-muted">
          Quedará sin grupo. El restaurante seguirá funcionando como
          comercio independiente.
        </div>
      )}
      {err && (
        <div className="mt-3 text-xs text-danger">{err}</div>
      )}
    </div>
  );
}
