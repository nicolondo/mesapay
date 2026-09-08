"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type {
  TipPolicy,
  ShiftPolicy,
  MeseroShiftWithoutLocal,
} from "@/lib/staffPolicies";

export function StaffPoliciesClient({
  initialTipPolicy,
  initialShiftPolicy,
  initialWalkoutDangerMinutes,
  initialBusinessDayCutoffHour,
  initialMeseroShiftWithoutLocal,
  initialCompEnabled,
  initialCompLabel,
  initialAdminOnlyCharge,
}: {
  initialTipPolicy: TipPolicy;
  initialShiftPolicy: ShiftPolicy;
  initialWalkoutDangerMinutes: number;
  initialBusinessDayCutoffHour: number;
  initialMeseroShiftWithoutLocal: MeseroShiftWithoutLocal;
  initialCompEnabled: boolean;
  initialCompLabel: string;
  initialAdminOnlyCharge: boolean;
}) {
  const t = useTranslations("opSettings");
  const [tipPolicy, setTipPolicy] = useState<TipPolicy>(initialTipPolicy);
  const [shiftPolicy, setShiftPolicy] = useState<ShiftPolicy>(initialShiftPolicy);
  const [walkoutDanger, setWalkoutDanger] = useState<number>(
    initialWalkoutDangerMinutes,
  );
  const [cutoffHour, setCutoffHour] = useState<number>(
    initialBusinessDayCutoffHour,
  );
  const [meseroWithoutLocal, setMeseroWithoutLocal] =
    useState<MeseroShiftWithoutLocal>(initialMeseroShiftWithoutLocal);
  const [compEnabled, setCompEnabled] = useState<boolean>(initialCompEnabled);
  const [compLabel, setCompLabel] = useState<string>(initialCompLabel);
  // Control de caja: solo el administrador inicia el cobro.
  const [adminOnlyCharge, setAdminOnlyCharge] = useState<boolean>(
    initialAdminOnlyCharge,
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  const dirty =
    tipPolicy !== initialTipPolicy ||
    shiftPolicy !== initialShiftPolicy ||
    walkoutDanger !== initialWalkoutDangerMinutes ||
    cutoffHour !== initialBusinessDayCutoffHour ||
    meseroWithoutLocal !== initialMeseroShiftWithoutLocal ||
    compEnabled !== initialCompEnabled ||
    adminOnlyCharge !== initialAdminOnlyCharge ||
    compLabel.trim() !== initialCompLabel.trim();

  async function save() {
    if (
      !Number.isFinite(walkoutDanger) ||
      walkoutDanger < 1 ||
      walkoutDanger > 180
    ) {
      setMsg({
        kind: "error",
        text: t("policiesWalkoutRangeError"),
      });
      return;
    }
    setBusy(true);
    setMsg(null);
    const r = await fetch("/api/operator/settings/staff-policies", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tipPolicy,
        shiftPolicy,
        walkoutDangerMinutes: walkoutDanger,
        businessDayCutoffHour: cutoffHour,
        meseroShiftWithoutLocal: meseroWithoutLocal,
        compEnabled,
        compLabel: compLabel.trim(),
        adminOnlyCharge,
      }),
    });
    setBusy(false);
    if (!r.ok) {
      // Errores esperables del control de caja — cada uno tiene su
      // explicación, porque "no se pudo guardar" a secas no le dice al
      // dueño qué hacer.
      const j = await r.json().catch(() => ({}));
      if (j?.error === "open_mesero_shifts") {
        setMsg({
          kind: "error",
          text: t("policiesAdminChargeOpenShifts", {
            count: Number(j.count ?? 0),
          }),
        });
        // Devolvemos el switch a su estado real: no se guardó.
        setAdminOnlyCharge(initialAdminOnlyCharge);
        return;
      }
      if (j?.error === "shift_policy_locked_by_admin_charge") {
        setMsg({ kind: "error", text: t("policiesAdminChargeShiftLocked") });
        setShiftPolicy("global");
        return;
      }
      setMsg({ kind: "error", text: t("policiesSaveFailed") });
      return;
    }
    setMsg({ kind: "ok", text: t("policiesSaved") });
  }

  return (
    <div className="space-y-5">
      {/* Propinas */}
      <section className="rounded-2xl border border-op-border bg-op-surface p-5">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
          {t("policiesTipsKicker")}
        </div>
        <h2 className="font-display text-lg mb-3">
          {t("policiesTipsQuestion")}
        </h2>
        <RadioCard
          name="tipPolicy"
          value="shared"
          active={tipPolicy === "shared"}
          onChange={() => setTipPolicy("shared")}
          title={t("policiesTipsSharedTitle")}
          subtitle={t("policiesTipsSharedSubtitle")}
        />
        <RadioCard
          name="tipPolicy"
          value="by_waiter"
          active={tipPolicy === "by_waiter"}
          onChange={() => setTipPolicy("by_waiter")}
          title={t("policiesTipsByWaiterTitle")}
          subtitle={t("policiesTipsByWaiterSubtitle")}
        />
      </section>

      {/* Control de caja — quién puede iniciar el cobro de una mesa */}
      <section className="rounded-2xl border border-op-border bg-op-surface p-5">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
          {t("policiesAdminChargeKicker")}
        </div>
        <h2 className="font-display text-lg mb-1">
          {t("policiesAdminChargeQuestion")}
        </h2>
        <p className="text-xs text-op-muted mb-3">
          {t("policiesAdminChargeIntro")}
        </p>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={adminOnlyCharge}
            onChange={(e) => {
              const on = e.target.checked;
              setAdminOnlyCharge(on);
              // El turno por mesero es incompatible: lo dejamos en
              // "único del local" ya en pantalla para que el dueño vea la
              // implicación antes de guardar (el servidor lo fuerza igual).
              if (on) setShiftPolicy("global");
            }}
            className="h-4 w-4 accent-ink"
          />
          <span className="text-sm">{t("policiesAdminChargeToggle")}</span>
        </label>
        {adminOnlyCharge && (
          <p className="text-[11px] text-op-muted mt-3 leading-relaxed">
            {t("policiesAdminChargeEffects")}
          </p>
        )}
        <p className="text-[10px] text-op-muted mt-3">
          {t("policiesAdminChargeFootnote")}
        </p>
      </section>

      {/* Turnos */}
      <section className="rounded-2xl border border-op-border bg-op-surface p-5">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
          {t("policiesShiftsKicker")}
        </div>
        <h2 className="font-display text-lg mb-3">
          {t("policiesShiftsQuestion")}
        </h2>
        <RadioCard
          name="shiftPolicy"
          value="global"
          active={shiftPolicy === "global"}
          onChange={() => setShiftPolicy("global")}
          title={t("policiesShiftsGlobalTitle")}
          subtitle={t("policiesShiftsGlobalSubtitle")}
        />
        <RadioCard
          name="shiftPolicy"
          value="by_waiter"
          active={shiftPolicy === "by_waiter"}
          onChange={() => setShiftPolicy("by_waiter")}
          title={t("policiesShiftsByWaiterTitle")}
          subtitle={t("policiesShiftsByWaiterSubtitle")}
          disabled={adminOnlyCharge}
        />
        {adminOnlyCharge && (
          <p className="text-[11px] text-op-muted mt-3">
            {t("policiesShiftsLockedByAdminCharge")}
          </p>
        )}
      </section>

      {/* Mesero sin turno del local — solo relevante en turno por mesero */}
      {shiftPolicy === "by_waiter" && (
        <section className="rounded-2xl border border-op-border bg-op-surface p-5">
          <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
            {t("policiesNoLocalKicker")}
          </div>
          <h2 className="font-display text-lg mb-1">
            {t("policiesNoLocalQuestion")}
          </h2>
          <p className="text-xs text-op-muted mb-3">
            {t("policiesNoLocalIntro")}
          </p>
          <RadioCard
            name="meseroShiftWithoutLocal"
            value="block"
            active={meseroWithoutLocal === "block"}
            onChange={() => setMeseroWithoutLocal("block")}
            title={t("policiesNoLocalBlockTitle")}
            subtitle={t("policiesNoLocalBlockSubtitle")}
          />
          <RadioCard
            name="meseroShiftWithoutLocal"
            value="auto_open"
            active={meseroWithoutLocal === "auto_open"}
            onChange={() => setMeseroWithoutLocal("auto_open")}
            title={t("policiesNoLocalAutoTitle")}
            subtitle={t("policiesNoLocalAutoSubtitle")}
          />
          <p className="text-[10px] text-op-muted mt-3">
            {t("policiesNoLocalFootnote")}
          </p>
        </section>
      )}

      {/* Día contable — hora de corte */}
      <section className="rounded-2xl border border-op-border bg-op-surface p-5">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
          {t("policiesBusinessDayKicker")}
        </div>
        <h2 className="font-display text-lg mb-1">
          {t("policiesBusinessDayQuestion")}
        </h2>
        <p className="text-xs text-op-muted mb-3">
          {t("policiesBusinessDayIntro")}
        </p>
        <label className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
            {t("policiesBusinessDayLabel")}
          </span>
          <select
            value={cutoffHour}
            onChange={(e) => setCutoffHour(Number(e.target.value))}
            className="h-9 px-2 rounded-lg border border-op-border bg-op-bg font-mono text-sm tabular focus:outline-none focus:border-terracotta"
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {t("policiesBusinessDayHourOption", {
                  hour: String(h).padStart(2, "0"),
                })}
              </option>
            ))}
          </select>
        </label>
        <p className="text-[10px] text-op-muted mt-3">
          {t("policiesBusinessDayFootnote", {
            hour: String(cutoffHour).padStart(2, "0"),
          })}
        </p>
      </section>

      {/* Walkout-risk */}
      <section className="rounded-2xl border border-op-border bg-op-surface p-5">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
          {t("policiesWalkoutKicker")}
        </div>
        <h2 className="font-display text-lg mb-1">
          {t("policiesWalkoutQuestion")}
        </h2>
        <p className="text-xs text-op-muted mb-3">
          {t("policiesWalkoutIntro")}
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-2">
            <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
              {t("policiesWalkoutLabel")}
            </span>
            <input
              type="number"
              min={1}
              max={180}
              step={1}
              value={walkoutDanger}
              onChange={(e) => {
                const v = Number(e.target.value);
                setWalkoutDanger(Number.isFinite(v) ? v : 20);
              }}
              className="h-9 w-20 px-2 rounded-lg border border-op-border bg-op-bg font-mono text-sm tabular text-center focus:outline-none focus:border-terracotta"
            />
            <span className="text-sm text-op-muted">
              {t("policiesWalkoutMin")}
            </span>
          </label>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2 text-[11px]">
          <RiskPreview
            label={t("policiesWalkoutPreviewAttentive")}
            mins={Math.round(walkoutDanger * 0.25)}
            dotClass="bg-[#C98A2E]/70"
            text="text-op-text"
          />
          <RiskPreview
            label={t("policiesWalkoutPreviewAttention")}
            mins={Math.round(walkoutDanger * 0.5)}
            dotClass="bg-[#C98A2E]"
            text="text-[#7F5A1F]"
          />
          <RiskPreview
            label={t("policiesWalkoutPreviewHigh")}
            mins={walkoutDanger}
            dotClass="bg-[#C9302C] animate-pulse"
            text="text-[#C9302C]"
            extraBold
          />
        </div>
        <p className="text-[10px] text-op-muted mt-3">
          {t("policiesWalkoutFootnote")}
        </p>
      </section>

      {/* Gastos de representación (cortesía $0) */}
      <section className="rounded-2xl border border-op-border bg-op-surface p-5">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
          {t("policiesCompKicker")}
        </div>
        <h2 className="font-display text-lg mb-1">
          {t("policiesCompQuestion")}
        </h2>
        <p className="text-xs text-op-muted mb-3">{t("policiesCompIntro")}</p>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={compEnabled}
            onChange={(e) => setCompEnabled(e.target.checked)}
            className="h-4 w-4 accent-ink"
          />
          <span className="text-sm">{t("policiesCompToggle")}</span>
        </label>
        {compEnabled && (
          <label className="mt-4 block">
            <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted block mb-1">
              {t("policiesCompLabelField")}
            </span>
            <input
              type="text"
              maxLength={40}
              value={compLabel}
              onChange={(e) => setCompLabel(e.target.value)}
              placeholder={t("policiesCompLabelPlaceholder")}
              className="h-9 w-full max-w-sm px-2 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-terracotta"
            />
          </label>
        )}
      </section>

      <div className="flex items-center justify-end gap-3 pt-1">
        {msg && (
          <span
            className={
              "text-xs " + (msg.kind === "ok" ? "text-ok" : "text-danger")
            }
          >
            {msg.text}
          </span>
        )}
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="mp-btn mp-btn--primary mp-btn--sm"
        >
          {busy ? t("policiesSaving") : t("policiesSave")}
        </button>
      </div>
    </div>
  );
}

