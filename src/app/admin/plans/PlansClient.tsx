"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { fmtCOP } from "@/lib/format";
import type { PlanCatalogEntry } from "@/lib/planCatalog";

type Plan = "trial" | "basic" | "pro";

export function PlansClient({
  initialPlans,
  countByTier,
}: {
  initialPlans: PlanCatalogEntry[];
  countByTier: Record<string, number>;
}) {
  return (
    <div className="space-y-4">
      {initialPlans.map((p) => (
        <PlanCard
          key={p.tier}
          plan={p}
          restaurantCount={countByTier[p.tier] ?? 0}
        />
      ))}
    </div>
  );
}

function PlanCard({
  plan,
  restaurantCount,
}: {
  plan: PlanCatalogEntry;
  restaurantCount: number;
}) {
  const t = useTranslations("opAdminPlans");
  const router = useRouter();
  const [name, setName] = useState(plan.name);
  const [description, setDescription] = useState(plan.description ?? "");
  // Precio en pesos enteros (sin centavos) — el operador piensa en
  // COP, no en cents. Se multiplican x100 al guardar.
  const [priceCop, setPriceCop] = useState(
    String(Math.round(plan.defaultPriceCents / 100)),
  );
  const [features, setFeatures] = useState<string[]>(
    plan.features.length > 0 ? plan.features : [""],
  );
  const [visible, setVisible] = useState(plan.visible);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );
  const [, startTx] = useTransition();

  // Snapshot del estado guardado para detectar dirty. Sin esto
  // el botón "Guardar" estaría siempre habilitado.
  const dirty =
    name !== plan.name ||
    (description || null) !== (plan.description || null) ||
    Math.round(Number(priceCop) * 100) !== plan.defaultPriceCents ||
    visible !== plan.visible ||
    !sameFeatures(plan.features, features);

  function setFeature(idx: number, value: string) {
    setFeatures((arr) => arr.map((f, i) => (i === idx ? value : f)));
  }
  function addFeature() {
    setFeatures((arr) => [...arr, ""]);
  }
  function removeFeature(idx: number) {
    setFeatures((arr) => arr.filter((_, i) => i !== idx));
  }

  async function save() {
    const cents = Math.round(Number(priceCop) * 100);
    if (!Number.isFinite(cents) || cents < 0) {
      setMsg({ kind: "error", text: t("priceInvalid") });
      return;
    }
    setBusy(true);
    setMsg(null);
    const cleanFeatures = features
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
    const res = await fetch("/api/admin/plans", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tier: plan.tier,
        name: name.trim() || plan.tier,
        description: description.trim(),
        defaultPriceCents: cents,
        features: cleanFeatures,
        visible,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setMsg({
        kind: "error",
        text: j.message ?? t("saveFailed"),
      });
      return;
    }
    setMsg({ kind: "ok", text: t("saved") });
    // Refresh para que el countByTier se mantenga sincronizado si
    // se cambia visible (el server-side recalcula).
    startTx(() => router.refresh());
  }

  return (
    <section className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
      <div className="flex items-start justify-between p-5 gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
            {t("tierLabel", { tier: plan.tier })}
          </div>
          <div className="font-display text-2xl mt-0.5 tracking-[-0.01em]">
            {name || plan.tier}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-[10px] tracking-wider uppercase px-2 py-1 rounded border bg-op-bg border-op-border text-op-muted">
            {t("merchantCount", { count: restaurantCount })}
          </span>
          <VisibleToggle value={visible} onChange={setVisible} />
        </div>
      </div>

      <div className="p-5 pt-0 space-y-4">
        <Field label={t("fieldName")}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder={plan.tier}
            className={inputCls}
          />
        </Field>

        <Field
          label={t("fieldDescription")}
          hint={t("descriptionHint")}
        >
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={240}
            placeholder={t("descriptionPlaceholder")}
            className={inputCls}
          />
        </Field>

        <Field
          label={t("fieldPrice")}
          hint={t("priceHint")}
        >
          <div className="flex items-center gap-2">
            <span className="text-op-muted text-sm">{"$"}</span>
            <input
              type="number"
              value={priceCop}
              onChange={(e) => setPriceCop(e.target.value)}
              min={0}
              step={1000}
              className="h-10 w-40 px-3 rounded-lg border border-op-border bg-op-bg font-mono text-sm tabular focus:outline-none focus:border-terracotta"
            />
            <span className="text-op-muted text-xs">{t("perMonthSuffix")}</span>
            <span className="text-op-muted text-xs ml-auto">
              {t("perMonthApprox", {
                price: fmtCOP(Math.round(Number(priceCop) * 100) || 0),
              })}
            </span>
          </div>
        </Field>

        <Field
          label={t("fieldFeatures")}
          hint={t("featuresHint")}
        >
          <ul className="space-y-2">
            {features.map((f, idx) => (
              <li key={idx} className="flex items-center gap-2">
                <input
                  type="text"
                  value={f}
                  onChange={(e) => setFeature(idx, e.target.value)}
                  maxLength={120}
                  placeholder={t("featurePlaceholder")}
                  className={inputCls + " flex-1"}
                />
                <button
                  type="button"
                  onClick={() => removeFeature(idx)}
                  aria-label={t("removeFeature")}
                  className="h-9 w-9 rounded-full border border-op-border text-op-muted hover:text-danger hover:border-danger/40 text-sm shrink-0"
                >
                  {"×"}
                </button>
              </li>
            ))}
            {features.length < 12 && (
              <li>
                <button
                  type="button"
                  onClick={addFeature}
                  className="font-mono text-[10px] tracking-wider uppercase text-terracotta hover:underline"
                >
                  {t("addFeature")}
                </button>
              </li>
            )}
          </ul>
        </Field>

        <div className="flex items-center justify-end gap-3 pt-2">
          {msg && (
            <span
              className={
                "text-xs " +
                (msg.kind === "ok" ? "text-ok" : "text-danger")
              }
            >
              {msg.text}
            </span>
          )}
          <button
            onClick={save}
            disabled={busy || !dirty}
            className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? t("saving") : t("save")}
          </button>
        </div>
      </div>
    </section>
  );
}

function VisibleToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  const t = useTranslations("opAdminPlans");
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={
        "h-7 px-3 rounded-full text-[11px] font-medium border transition-colors " +
        (value
          ? "bg-ok/10 text-[#1E5339] border-ok/30"
          : "bg-op-bg text-op-muted border-op-border")
      }
      title={value ? t("visibleTitle") : t("hiddenTitle")}
    >
      {value ? t("visible") : t("hidden")}
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
        {label}
      </div>
      {children}
      {hint && <div className="text-[10px] text-op-muted mt-1">{hint}</div>}
    </label>
  );
}

const inputCls =
  "w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta";

function sameFeatures(a: string[], b: string[]): boolean {
  const aClean = a.map((s) => s.trim()).filter(Boolean);
  const bClean = b.map((s) => s.trim()).filter(Boolean);
  if (aClean.length !== bClean.length) return false;
  for (let i = 0; i < aClean.length; i++) {
    if (aClean[i] !== bClean[i]) return false;
  }
  return true;
}

// Suprimir warning sobre Plan no usado — útil para futuras
// extensiones (ej: pasar el tier a un sub-componente).
export type { Plan };
