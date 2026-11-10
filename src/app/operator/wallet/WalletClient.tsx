"use client";

import { MoneyInput } from "@/components/MoneyInput";
import { WalletTrackingPanel, WalletTrackingSummary } from "@/components/WalletTrackingPanel";
import { useWalletTracking } from "@/components/walletTracking/useWalletTracking";
import { MerchantPayoutSheet, MerchantPayoutNotice } from "./MerchantPayoutSheet";
import { useMerchantPayout, type MerchantPayoutStatus, type MerchantPayoutResult } from "./useMerchantPayout";
import { WalletIncomingActivity } from "@/components/WalletIncomingActivity";
import type { WalletPendingBalance as PendingBalance } from "@/lib/payments/walletPending";
import type { Locale } from "@/i18n/config";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { fmtCOP, formatMoney, formatDate } from "@/lib/format";

type Movement = {
  id: string;
  kind: string;
  amountCents: number;
  balanceAfterCents: number;
  description: string;
  occurredAt: string;
};

type Payout = {
  id: string;
  amountCents: number;
  toOwnAccount: boolean;
  bankName: string;
  accountType: string;
  accountLast4: string;
  holderName: string;
  status: MerchantPayoutStatus;
  idempotencyKey: string | null;
  responseText: string | null;
  createdAt: string;
};

type AutoPolicy =
  | { enabled: false }
  | {
      enabled: true;
      mode: "daily" | "weekly" | "threshold";
      thresholdCents?: number;
      weekdays?: number[];
      time?: string;
    };