function RiskPreview({
  label,
  mins,
  dotClass,
  text,
  extraBold,
}: {
  label: string;
  mins: number;
  dotClass: string;
  text: string;
  extraBold?: boolean;
}) {
  const t = useTranslations("opSettings");
  return (
    <div className="rounded-xl border border-op-border bg-op-bg px-2 py-2 text-center">
      <div className="flex items-center justify-center gap-1.5 mb-0.5">
        <span className={"inline-block w-2 h-2 rounded-full " + dotClass} />
        <span className="font-mono text-[9px] tracking-wider uppercase text-op-muted">
          {label}
        </span>
      </div>
      <div
        className={
          "font-mono tabular " + text + " " + (extraBold ? "font-bold" : "")
        }
      >
        {t("policiesWalkoutPreviewMins", { mins })}
      </div>
    </div>
  );
}

function RadioCard({
  name,
  value,
  active,
  onChange,
  title,
  subtitle,
  disabled,
}: {
  name: string;
  value: string;
  active: boolean;
  onChange: () => void;
  title: string;
  subtitle: string;
  // Opción bloqueada por otra política (hoy: turno por mesero cuando el
  // control de caja está activo). Se sigue mostrando —el dueño tiene que
  // ver que existe— pero no se puede elegir.
  disabled?: boolean;
}) {
  return (
    <label
      className={
        "flex gap-3 items-start rounded-xl border p-4 mt-2 transition-colors " +
        (disabled ? "opacity-50 cursor-not-allowed " : "cursor-pointer ") +
        (active
          ? "border-ink bg-ink/5"
          : "border-op-border hover:border-op-text/30")
      }
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={active}
        onChange={onChange}
        disabled={disabled}
        className="mt-1 accent-ink shrink-0"
      />
      <div className="min-w-0">
        <div className="font-medium text-sm">{title}</div>
        <div className="text-xs text-op-muted mt-0.5">{subtitle}</div>
      </div>
    </label>
  );
}
