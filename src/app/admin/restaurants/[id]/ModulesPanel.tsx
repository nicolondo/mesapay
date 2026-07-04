"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { MODULE_CATALOG, type ModuleSlug } from "@/lib/modules";

/**
 * Panel de módulos ERP del comercio (admin de plataforma). Activa /
 * desactiva los módulos administrativos (inventario, compras, recetas,
 * facturación electrónica, contabilidad…) según lo contratado. Los módulos
 * cuya fase del roadmap aún no salió aparecen deshabilitados con badge
 * "próximamente" — así el catálogo completo es visible desde el día 1.
 */
export function ModulesPanel({
  restaurantId,
  initialEnabled,
}: {
  restaurantId: string;
  initialEnabled: ModuleSlug[];
}) {
  const t = useTranslations("opAdmin");
  const router = useRouter();
  const [enabled, setEnabled] = useState<Set<ModuleSlug>>(
    new Set(initialEnabled),
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  const dirty =
    enabled.size !== initialEnabled.length ||
    initialEnabled.some((s) => !enabled.has(s));

  function toggle(slug: ModuleSlug) {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
    setMsg(null);
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/admin/restaurants/${restaurantId}/modules`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modules: Array.from(enabled) }),
    });
    setBusy(false);
    if (!res.ok) {
      setMsg({ kind: "error", text: t("saveFailedShort") });
      return;
    }
    setMsg({ kind: "ok", text: t("savedOk") });
    router.refresh();
  }

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-5 mb-4">
      <div className="flex items-start justify-between gap-3 mb-1">
        <div>
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
            {t("modulesTitle")}
          </div>
          <div className="text-sm mt-1">{t("modulesIntro")}</div>
        </div>
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted shrink-0">
          {t("modulesCount", {
            enabled: enabled.size,
            total: MODULE_CATALOG.length,
          })}
        </div>
      </div>

      <ul className="mt-4 divide-y divide-op-border">
        {MODULE_CATALOG.map((m) => {
          const on = enabled.has(m.slug);
          const locked = !m.shipped;
          return (
            <li
              key={m.slug}
              className="py-3 flex items-start justify-between gap-4"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium flex items-center gap-2">
                  {t(`module_${m.slug}_label`)}
                  {locked && (
                    <span className="font-mono text-[9px] tracking-wider uppercase px-1.5 py-0.5 rounded bg-op-bg border border-op-border text-op-muted">
                      {t("moduleComingSoon")}
                    </span>
                  )}
                </div>
                <div className="text-[12px] text-op-muted mt-0.5">
                  {t(`module_${m.slug}_desc`)}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                disabled={locked}
                onClick={() => toggle(m.slug)}
                className={
                  "shrink-0 relative inline-flex items-center h-7 w-12 rounded-full transition-colors " +
                  (on ? "bg-ok" : "bg-op-border") +
                  (locked ? " opacity-40 cursor-not-allowed" : "")
                }
              >
                <span
                  className={
                    "absolute top-0.5 left-0.5 inline-block w-6 h-6 rounded-full bg-bone shadow transition-transform " +
                    (on ? "translate-x-5" : "translate-x-0")
                  }
                />
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="h-10 px-4 rounded-xl bg-ink text-bone text-sm font-medium disabled:opacity-40"
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
    </div>
  );
}
