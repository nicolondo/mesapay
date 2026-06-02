"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type {
  ReservationConfig,
  Shift,
  Weekday,
} from "@/lib/reservations";
import type { PaymentMethodSlug } from "@/lib/paymentMethods";

// Maps a deposit method slug to its i18n key under opReservasCfg.
const DEPOSIT_METHOD_KEYS: Record<string, string> = {
  kushki_card: "methodCard",
  kushki_pse: "methodPse",
  kushki_apple_pay: "methodApplePay",
};

// Maps a weekday number to its i18n key under opReservasCfg.
const DAY_KEYS: Record<Weekday, string> = {
  0: "daySunday",
  1: "dayMonday",
  2: "dayTuesday",
  3: "dayWednesday",
  4: "dayThursday",
  5: "dayFriday",
  6: "daySaturday",
};

const WEEKDAYS: Weekday[] = [1, 2, 3, 4, 5, 6, 0]; // lun→dom para mostrar

const SLOT_OPTIONS = [60, 90, 120, 150, 180];

export function ReservasConfigClient({
  tenantSlug,
  initialEnabled,
  initialConfig,
  depositCapable,
  initialDepositMethods,
}: {
  tenantSlug: string;
  initialEnabled: boolean;
  initialConfig: ReservationConfig;
  /** Métodos online del comercio que pueden cobrar un depósito. */
  depositCapable: PaymentMethodSlug[];
  /** Selección actual (subconjunto de depositCapable). */
  initialDepositMethods: PaymentMethodSlug[];
}) {
  const t = useTranslations("opReservasCfg");
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [config, setConfig] = useState<ReservationConfig>(initialConfig);
  const [depositMethods, setDepositMethods] = useState<PaymentMethodSlug[]>(
    initialDepositMethods,
  );
  const [busy, setBusy] = useState(false);

  function toggleDepositMethod(slug: PaymentMethodSlug) {
    setDepositMethods((ms) =>
      ms.includes(slug) ? ms.filter((m) => m !== slug) : [...ms, slug],
    );
  }
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  const reserveUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/r/${tenantSlug}`
      : `/r/${tenantSlug}`;

  function updateShift(
    day: Weekday,
    idx: number,
    field: keyof Shift,
    value: string,
  ) {
    setConfig((c) => {
      const next = { ...c, shiftsByDay: { ...c.shiftsByDay } };
      const arr = [...(next.shiftsByDay[day] ?? [])];
      arr[idx] = { ...arr[idx], [field]: value };
      next.shiftsByDay[day] = arr;
      return next;
    });
  }

  function addShift(day: Weekday) {
    setConfig((c) => {
      const next = { ...c, shiftsByDay: { ...c.shiftsByDay } };
      const arr = [...(next.shiftsByDay[day] ?? [])];
      arr.push({ start: "12:00", end: "15:00" });
      next.shiftsByDay[day] = arr;
      return next;
    });
  }

  function removeShift(day: Weekday, idx: number) {
    setConfig((c) => {
      const next = { ...c, shiftsByDay: { ...c.shiftsByDay } };
      next.shiftsByDay[day] = (next.shiftsByDay[day] ?? []).filter(
        (_, i) => i !== idx,
      );
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/operator/settings/reservations", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled, config, depositMethods }),
    });
    setBusy(false);
    if (!res.ok) {
      setMsg({ kind: "error", text: t("saveError") });
      return;
    }
    setMsg({ kind: "ok", text: t("savedOk") });
    router.refresh();
  }

  // Builds a localized duration label like "1h 30min" / "45 min".
  function formatDuration(minutes: number): string {
    if (minutes >= 60) {
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      return m
        ? t("slotHoursMinutes", { hours: h, minutes: m })
        : t("slotHours", { hours: h });
    }
    return t("slotMinutes", { minutes });
  }

  return (
    <div className="space-y-6">
      {/* Toggle maestro */}
      <div className="rounded-2xl border border-op-border bg-op-surface p-5">
        <label className="flex items-center justify-between gap-4 cursor-pointer">
          <div>
            <div className="font-medium">{t("enableTitle")}</div>
            <p className="text-xs text-op-muted mt-0.5">{t("enableBody")}</p>
          </div>
          <Toggle on={enabled} onChange={setEnabled} />
        </label>

        {enabled && (
          <div className="mt-4 pt-4 border-t border-op-border">
            <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
              {t("linkHeading")}
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate text-xs bg-op-bg rounded-lg px-3 py-2 border border-op-border">
                {reserveUrl}
              </code>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(reserveUrl).catch(() => {});
                  setMsg({ kind: "ok", text: t("linkCopied") });
                }}
                className="shrink-0 h-9 px-3 rounded-full bg-ink text-bone text-xs font-medium"
              >
                {t("copy")}
              </button>
            </div>
            <p className="text-[11px] text-op-muted mt-1.5">{t("shareHint")}</p>
          </div>
        )}
      </div>

      {/* Conectar con Google Maps */}
      {enabled && (
        <div className="rounded-2xl border border-op-border bg-op-surface p-5">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-lg" aria-hidden>
              📍
            </span>
            <div className="font-display text-lg">{t("googleTitle")}</div>
          </div>
          <p className="text-xs text-op-muted mb-4">{t("googleBody")}</p>

          <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
            {t("googleLinkHeading")}
          </div>
          <div className="flex items-center gap-2 mb-4">
            <code className="flex-1 min-w-0 truncate text-xs bg-op-bg rounded-lg px-3 py-2 border border-op-border">
              {reserveUrl}
              {"?source=google"}
            </code>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard
                  ?.writeText(`${reserveUrl}?source=google`)
                  .catch(() => {});
                setMsg({ kind: "ok", text: t("googleLinkCopied") });
              }}
              className="shrink-0 h-9 px-3 rounded-full bg-ink text-bone text-xs font-medium"
            >
              {t("copy")}
            </button>
          </div>

          <div className="rounded-xl bg-op-bg border border-op-border p-4">
            <div className="text-xs font-medium mb-2">{t("googleHowTitle")}</div>
            <ol className="text-xs text-op-muted space-y-1.5 list-decimal pl-4">
              <li>
                {t("googleStep1Pre")}
                <a
                  href="https://business.google.com/"
                  target="_blank"
                  rel="noreferrer"
                  className="text-terracotta hover:underline"
                >
                  {t("googleStep1Link")}
                </a>
                {t("googleStep1Post")}
              </li>
              <li>
                {t("googleStep2Pre")}
                <strong>{t("googleStep2Strong")}</strong>
                {t("googleStep2Post")}
              </li>
              <li>
                {t("googleStep3Pre")}
                <strong>{t("googleStep3Strong")}</strong>
                {t("googleStep3Post")}
              </li>
              <li>
                {t("googleStep4Pre")}
                <strong>{t("googleStep4Strong")}</strong>
                {t("googleStep4Post")}
              </li>
              <li>{t("googleStep5")}</li>
            </ol>
            <p className="text-[11px] text-op-muted mt-3">{t("googleNote")}</p>
          </div>
        </div>
      )}

      {enabled && (
        <>
          {/* Parámetros generales */}
          <div className="rounded-2xl border border-op-border bg-op-surface p-5 space-y-4">
            <div className="font-display text-lg">{t("howTitle")}</div>

            <label className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium">{t("autoConfirmLabel")}</div>
                <p className="text-xs text-op-muted mt-0.5">
                  {t("autoConfirmBody")}
                </p>
              </div>
              <Toggle
                on={config.autoConfirm}
                onChange={(v) => setConfig((c) => ({ ...c, autoConfirm: v }))}
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium">{t("slotLabel")}</span>
              <select
                value={config.slotMinutes}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    slotMinutes: Number(e.target.value),
                  }))
                }
                className="mt-1 w-full h-11 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
              >
                {SLOT_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {formatDuration(m)}
                  </option>
                ))}
              </select>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm font-medium">{t("minNoticeLabel")}</span>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={168}
                    value={config.minNoticeHours}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        minNoticeHours: Math.max(0, Number(e.target.value)),
                      }))
                    }
                    className="w-20 h-11 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
                  />
                  <span className="text-sm text-op-muted">{t("hours")}</span>
                </div>
              </label>
              <label className="block">
                <span className="text-sm font-medium">{t("maxAdvanceLabel")}</span>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={config.maxAdvanceDays}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        maxAdvanceDays: Math.max(1, Number(e.target.value)),
                      }))
                    }
                    className="w-20 h-11 px-3 rounded-lg border border-op-border bg-op-bg text-sm"
                  />
                  <span className="text-sm text-op-muted">{t("days")}</span>
                </div>
              </label>
            </div>

            <label className="block">
              <span className="text-sm font-medium">{t("policyLabel")}</span>
              <textarea
                value={config.policyNote ?? ""}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    policyNote: e.target.value,
                  }))
                }
                rows={2}
                maxLength={500}
                placeholder={t("policyPlaceholder")}
                className="mt-1 w-full px-3 py-2 rounded-lg border border-op-border bg-op-bg text-sm"
              />
            </label>
          </div>

          {/* Depósito para reservar */}
          <div className="rounded-2xl border border-op-border bg-op-surface p-5">
            <div className="font-display text-lg mb-1">{t("depositTitle")}</div>
            <p className="text-xs text-op-muted mb-4">
              {t("depositBodyPre")}
              <strong>{t("depositBodyStrong")}</strong>
              {t("depositBodyMid")}
              <Link
                href="/operator/settings/mesas"
                className="text-terracotta hover:underline"
              >
                {t("depositBodyLink")}
              </Link>
              {t("depositBodyPost")}
            </p>

            {depositCapable.length === 0 ? (
              <div className="rounded-xl border border-op-border bg-op-bg p-4 text-xs text-op-muted">
                {t("depositNoMethodsPre")}
                <Link
                  href="/operator/settings/pagos"
                  className="text-terracotta hover:underline"
                >
                  {t("depositNoMethodsLink")}
                </Link>
                {t("depositNoMethodsPost")}
              </div>
            ) : (
              <div className="space-y-2">
                {depositCapable.map((slug) => (
                  <label
                    key={slug}
                    className="flex items-center justify-between gap-4 rounded-xl border border-op-border bg-op-bg px-4 py-3 cursor-pointer"
                  >
                    <span className="text-sm font-medium">
                      {DEPOSIT_METHOD_KEYS[slug] ? t(DEPOSIT_METHOD_KEYS[slug]) : slug}
                    </span>
                    <Toggle
                      on={depositMethods.includes(slug)}
                      onChange={() => toggleDepositMethod(slug)}
                    />
                  </label>
                ))}
                {depositMethods.length === 0 && (
                  <p className="text-[11px] text-[#8F6828]">
                    {t("depositNoneSelected")}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Turnos por día */}
          <div className="rounded-2xl border border-op-border bg-op-surface p-5">
            <div className="font-display text-lg mb-1">{t("shiftsTitle")}</div>
            <p className="text-xs text-op-muted mb-4">
              {t("shiftsBodyPre")}
              {formatDuration(config.slotMinutes)}
              {t("shiftsBodyPost")}
            </p>
            <div className="space-y-3">
              {WEEKDAYS.map((day) => {
                const shifts = config.shiftsByDay[day] ?? [];
                return (
                  <div
                    key={day}
                    className="flex items-start gap-3 py-2 border-b border-op-border last:border-0"
                  >
                    <div className="w-24 shrink-0 text-sm font-medium pt-2">
                      {t(DAY_KEYS[day])}
                    </div>
                    <div className="flex-1 space-y-2">
                      {shifts.length === 0 && (
                        <div className="text-xs text-op-muted pt-2">
                          {t("closed")}
                        </div>
                      )}
                      {shifts.map((s, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <input
                            type="time"
                            value={s.start}
                            onChange={(e) =>
                              updateShift(day, idx, "start", e.target.value)
                            }
                            className="h-9 px-2 rounded-lg border border-op-border bg-op-bg text-sm"
                          />
                          <span className="text-op-muted text-sm">
                            {t("shiftSeparator")}
                          </span>
                          <input
                            type="time"
                            value={s.end}
                            onChange={(e) =>
                              updateShift(day, idx, "end", e.target.value)
                            }
                            className="h-9 px-2 rounded-lg border border-op-border bg-op-bg text-sm"
                          />
                          <button
                            type="button"
                            onClick={() => removeShift(day, idx)}
                            className="text-danger text-xs hover:underline ml-1"
                          >
                            {t("removeShift")}
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => addShift(day)}
                        className="text-xs text-terracotta hover:underline"
                      >
                        {t("addShift")}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="h-11 px-6 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-50"
        >
          {busy ? t("savingChanges") : t("saveChanges")}
        </button>
        {msg && (
          <span
            className={
              "text-sm " + (msg.kind === "ok" ? "text-ok" : "text-danger")
            }
          >
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}

function Toggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={
        "shrink-0 w-12 h-7 rounded-full transition-colors relative " +
        (on ? "bg-ok" : "bg-op-border")
      }
    >
      <span
        className={
          "absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-all " +
          (on ? "left-[1.375rem]" : "left-0.5")
        }
      />
    </button>
  );
}
