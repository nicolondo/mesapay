"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Selector chico arriba del form de identidad. Cuando el restaurante
 * pertenece a un grupo con razones sociales configuradas, el operador
 * puede elegir entre:
 *   - "Usar razón social local" (legalEntityId = null) → los campos
 *      de abajo de la página se editan como siempre
 *   - Una de las razones sociales del grupo → los datos se heredan
 *      del LegalEntity, el form de abajo queda como referencia
 *      (oculto o read-only)
 *
 * Si el restaurante no está en un grupo, este componente no se
 * renderea (la página server lo decide).
 */
type Option = {
  id: string;
  name: string;
  taxId: string;
};

export function LegalEntityPicker({
  options,
  initialLegalEntityId,
}: {
  options: Option[];
  initialLegalEntityId: string | null;
}) {
  const router = useRouter();
  const [value, setValue] = useState<string>(initialLegalEntityId ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );
  const dirty = (value || null) !== (initialLegalEntityId || null);

  async function save() {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/operator/settings/legal-entity", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ legalEntityId: value || null }),
    });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMsg({ kind: "error", text: j.message ?? "No pudimos guardar." });
      return;
    }
    setMsg({ kind: "ok", text: "Guardado." });
    router.refresh();
  }

  return (
    <section className="rounded-2xl border border-terracotta/30 bg-terracotta/5 p-5 mb-5">
      <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-terracotta mb-2">
        Razón social del grupo
      </div>
      <p className="text-xs text-op-muted mb-3">
        Este restaurante está dentro de un grupo. Podés usar una razón
        social compartida (misma numeración DIAN para los locales que
        la comparten) o dejarlo en "usar la del restaurante" y editar
        los campos locales abajo.
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta"
        >
          <option value="">Usar la del restaurante (local)</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name} — NIT {o.taxId}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
        >
          {busy ? "Guardando…" : "Guardar"}
        </button>
        {msg && (
          <span
            className={
              "text-xs " + (msg.kind === "ok" ? "text-ok" : "text-danger")
            }
          >
            {msg.text}
          </span>
        )}
      </div>
      {options.length === 0 && (
        <div className="text-[11px] text-op-muted mt-2">
          Aún no hay razones sociales en el grupo. Creá una desde{" "}
          <a
            href="/group/razones-sociales"
            className="text-terracotta underline"
          >
            /group/razones-sociales
          </a>
          .
        </div>
      )}
    </section>
  );
}
