"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

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
  const t = useTranslations("opIdentity");
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
      setMsg({ kind: "error", text: j.message ?? t("groupSaveError") });
      return;
    }
    setMsg({ kind: "ok", text: t("saved") });
    router.refresh();
  }

  return (
    <section className="rounded-2xl border border-terracotta/30 bg-terracotta/5 p-5 mb-5">
      <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-terracotta mb-2">
        {t("groupTitle")}
      </div>
      <p className="text-xs text-op-muted mb-3">{t("groupIntro")}</p>
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta"
        >
          <option value="">{t("groupUseLocal")}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {t("groupOptionLabel", { name: o.name, taxId: o.taxId })}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
        >
          {busy ? t("saving") : t("save")}
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
          {t("groupEmptyPre")}{" "}
          <a
            href="/group/razones-sociales"
            className="text-terracotta underline"
          >
            {"/group/razones-sociales"}
          </a>
          .
        </div>
      )}
    </section>
  );
}