export function WalletClient({
  restaurantId,
  tenantName,
  onboarded,
  bankLabel,
  ownDestinationFingerprint,
  initialMovements,
  initialPayouts,
  initialPolicy,
  initialUnresolved,
}: {
  restaurantId: string;
  tenantName: string;
  onboarded: boolean;
  bankLabel: string | null;
  ownDestinationFingerprint: string | null;
  initialMovements: Movement[];
  initialPayouts: Payout[];
  initialPolicy: AutoPolicy;
  initialUnresolved: { idempotencyKey: string | null } | null;
}) {
  const t = useTranslations("opWallet");
  const tt = useTranslations("walletTracking");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [, startTx] = useTransition();
  const [balance, setBalance] = useState<({ availableCents: number; currency: string } & Partial<PendingBalance>) | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(onboarded);
  const [balanceReload, setBalanceReload] = useState(0);
  const [balanceErr, setBalanceErr] = useState<string | null>(null);
  const [disperseOpen, setDisperseOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [policy, setPolicy] = useState<AutoPolicy>(initialPolicy);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [latestPayout, setLatestPayout] = useState<MerchantPayoutResult | null>(null);
  const tracking = useWalletTracking("operator", onboarded ? restaurantId : null);
  const initialPendingKey = initialUnresolved?.idempotencyKey;
  const payout = useMerchantPayout(restaurantId, (next) => {
    setLatestPayout(next); refreshBalance(); void tracking.sync(); startTx(() => router.refresh());
  }, initialPendingKey, () => startTx(() => router.refresh()));
  const unresolvedLegacy = Boolean(initialUnresolved && !initialUnresolved.idempotencyKey);
  const visiblePayouts = initialPayouts.map((item) => latestPayout?.payoutId === item.id ? { ...item, status: latestPayout.status, responseText: latestPayout.responseText } : item);

  useEffect(() => {
    if (!onboarded) return;
    let alive = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    fetch("/api/operator/wallet/balance", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || data.error || !Number.isSafeInteger(data.availableCents) || data.availableCents < 0) throw new Error("balance_failed");
        return data;
      })
      .then((data) => {
        if (!alive) return;
        setBalanceErr(null);
        setBalance({
          availableCents: data.availableCents,
          currency: typeof data.currency === "string" && /^[A-Z]{3}$/.test(data.currency) ? data.currency : "COP",
          pendingCents: data.pendingCents,
          pendingStatus: data.pendingStatus,
          pendingUpdatedAt: data.pendingUpdatedAt,
        });
      })
      .catch(() => { if (alive) { setBalance(null); setBalanceErr("balance_failed"); } })
      .finally(() => { clearTimeout(timer); if (alive) setBalanceLoading(false); });
    return () => { alive = false; clearTimeout(timer); controller.abort(); };
  }, [onboarded, balanceReload]);

  function refreshBalance() {
    setBalanceLoading(true);
    setBalanceErr(null);
    setBalanceReload((value) => value + 1);
  }

  async function savePolicy(next: AutoPolicy) {
    setSavingPolicy(true);
    const res = await fetch("/api/operator/wallet/auto-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    });
    setSavingPolicy(false);
    if (res.ok) {
      setPolicy(next);
      startTx(() => router.refresh());
    }
  }

  if (!onboarded) {
    return (
      <div className="p-6 max-w-3xl mx-auto w-full">
        <div className="font-display text-3xl mb-1">{t("title")}</div>
        <p className="text-sm text-op-muted mb-6">{t("activateIntro")}</p>
        <div className="rounded-2xl border border-op-border bg-op-surface p-6 text-center">
          <div className="font-display text-xl">{t("notActiveTitle")}</div>
          <p className="text-sm text-op-muted mt-1 mb-4">
            {t("notActiveBody")}
          </p>
          <Link
            href="/operator/settings/pagos"
            className="inline-flex h-10 px-5 rounded-full bg-terracotta text-bone font-medium items-center"
          >
            {t("goToOnboarding")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-op-muted mb-1">
        {tenantName}
      </div>
      <div className="font-display text-3xl mb-1">{t("title")}</div>
      <p className="text-sm text-op-muted mb-6">{t("subtitle")}</p>

      <div className="rounded-2xl bg-ink text-bone p-5 sm:p-6 mb-6">
        <div className="grid items-start gap-5 sm:grid-cols-2">
          <div className="min-w-0">
            <div className="font-mono text-[10px] tracking-[0.18em] uppercase opacity-70 mb-1">{t("availableBalance")}</div>
            <div className="break-words font-display text-4xl leading-tight tabular-nums" aria-live="polite">
              {balance ? formatMoney(balance.availableCents, { currency: balance.currency, locale }) : t(balanceLoading ? "loadingEllipsis" : "balanceUnavailable")}
            </div>
            {balanceErr && <p role="alert" className="mt-3 text-xs text-amber-100">{t("balanceFailedHint")}</p>}
            <button type="button" onClick={refreshBalance} disabled={balanceLoading} className="mt-4 min-h-11 rounded-full border border-bone/30 px-4 py-2 text-xs font-medium hover:bg-bone/10 disabled:opacity-50">{t(balanceLoading ? "refreshingBalance" : "refreshBalance")}</button>
          </div>
          <WalletTrackingSummary tracking={tracking} dark />
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => { if (payout.beginNew()) setDisperseOpen(true); }}
            disabled={payout.blocked || unresolvedLegacy || balanceLoading || !balance || balance.availableCents <= 0 || !bankLabel}
            className="h-10 px-5 rounded-full bg-bone text-ink text-sm font-medium disabled:opacity-50"
          >
            {t("toBank")}
          </button>
          <button
            type="button"
            onClick={() => { if (payout.beginNew()) setTransferOpen(true); }}
            disabled={payout.blocked || unresolvedLegacy || balanceLoading || !balance || balance.availableCents <= 0}
            className="h-10 px-5 rounded-full border border-bone/30 text-bone text-sm font-medium disabled:opacity-50"
          >
            {t("toOther")}
          </button>
          {bankLabel && (
            <span className="font-mono text-[10px] tracking-wider uppercase opacity-70 self-center">
              {"→"} {bankLabel}
            </span>
          )}
        </div>
        {/* Botón deshabilitado sin explicación = botón "que no hace nada".
            Sin cuenta registrada, decimos por qué y a dónde ir. */}
        {!bankLabel && (
          <p className="mt-2 text-[11px] opacity-70">
            {t("noBankHint")}{" "}
            <Link href="/operator/settings/pagos" className="underline">
              {t("noBankHintLink")}
            </Link>
          </p>
        )}
      </div>

      {!disperseOpen && !transferOpen && <MerchantPayoutNotice payout={payout} />}
      {unresolvedLegacy && <p role="status" className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{t("payoutLegacyReview")}</p>}
      <div className="mb-8"><WalletTrackingPanel tracking={tracking} /></div>
      <details className="mb-8 rounded-2xl border border-op-border bg-op-surface p-5" onToggle={(event) => setReportOpen(event.currentTarget.open)}><summary className="cursor-pointer text-sm font-medium">{tt("optionalReport")}</summary><p className="my-3 text-sm text-op-muted">{tt("optionalReportHint")}</p>{reportOpen && <WalletIncomingActivity key={restaurantId} surface="operator" scopeId={restaurantId} />}</details>

      {initialPayouts.length > 0 && (
        <section className="mb-8">
          <div className="font-display text-xl mb-3">{t("payoutsTitle")}</div>
          <ul className="divide-y divide-op-border border-y border-op-border">
            {visiblePayouts.map((p) => (
              <li
                key={p.id}
                className="py-3 flex items-center justify-between gap-4"
              >
                <div className="min-w-0">
                  <div className="text-sm truncate">
                    {p.bankName} ·{" "}
                    <span className="font-mono tabular">
                      {"•••• "}
                      {p.accountLast4}
                    </span>
                  </div>
                  <div className="text-[11px] text-op-muted mt-0.5 truncate">
                    {p.toOwnAccount ? t("payoutToOwn") : p.holderName} ·{" "}
                    {formatDate(p.createdAt, { locale, timeZone: "America/Bogota" })}
                  </div>
                  {p.responseText &&
                    (p.status === "declined" || p.status === "failed") && (
                      <div className="text-[11px] text-danger mt-0.5 truncate">
                        {t("payoutFailedHint")}
                      </div>
                    )}
                </div>
                <div className="text-right shrink-0">
                  <div className="font-mono tabular text-sm">
                    −{fmtCOP(p.amountCents)}
                  </div>
                  <PayoutStatusChip status={p.status} t={t} />
                  {p.idempotencyKey && (p.status === "initialized" || p.status === "submitting" || p.status === "unknown") && <button type="button" disabled={payout.busy || Boolean(payout.pending && payout.pending.idempotencyKey !== p.idempotencyKey)} className="mt-2 block text-xs underline disabled:opacity-50" onClick={() => void payout.recover(p.idempotencyKey!)}>{t("payoutCheck")}</button>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mb-8">
        <div className="font-display text-xl mb-3">{t("movements")}</div>
        {initialMovements.length === 0 ? (
          <div className="text-sm text-op-muted">{t("noMovements")}</div>
        ) : (
          <ul className="divide-y divide-op-border border-y border-op-border">
            {initialMovements.map((m) => (
              <li
                key={m.id}
                className="py-3 flex items-center justify-between gap-4"
              >
                <div className="min-w-0">
                  <div className="text-sm truncate">{m.description}</div>
                  <div className="text-[11px] text-op-muted mt-0.5">
                    {humanKind(m.kind, t)} ·{" "}
                    {formatDate(m.occurredAt, { locale, timeZone: "America/Bogota" })}
                  </div>
                </div>
                <div className="text-right">
                  <div
                    className={
                      "font-mono tabular text-sm " +
                      (m.kind === "credit" ? "text-ok" : "text-op-text")
                    }
                  >
                    {m.kind === "credit" ? "+" : "−"}
                    {fmtCOP(m.amountCents)}
                  </div>
                  <div className="text-[10px] text-op-muted font-mono tabular">
                    {t("balancePrefix", { amount: fmtCOP(m.balanceAfterCents) })}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-12">
        <div className="font-display text-xl mb-3">{t("autoDisperseTitle")}</div>
        <div className="rounded-2xl border border-op-border bg-op-surface p-5 space-y-3">
          <label className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={policy.enabled}
              onChange={(e) => {
                if (!e.target.checked) {
                  savePolicy({ enabled: false });
                } else {
                  savePolicy({
                    enabled: true,
                    mode: "daily",
                    time: "22:00",
                  });
                }
              }}
              disabled={savingPolicy}
            />
            {t("autoDisperseToggle")}
          </label>
          {policy.enabled && (
            <div className="grid grid-cols-2 gap-3">
              <Select
                label={t("frequency")}
                value={policy.mode}
                options={[
                  ["daily", t("freqDaily")],
                  ["weekly", t("freqWeekly")],
                  ["threshold", t("freqThreshold")],
                ]}
                onChange={(v) =>
                  savePolicy({
                    ...policy,
                    mode: v as "daily" | "weekly" | "threshold",
                  })
                }
              />
              {policy.mode === "threshold" ? (
                <MoneyField
                  label={t("thresholdPesos")}
                  valueCents={policy.thresholdCents ?? 500000}
                  onChangeCents={(cents) =>
                    savePolicy({ ...policy, thresholdCents: cents })
                  }
                />
              ) : (
                <TextField
                  label={t("hour24")}
                  value={policy.time ?? "22:00"}
                  onChange={(v) => savePolicy({ ...policy, time: v })}
                />
              )}
            </div>
          )}
        </div>
      </section>

      {disperseOpen && bankLabel && <MerchantPayoutSheet payout={payout} currency={balance?.currency ?? "COP"} maxCents={balance?.availableCents ?? 0} bankLabel={bankLabel} ownDestinationFingerprint={ownDestinationFingerprint} onClose={() => setDisperseOpen(false)} />}
      {transferOpen && <MerchantPayoutSheet payout={payout} currency={balance?.currency ?? "COP"} maxCents={balance?.availableCents ?? 0} onClose={() => setTransferOpen(false)} />}
    </div>
  );
}

function PayoutStatusChip({
  status,
  t,
}: {
  status: Payout["status"];
  t: (key: string) => string;
}) {
  const map: Record<Payout["status"], { cls: string; key: string }> = {
    submitting: { cls: "bg-amber-100 text-amber-800", key: "payoutSubmitting" },
    unknown: { cls: "bg-amber-100 text-amber-800", key: "payoutUnknown" },
    initialized: { cls: "bg-amber-100 text-amber-800", key: "payoutInitialized" },
    approved: { cls: "bg-ok/15 text-ok", key: "payoutApproved" },
    declined: { cls: "bg-danger/15 text-danger", key: "payoutDeclined" },
    failed: { cls: "bg-op-border text-op-muted", key: "payoutFailed" },
  };
  const { cls, key } = map[status];
  return (
    <span
      className={
        "inline-block mt-0.5 px-2 py-0.5 rounded-full text-[10px] font-medium " +
        cls
      }
    >
      {t(key)}
    </span>
  );
}

function humanKind(
  k: string,
  t: (key: string) => string,
): string {
  switch (k) {
    case "credit":
      return t("kindCredit");
    case "debit":
      return t("kindDebit");
    case "fee":
      return t("kindFee");
    case "dispersion":
      return t("kindDispersion");
    case "adjustment":
      return t("kindAdjustment");
    default:
      return k;
  }
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full h-10 px-3 rounded-lg border border-op-border bg-op-surface"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Campo de monto en PESOS con separador de miles. Internamente el saldo se
 * maneja en centavos (COP no tiene decimales ⇒ pesos × 100 = centavos), pero
 * el operador escribe y ve pesos agrupados (150.000), no centavos crudos.
 */
function MoneyField({
  label,
  valueCents,
  onChangeCents,
  maxCents,
  hint,
}: {
  label: string;
  valueCents: number;
  onChangeCents: (cents: number) => void;
  maxCents?: number;
  hint?: string;
}) {
  const cap = maxCents ?? Number.MAX_SAFE_INTEGER;
  const pesos = Math.floor(valueCents / 100);
  return (
    <label className="block">
      <span className="font-mono text-[10px] tracking-wider uppercase text-muted">
        {label}
      </span>
      <MoneyInput
        value={pesos > 0 ? String(pesos) : ""}
        onChange={(raw) => {
          const digits = raw.replace(/\D/g, "").slice(0, 12);
          const p = digits === "" ? 0 : Number(digits);
          onChangeCents(Math.min(cap, p * 100));
        }}
        className="mt-1 w-full h-10 px-3 rounded-lg border border-hairline bg-paper tabular"
      />
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full h-10 px-3 rounded-lg border border-op-border bg-op-surface"
      />
    </label>
  );
}
