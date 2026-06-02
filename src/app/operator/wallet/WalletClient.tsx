"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { fmtCOP } from "@/lib/format";

type Movement = {
  id: string;
  kind: string;
  amountCents: number;
  balanceAfterCents: number;
  description: string;
  occurredAt: string;
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
  tenantName,
  onboarded,
  bankLabel,
  initialMovements,
  initialPolicy,
}: {
  tenantName: string;
  onboarded: boolean;
  bankLabel: string | null;
  initialMovements: Movement[];
  initialPolicy: AutoPolicy;
}) {
  const t = useTranslations("opWallet");
  const router = useRouter();
  const [, startTx] = useTransition();
  const [balance, setBalance] = useState<{
    availableCents: number;
    pendingCents: number;
  } | null>(null);
  const [balanceErr, setBalanceErr] = useState<string | null>(null);
  const [disperseOpen, setDisperseOpen] = useState(false);
  const [policy, setPolicy] = useState<AutoPolicy>(initialPolicy);
  const [savingPolicy, setSavingPolicy] = useState(false);

  useEffect(() => {
    if (!onboarded) return;
    let alive = true;
    fetch("/api/operator/wallet/balance")
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j.error) {
          setBalanceErr(j.error);
        } else {
          setBalance({
            availableCents: j.availableCents,
            pendingCents: j.pendingCents,
          });
        }
      })
      .catch(() => alive && setBalanceErr("balance_failed"));
    return () => {
      alive = false;
    };
  }, [onboarded]);

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

      <div className="rounded-2xl bg-ink text-bone p-6 mb-6">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase opacity-70 mb-1">
          {t("availableBalance")}
        </div>
        <div className="font-display text-4xl tabular">
          {balance ? fmtCOP(balance.availableCents) : t("loadingEllipsis")}
        </div>
        {balance && balance.pendingCents > 0 && (
          <div className="text-xs opacity-70 mt-1">
            {t("pending", { amount: fmtCOP(balance.pendingCents) })}
          </div>
        )}
        {balanceErr && (
          <div className="text-xs text-danger mt-2">
            {t("balanceError", { code: balanceErr })}
          </div>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setDisperseOpen(true)}
            disabled={!balance || balance.availableCents <= 0 || !bankLabel}
            className="h-10 px-5 rounded-full bg-bone text-ink text-sm font-medium disabled:opacity-50"
          >
            {t("toBank")}
          </button>
          {bankLabel && (
            <span className="font-mono text-[10px] tracking-wider uppercase opacity-70 self-center">
              {"→"} {bankLabel}
            </span>
          )}
        </div>
      </div>

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
                    {new Date(m.occurredAt).toLocaleString("es-CO")}
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
                <NumberField
                  label={t("thresholdPesos")}
                  value={policy.thresholdCents ?? 500000}
                  onChange={(v) =>
                    savePolicy({ ...policy, thresholdCents: v })
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

      {disperseOpen && balance && bankLabel && (
        <DisperseSheet
          maxCents={balance.availableCents}
          bankLabel={bankLabel}
          onClose={() => setDisperseOpen(false)}
          onSuccess={() => {
            setDisperseOpen(false);
            startTx(() => router.refresh());
          }}
        />
      )}
    </div>
  );
}

function DisperseSheet({
  maxCents,
  bankLabel,
  onClose,
  onSuccess,
}: {
  maxCents: number;
  bankLabel: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const t = useTranslations("opWallet");
  const [amount, setAmount] = useState<number>(maxCents);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    if (amount <= 0 || amount > maxCents) {
      setErr(t("invalidAmount"));
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/operator/wallet/disperse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amountCents: amount }),
    });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(j.message ?? j.error ?? t("disperseError"));
      return;
    }
    onSuccess();
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/50 flex items-end md:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-md bg-bone text-ink rounded-t-3xl md:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-hairline flex items-center justify-between">
          <div className="font-display text-xl">{t("toBank")}</div>
          <button onClick={onClose} className="text-muted text-sm">
            {t("close")}
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="font-mono text-[10px] tracking-wider uppercase text-muted">
            {t("destination", { bank: bankLabel })}
          </div>
          <NumberField
            label={t("amount")}
            value={amount}
            onChange={(v) => setAmount(Math.min(maxCents, v))}
            hint={t("max", { amount: fmtCOP(maxCents) })}
          />
          {err && <div className="text-danger text-sm">{err}</div>}
          <button
            onClick={go}
            disabled={busy || amount <= 0}
            className="w-full h-12 rounded-full bg-terracotta text-bone font-medium disabled:opacity-60"
          >
            {busy ? t("processing") : t("sendAmount", { amount: fmtCOP(amount) })}
          </button>
          <p className="text-[11px] text-muted-2 text-center">
            {t("disperseNote")}
          </p>
        </div>
      </div>
    </div>
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

function NumberField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] tracking-wider uppercase text-muted">
        {label}
      </span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10) || 0)}
        className="mt-1 w-full h-10 px-3 rounded-lg border border-hairline bg-paper"
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
