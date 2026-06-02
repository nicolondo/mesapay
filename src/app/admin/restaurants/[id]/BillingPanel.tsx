"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { fmtCOP } from "@/lib/format";

type Plan = "trial" | "basic" | "pro";

type PlanOption = {
  value: Plan;
  label: string;
  suggestedPriceCents: number;
};

export function PlanEditor({
  restaurantId,
  plan,
  monthlyPriceCents,
  planOptions,
}: {
  restaurantId: string;
  plan: Plan;
  monthlyPriceCents: number;
  // Opcional para back-compat. Cuando se pasa (caso normal en
  // /admin/restaurants/[id]), refleja el catálogo /admin/plans.
  planOptions?: PlanOption[];
}) {
  const t = useTranslations("opAdminBilling");
  // Defaults usados como fallback si el caller no pasa planOptions —
  // preserva el comportamiento histórico antes del catálogo editable.
  const DEFAULT_PLAN_OPTIONS: PlanOption[] = [
    { value: "trial", label: t("planDefaultTrial"), suggestedPriceCents: 0 },
    { value: "basic", label: t("planDefaultBasic"), suggestedPriceCents: 20_000_000 },
    { value: "pro", label: t("planDefaultPro"), suggestedPriceCents: 40_000_000 },
  ];
  const PLAN_OPTIONS = planOptions ?? DEFAULT_PLAN_OPTIONS;
  const router = useRouter();
  const [selected, setSelected] = useState<Plan>(plan);
  const [priceCop, setPriceCop] = useState(String(Math.round(monthlyPriceCents / 100)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, startTx] = useTransition();

  const dirty =
    selected !== plan ||
    Math.round(Number(priceCop) * 100) !== monthlyPriceCents;

  async function save() {
    const cents = Math.round(Number(priceCop) * 100);
    if (!Number.isFinite(cents) || cents < 0) {
      setErr(t("priceInvalid"));
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/admin/membership/${restaurantId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "set_plan",
        plan: selected,
        monthlyPriceCents: cents,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setErr(t("saveFailed"));
      return;
    }
    startTx(() => router.refresh());
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-2">
          {t("plan")}
        </div>
        <div className="inline-flex p-1 rounded-full bg-op-bg border border-op-border">
          {PLAN_OPTIONS.map((p) => (
            <button
              key={p.value}
              onClick={() => {
                setSelected(p.value);
                if (p.value !== plan) {
                  setPriceCop(String(Math.round(p.suggestedPriceCents / 100)));
                } else {
                  setPriceCop(String(Math.round(monthlyPriceCents / 100)));
                }
              }}
              className={
                "h-8 px-4 rounded-full text-xs font-medium transition-colors " +
                (selected === p.value
                  ? "bg-ink text-bone"
                  : "text-op-muted hover:text-op-text")
              }
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-2">
          {t("monthlyFee")}
        </div>
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
        </div>
      </div>
      {err && <div className="text-danger text-xs">{err}</div>}
      <div className="flex">
        <button
          onClick={save}
          disabled={busy || !dirty}
          className="h-10 px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? t("saving") : t("savePlan")}
        </button>
      </div>
    </div>
  );
}

export function RecordPaymentForm({
  restaurantId,
  suggestedAmountCents,
}: {
  restaurantId: string;
  suggestedAmountCents: number;
}) {
  const t = useTranslations("opAdminBilling");
  const router = useRouter();
  const [amountCop, setAmountCop] = useState(
    String(Math.round(suggestedAmountCents / 100)),
  );
  const [method, setMethod] = useState<"manual_cash" | "manual_transfer" | "wompi">(
    "manual_transfer",
  );
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, startTx] = useTransition();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const cents = Math.round(Number(amountCop) * 100);
    if (!Number.isFinite(cents) || cents < 0) {
      setErr(t("amountInvalid"));
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/admin/membership/${restaurantId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "record_payment",
        amountCents: cents,
        method,
        note: note.trim() || undefined,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setErr(t("recordFailed"));
      return;
    }
    setNote("");
    startTx(() => router.refresh());
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex gap-2 flex-wrap items-end">
        <label className="flex flex-col">
          <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
            {t("amountCop")}
          </span>
          <input
            type="number"
            value={amountCop}
            onChange={(e) => setAmountCop(e.target.value)}
            min={0}
            step={1000}
            className="h-9 w-36 px-2 rounded-lg border border-op-border bg-op-bg font-mono text-sm tabular"
          />
        </label>
        <label className="flex flex-col">
          <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
            {t("method")}
          </span>
          <select
            value={method}
            onChange={(e) =>
              setMethod(e.target.value as typeof method)
            }
            className="h-9 px-2 rounded-lg border border-op-border bg-op-bg text-sm"
          >
            <option value="manual_transfer">{t("methodTransfer")}</option>
            <option value="manual_cash">{t("methodCash")}</option>
            <option value="wompi">{t("methodWompi")}</option>
          </select>
        </label>
        <label className="flex flex-col flex-1 min-w-[180px]">
          <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
            {t("noteOptional")}
          </span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={240}
            placeholder={t("notePlaceholder")}
            className="h-9 px-2 rounded-lg border border-op-border bg-op-bg text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="h-9 px-4 rounded-full bg-terracotta text-bone text-sm font-medium disabled:opacity-60"
        >
          {busy ? t("recording") : t("markPayment")}
        </button>
      </div>
      {err && <div className="text-danger text-xs">{err}</div>}
      <div className="text-[11px] text-op-muted">
        {t("recordPaymentHint")}
      </div>
    </form>
  );
}

export function SuspendButton({
  restaurantId,
  suspended,
}: {
  restaurantId: string;
  suspended: boolean;
}) {
  const t = useTranslations("opAdminBilling");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, startTx] = useTransition();

  async function toggle() {
    const next = !suspended;
    const label = next
      ? t("suspendConfirm")
      : t("reactivateConfirm");
    if (!window.confirm(label)) return;
    setBusy(true);
    const res = await fetch(`/api/admin/membership/${restaurantId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "set_suspended", suspended: next }),
    });
    setBusy(false);
    if (!res.ok) {
      alert(t("changeFailed"));
      return;
    }
    startTx(() => router.refresh());
  }

  return (
    <button
      onClick={toggle}
      disabled={busy}
      className={
        "h-8 px-3 rounded-full text-xs font-medium border " +
        (suspended
          ? "bg-ok/10 text-[#1E5339] border-ok/30"
          : "bg-danger/10 text-danger border-danger/30")
      }
    >
      {suspended ? t("reactivate") : t("suspend")}
    </button>
  );
}

export function ServiceModePicker({
  restaurantId,
  serviceMode,
}: {
  restaurantId: string;
  serviceMode: "table" | "counter";
}) {
  const t = useTranslations("opAdminBilling");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, startTx] = useTransition();

  async function set(next: "table" | "counter") {
    if (next === serviceMode || busy) return;
    const confirmMsg =
      next === "counter"
        ? t("serviceModeCounterConfirm")
        : t("serviceModeTableConfirm");
    if (!window.confirm(confirmMsg)) return;
    setBusy(true);
    const res = await fetch(`/api/admin/membership/${restaurantId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "set_service_mode", serviceMode: next }),
    });
    setBusy(false);
    if (!res.ok) {
      alert(t("serviceModeChangeFailed"));
      return;
    }
    startTx(() => router.refresh());
  }

  return (
    <div className="flex gap-2 flex-wrap">
      {(
        [
          { value: "table", label: t("serviceModeTable") },
          { value: "counter", label: t("serviceModeCounter") },
        ] as const
      ).map((o) => (
        <button
          key={o.value}
          onClick={() => set(o.value)}
          disabled={busy}
          className={
            "h-8 px-3 rounded-full text-xs border disabled:opacity-60 " +
            (serviceMode === o.value
              ? "bg-ink text-bone border-ink"
              : "bg-op-bg border-op-border")
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function PickupToggle({
  restaurantId,
  pickupEnabled,
}: {
  restaurantId: string;
  pickupEnabled: boolean;
}) {
  const t = useTranslations("opAdminBilling");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, startTx] = useTransition();

  async function toggle() {
    const next = !pickupEnabled;
    if (next && !window.confirm(t("pickupEnableConfirm"))) return;
    setBusy(true);
    const res = await fetch(`/api/admin/membership/${restaurantId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "set_pickup_enabled",
        pickupEnabled: next,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      alert(t("changeFailed"));
      return;
    }
    startTx(() => router.refresh());
  }

  return (
    <button
      onClick={toggle}
      disabled={busy}
      className={
        "h-8 px-3 rounded-full text-xs border disabled:opacity-60 " +
        (pickupEnabled
          ? "bg-ink text-bone border-ink"
          : "bg-op-bg border-op-border")
      }
    >
      {pickupEnabled ? t("pickupEnabled") : t("pickupDisabled")}
    </button>
  );
}

type DayCode = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
type Window = { from: string; to: string };
type PickupHoursInput = Record<DayCode, Window[]>;

const DAY_ORDER: { key: DayCode; tKey: string }[] = [
  { key: "mon", tKey: "dayMon" },
  { key: "tue", tKey: "dayTue" },
  { key: "wed", tKey: "dayWed" },
  { key: "thu", tKey: "dayThu" },
  { key: "fri", tKey: "dayFri" },
  { key: "sat", tKey: "daySat" },
  { key: "sun", tKey: "daySun" },
];

const EMPTY_HOURS: PickupHoursInput = {
  mon: [],
  tue: [],
  wed: [],
  thu: [],
  fri: [],
  sat: [],
  sun: [],
};

const DEFAULT_HOURS: PickupHoursInput = {
  mon: [{ from: "11:00", to: "22:00" }],
  tue: [{ from: "11:00", to: "22:00" }],
  wed: [{ from: "11:00", to: "22:00" }],
  thu: [{ from: "11:00", to: "22:00" }],
  fri: [{ from: "11:00", to: "22:00" }],
  sat: [{ from: "11:00", to: "22:00" }],
  sun: [{ from: "11:00", to: "22:00" }],
};

function normalizeHours(
  raw: Record<string, unknown> | null | undefined,
): PickupHoursInput | null {
  if (!raw) return null;
  const out: PickupHoursInput = { ...EMPTY_HOURS };
  let any = false;
  for (const day of DAY_ORDER) {
    const arr = (raw as Record<string, unknown>)[day.key];
    if (!Array.isArray(arr)) continue;
    const windows: Window[] = [];
    for (const w of arr) {
      if (!w || typeof w !== "object") continue;
      const { from, to } = w as Record<string, unknown>;
      if (typeof from !== "string" || typeof to !== "string") continue;
      windows.push({ from, to });
    }
    if (windows.length) {
      out[day.key] = windows;
      any = true;
    }
  }
  return any ? out : null;
}

export function PickupSchedulePanel({
  restaurantId,
  pickupHours,
  pickupMaxEtaMinutes,
}: {
  restaurantId: string;
  pickupHours: Record<string, unknown> | null;
  pickupMaxEtaMinutes: number | null;
}) {
  const t = useTranslations("opAdminBilling");
  const router = useRouter();
  const normalized = normalizeHours(pickupHours);
  const [mode, setMode] = useState<"always" | "custom">(
    normalized ? "custom" : "always",
  );
  const [draft, setDraft] = useState<PickupHoursInput>(
    normalized ?? DEFAULT_HOURS,
  );
  const [capOn, setCapOn] = useState<boolean>(
    pickupMaxEtaMinutes != null && pickupMaxEtaMinutes > 0,
  );
  const [capInput, setCapInput] = useState<string>(
    String(pickupMaxEtaMinutes ?? 45),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [, startTx] = useTransition();

  function setWindow(day: DayCode, idx: number, patch: Partial<Window>) {
    setDraft((d) => ({
      ...d,
      [day]: d[day].map((w, i) => (i === idx ? { ...w, ...patch } : w)),
    }));
  }

  function addWindow(day: DayCode) {
    setDraft((d) => ({
      ...d,
      [day]: [...d[day], { from: "11:00", to: "22:00" }],
    }));
  }

  function removeWindow(day: DayCode, idx: number) {
    setDraft((d) => ({
      ...d,
      [day]: d[day].filter((_, i) => i !== idx),
    }));
  }

  async function save() {
    setBusy(true);
    setErr(null);
    setOk(null);
    // Hours save
    const hoursPayload: PickupHoursInput | null =
      mode === "always" ? null : draft;
    if (hoursPayload) {
      for (const day of DAY_ORDER) {
        for (const w of hoursPayload[day.key]) {
          if (w.from >= w.to) {
            setBusy(false);
            setErr(t("closeAfterOpen", { day: t(day.tKey) }));
            return;
          }
        }
      }
    }
    const hoursRes = await fetch(`/api/admin/membership/${restaurantId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "set_pickup_hours",
        hours: hoursPayload,
      }),
    });
    if (!hoursRes.ok) {
      setBusy(false);
      setErr(t("hoursSaveFailed"));
      return;
    }

    // Cap save
    const cap = capOn ? Number(capInput) : null;
    if (cap != null && (!Number.isFinite(cap) || cap < 5 || cap > 240)) {
      setBusy(false);
      setErr(t("etaCapInvalid"));
      return;
    }
    const capRes = await fetch(`/api/admin/membership/${restaurantId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "set_pickup_max_eta",
        maxEtaMinutes: cap,
      }),
    });
    setBusy(false);
    if (!capRes.ok) {
      setErr(t("etaCapPartialFail"));
      return;
    }
    setOk(t("saved"));
    startTx(() => router.refresh());
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-2">
          {t("hoursTitle")}
        </div>
        <div className="flex gap-2 mb-3">
          {(
            [
              { v: "always", label: t("hoursAlways") },
              { v: "custom", label: t("hoursCustom") },
            ] as const
          ).map((o) => (
            <button
              key={o.v}
              type="button"
              onClick={() => setMode(o.v)}
              className={
                "h-8 px-3 rounded-full text-xs border " +
                (mode === o.v
                  ? "bg-ink text-bone border-ink"
                  : "bg-op-bg border-op-border")
              }
            >
              {o.label}
            </button>
          ))}
        </div>
        {mode === "custom" && (
          <ul className="space-y-2">
            {DAY_ORDER.map((day) => (
              <li
                key={day.key}
                className="flex items-start gap-3 py-2 border-t border-op-border first:border-t-0"
              >
                <div className="w-24 shrink-0 text-sm pt-1">{t(day.tKey)}</div>
                <div className="flex-1 space-y-1.5">
                  {draft[day.key].length === 0 ? (
                    <div className="text-xs text-op-muted">{t("closed")}</div>
                  ) : (
                    draft[day.key].map((w, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <input
                          type="time"
                          value={w.from}
                          onChange={(e) =>
                            setWindow(day.key, idx, { from: e.target.value })
                          }
                          className="h-8 px-2 rounded-lg border border-op-border bg-op-bg font-mono text-xs tabular"
                        />
                        <span className="text-op-muted text-xs" aria-hidden>{"–"}</span>
                        <input
                          type="time"
                          value={w.to}
                          onChange={(e) =>
                            setWindow(day.key, idx, { to: e.target.value })
                          }
                          className="h-8 px-2 rounded-lg border border-op-border bg-op-bg font-mono text-xs tabular"
                        />
                        <button
                          type="button"
                          onClick={() => removeWindow(day.key, idx)}
                          className="h-7 w-7 rounded-full border border-op-border text-op-muted hover:text-danger hover:border-danger/40 text-xs"
                          aria-label={t("removeWindow")}
                        >
                          {"×"}
                        </button>
                      </div>
                    ))
                  )}
                  <button
                    type="button"
                    onClick={() => addWindow(day.key)}
                    className="font-mono text-[10px] tracking-wider uppercase text-terracotta hover:underline"
                  >
                    {t("addWindow")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="pt-3 border-t border-op-border">
        <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-2">
          {t("etaCapTitle")}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={capOn}
              onChange={(e) => setCapOn(e.target.checked)}
            />
            <span>{t("etaCapLabel")}</span>
          </label>
          <input
            type="number"
            value={capInput}
            onChange={(e) => setCapInput(e.target.value)}
            min={5}
            max={240}
            step={5}
            disabled={!capOn}
            className="h-9 w-24 px-2 rounded-lg border border-op-border bg-op-bg font-mono text-sm tabular disabled:opacity-50"
          />
          <span className="text-op-muted text-xs">{t("minutesAbbr")}</span>
        </div>
        <div className="text-[11px] text-op-muted mt-1">
          {t("etaCapHint")}
        </div>
      </div>

      {err && <div className="text-danger text-xs">{err}</div>}
      {ok && <div className="text-ok text-xs">{ok}</div>}
      <button
        onClick={save}
        disabled={busy}
        className="h-9 px-4 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
      >
        {busy ? t("saving") : t("saveHours")}
      </button>
    </div>
  );
}

export { fmtCOP };
